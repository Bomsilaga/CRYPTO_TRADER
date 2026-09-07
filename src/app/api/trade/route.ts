import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { executeTrade, type ExecutionInput } from "@/lib/execution";
import { privateRequest } from "@/lib/exchange";
import { fetchInstrument, fetchFundingRate } from "@/lib/bybit";
import { DEFAULT_COSTS, sizeTrade, validateLevels } from "@/lib/risk";
import { claimTrade, journal } from "@/lib/store";
export async function POST(req: NextRequest) {
  const live = process.env.TRADING_MODE === "live";
  try {
    if (live) {
      const expected = process.env.TRADE_API_TOKEN ?? "",
        received =
          req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (
        !expected ||
        expected.length !== received.length ||
        !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))
      )
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const body = await req.json();
    if (!/^[A-Z0-9]{2,25}USDT$/.test(body.symbol))
      throw new Error("Invalid USDT symbol");
    validateLevels(body);
    const input: ExecutionInput = {
      ...body,
      leverage: body.userLeverage ?? body.leverage,
      orderType: body.orderType ?? "Market",
    };
    if (!["Market", "Limit"].includes(input.orderType))
      throw new Error("Invalid order type");
    const maxRisk = Number(process.env.MAX_RISK_PCT ?? 1);
    if (
      !Number.isFinite(maxRisk) ||
      !Number.isFinite(input.riskPct) ||
      input.riskPct > maxRisk
    )
      throw new Error(`Risk exceeds server limit (${maxRisk}%)`);
    const rules = await fetchInstrument(input.symbol);
    const funding = await fetchFundingRate(input.symbol);
    if (
      (input.direction === "LONG" && funding > 0.001) ||
      (input.direction === "SHORT" && funding < -0.001)
    )
      throw new Error("Funding risk threshold exceeded");
    const costs = {
      ...DEFAULT_COSTS,
      fundingRate: Math.max(0, funding * (input.direction === "LONG" ? 1 : -1)),
    };
    if (!live) {
      const capital = Number(body.capital ?? 5000);
      const plan = sizeTrade(
        input,
        capital,
        input.riskPct,
        input.leverage,
        capital,
        costs,
        rules,
      );
      await journal("paper", { input, plan, status: "PREVIEW_NOT_A_FILL" });
      return NextResponse.json({
        paper: true,
        status: "PREVIEW_NOT_A_FILL",
        plan,
        message: "Paper preview; no exchange order placed",
      });
    }
    if (!/^[A-Za-z0-9_-]{8,30}$/.test(input.requestId ?? ""))
      throw new Error("Provide a unique requestId (8–30 characters)");
    await claimTrade(input.symbol, input.requestId);
    await journal("execution", { input, status: "STARTED" });
    const result = await executeTrade(input, rules, costs, privateRequest);
    await journal("execution", { input, result });
    return NextResponse.json(result, { status: result.success ? 200 : 409 });
  } catch (e) {
    return NextResponse.json(
      {
        success: false,
        error: String(e),
        ...(live
          ? {
              message:
                "Reconcile exchange state before retrying an attempted entry.",
            }
          : {}),
      },
      { status: 400 },
    );
  }
}
