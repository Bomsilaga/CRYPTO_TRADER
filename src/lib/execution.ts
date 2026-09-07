import {
  sizeTrade,
  splitQuantity,
  roundStep,
  validateLevels,
  type Levels,
  type Costs,
  type Rules,
} from "./risk";
import type { Params, ExchangeResult } from "./exchange";
export type RequestExchange = (
  method: "GET" | "POST",
  path: string,
  params?: Params,
) => Promise<ExchangeResult>;
export interface ExecutionInput extends Levels {
  symbol: string;
  leverage: number;
  riskPct: number;
  orderType: "Market" | "Limit";
  requestId: string;
}
const pause = () => new Promise((r) => setTimeout(r, 350));
export async function executeTrade(
  input: ExecutionInput,
  rules: Rules,
  costs: Costs,
  request: RequestExchange,
  wait = pause,
) {
  const p = {
    ...input,
    entry: roundStep(input.entry, rules.tickSize, "round"),
    stopLoss: roundStep(
      input.stopLoss,
      rules.tickSize,
      input.direction === "LONG" ? "floor" : "ceil",
    ),
    tp1: roundStep(input.tp1, rules.tickSize, "round"),
    tp2: roundStep(input.tp2, rules.tickSize, "round"),
    tp3: roundStep(input.tp3, rules.tickSize, "round"),
  };
  validateLevels(p);
  const common = { category: "linear", symbol: p.symbol };
  const positions = async () =>
    (await request("GET", "/v5/position/list", common)).result.list ?? [];
  const position = async () =>
    (await positions()).find((x) => Number(x.size) > 0);
  const existingOrders = await request("GET", "/v5/order/realtime", {
    ...common,
    openOnly: 0,
    limit: 50,
  });
  if (existingOrders.result.list?.length || (await position()))
    throw new Error("Existing orders or position: use a separate flat symbol");
  const wallet = await request("GET", "/v5/account/wallet-balance", {
    accountType: "UNIFIED",
  });
  const account = wallet.result.list?.[0];
  const capital = Number(account?.totalEquity),
    available = Number(account?.totalAvailableBalance);
  // Account-wide values are unavailable in isolated UTA mode. Fail closed instead of guessing USDT withdrawability.
  const plan = sizeTrade(
    p,
    capital,
    p.riskPct,
    p.leverage,
    available,
    costs,
    rules,
  );
  splitQuantity(plan.qty, rules, [p.tp1, p.tp2, p.tp3]);
  await request("POST", "/v5/position/set-leverage", {
    ...common,
    buyLeverage: String(p.leverage),
    sellLeverage: String(p.leverage),
  });
  const side = p.direction === "LONG" ? "Buy" : "Sell",
    closeSide = side === "Buy" ? "Sell" : "Buy";
  const entryLink = p.requestId;
  const exitLinks = [1, 2, 3].map((i) => `${p.requestId.slice(0, 30)}-tp${i}`);
  let entryAttempted = false;
  try {
    entryAttempted = true;
    const placed = await request("POST", "/v5/order/create", {
      ...common,
      side,
      orderType: p.orderType,
      qty: String(plan.qty),
      orderLinkId: entryLink,
      positionIdx: 0,
      ...(p.orderType === "Limit" ? { price: String(p.entry) } : {}),
      timeInForce: "IOC",
      stopLoss: String(p.stopLoss),
      tpslMode: "Full",
      slTriggerBy: "LastPrice",
    });
    let filled = false;
    for (let i = 0; i < 8; i++) {
      const order = (
        await request("GET", "/v5/order/realtime", {
          ...common,
          orderLinkId: entryLink,
        })
      ).result.list?.[0];
      if (
        order &&
        ["Filled", "Cancelled", "Rejected", "PartiallyFilledCanceled"].includes(
          order.orderStatus,
        )
      ) {
        filled = true;
        break;
      }
      await wait();
    }
    if (!filled) throw new Error("Entry final status is unconfirmed");
    let pos = await position();
    if (!pos)
      return {
        success: false,
        status: "NO_POSITION",
        orderId: placed.result.orderId,
        message:
          "IOC order has no open position; inspect fills for any immediate exit.",
      };
    if (pos.side !== side || Number(pos.positionIdx) !== 0)
      throw new Error("Unexpected position side or mode");
    const qty = Number(pos.size),
      actualEntry = Number(pos.avgPrice);
    const actualPlan = sizeTrade(
      { ...p, entry: actualEntry },
      capital,
      p.riskPct,
      p.leverage,
      available,
      costs,
      rules,
    );
    if (qty > actualPlan.qty + rules.qtyStep * 1e-6)
      throw new Error("Actual fill exceeds planned risk or margin");
    await request("POST", "/v5/position/trading-stop", {
      ...common,
      positionIdx: 0,
      tpslMode: "Full",
      stopLoss: String(p.stopLoss),
      slTriggerBy: "LastPrice",
    });
    let protectedPosition = false;
    for (let i = 0; i < 8; i++) {
      pos = await position();
      if (!pos) throw new Error("Position exited during protection setup");
      if (Math.abs(Number(pos.stopLoss) - p.stopLoss) < rules.tickSize / 2) {
        protectedPosition = true;
        break;
      }
      await wait();
    }
    if (!protectedPosition)
      throw new Error("Exchange position does not confirm the stop");
    const liquidation = Number(pos?.liqPrice);
    if (
      liquidation > 0 &&
      (side === "Buy" ? liquidation >= p.stopLoss : liquidation <= p.stopLoss)
    )
      throw new Error("Liquidation can precede stop loss");
    const quantities = splitQuantity(qty, rules, [p.tp1, p.tp2, p.tp3]);
    const targets = [p.tp1, p.tp2, p.tp3];
    for (let i = 0; i < 3; i++) {
      await request("POST", "/v5/order/create", {
        ...common,
        side: closeSide,
        orderType: "Limit",
        qty: String(quantities[i]),
        price: String(targets[i]),
        reduceOnly: true,
        timeInForce: "GTC",
        positionIdx: 0,
        orderLinkId: exitLinks[i],
      });
      let confirmed = false;
      for (let j = 0; j < 8; j++) {
        const tp = (
          await request("GET", "/v5/order/realtime", {
            ...common,
            orderLinkId: exitLinks[i],
          })
        ).result.list?.[0];
        if (
          tp &&
          ["New", "PartiallyFilled", "Filled"].includes(tp.orderStatus) &&
          String(tp.reduceOnly) === "true" &&
          Math.abs(Number(tp.qty) - quantities[i]) < rules.qtyStep / 2 &&
          Math.abs(Number(tp.price) - targets[i]) < rules.tickSize / 2
        ) {
          confirmed = true;
          break;
        }
        await wait();
      }
      if (!confirmed) throw new Error(`TP${i + 1} was not confirmed`);
    }
    return {
      success: true,
      status: "PROTECTED",
      orderId: placed.result.orderId,
      qty,
      actualEntry,
      stopLoss: p.stopLoss,
      targets,
      quantities,
      plan,
      liquidationPrice: liquidation || null,
      liquidationDistancePct:
        liquidation > 0
          ? (Math.abs(actualEntry - liquidation) / actualEntry) * 100
          : null,
    };
  } catch (error) {
    const recoveryErrors: string[] = [];
    // A timeout may hide an accepted order. Cancel by deterministic ID before flattening.
    if (entryAttempted) {
      try {
        await request("POST", "/v5/order/cancel", {
          ...common,
          orderLinkId: entryLink,
        });
      } catch {
        /* may already be terminal; verify below */
      }
      for (const link of exitLinks) {
        try {
          await request("POST", "/v5/order/cancel", {
            ...common,
            orderLinkId: link,
          });
        } catch {
          /* verify remaining orders below */
        }
      }
      try {
        const pos = await position();
        if (pos)
          await request("POST", "/v5/order/create", {
            ...common,
            side: pos.side === "Buy" ? "Sell" : "Buy",
            orderType: "Market",
            qty: pos.size,
            reduceOnly: true,
            positionIdx: Number(pos.positionIdx),
            timeInForce: "IOC",
          });
        let flat = false;
        for (let i = 0; i < 8; i++) {
          const orders =
            (
              await request("GET", "/v5/order/realtime", {
                ...common,
                openOnly: 0,
              })
            ).result.list ?? [];
          const entry = (
            await request("GET", "/v5/order/realtime", {
              ...common,
              orderLinkId: entryLink,
            })
          ).result.list?.[0];
          const terminal =
            entry &&
            [
              "Filled",
              "Cancelled",
              "Rejected",
              "PartiallyFilledCanceled",
            ].includes(entry.orderStatus);
          if (
            terminal &&
            !(await position()) &&
            !orders.some((o) =>
              [entryLink, ...exitLinks].includes(o.orderLinkId),
            )
          ) {
            flat = true;
            break;
          }
          await wait();
        }
        if (!flat)
          recoveryErrors.push(
            "Flat state and terminal entry could not be confirmed",
          );
      } catch (e) {
        recoveryErrors.push(String(e));
      }
    }
    return {
      success: false,
      status: recoveryErrors.length
        ? "REQUIRES_ATTENTION"
        : "CLOSED_AFTER_FAILURE",
      error: String(error),
      recoveryErrors,
      requestId: p.requestId,
    };
  }
}
