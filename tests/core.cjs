const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  sizeTrade,
  splitQuantity,
  DEFAULT_COSTS,
} = require("../.test-build/lib/risk.js");
const {
  simulate,
  wilson,
  buildRecords,
  snapshot,
  nearest,
} = require("../.test-build/lib/history.js");
const { runEngine } = require("../.test-build/lib/signalEngine.js");
const { signedPayload } = require("../.test-build/lib/exchange.js");
const { executeTrade } = require("../.test-build/lib/execution.js");
const p = {
  direction: "LONG",
  entry: 100,
  stopLoss: 98,
  tp1: 102,
  tp2: 104,
  tp3: 106,
};
const rules = {
  qtyStep: 0.001,
  tickSize: 0.01,
  minQty: 0.001,
  minNotional: 0.01,
  maxQty: 10000,
  maxLeverage: 20,
};
const zero = { feeRate: 0, slippageRate: 0, fundingRate: 0 };
test("risk-based size is invariant to leverage unless margin caps it", () => {
  const a = sizeTrade(p, 5000, 1, 3, 5000, DEFAULT_COSTS, rules),
    b = sizeTrade(p, 5000, 1, 5, 5000, DEFAULT_COSTS, rules);
  assert.equal(a.qty, b.qty);
  assert.ok(a.plannedLoss <= 50);
  assert.ok(a.margin > b.margin);
  assert.equal(sizeTrade(p, 5000, 1, 3, 5000, zero).qty, 25);
  assert.ok(sizeTrade(p, 5000, 1, 1, 10, zero).qty < 1);
});
test("invalid levels, neutral direction, and instrument minima fail closed", () => {
  for (const bad of [
    { stopLoss: 100 },
    { direction: "NEUTRAL" },
    { entry: NaN },
    { tp2: 101 },
  ])
    assert.throws(() => sizeTrade({ ...p, ...bad }, 5000, 1, 3));
  assert.throws(() => sizeTrade(p, 1, 1, 3, 1, zero, { ...rules, minQty: 1 }));
  assert.throws(() => splitQuantity(0.003, rules, [102, 104, 106]));
  const q = splitQuantity(1.003, rules, [102, 104, 106]);
  assert.ok(Math.abs(q.reduce((a, b) => a + b) - 1.003) < 1e-10);
});
test("same-candle stop wins; gaps worsen loss; staged fees are fraction weighted", () => {
  const c = { time: 1, open: 100, high: 107, low: 97, close: 106, volume: 1 };
  const ambiguous = simulate(p, [c]);
  assert.deepEqual(ambiguous.hits, [false, false, false]);
  assert.equal(ambiguous.stopHit, true);
  assert.ok(ambiguous.netR < -1);
  assert.ok(simulate(p, [{ ...c, open: 95 }]).netR < -2);
  const all = simulate(p, [{ ...c, low: 99 }]);
  assert.deepEqual(all.hits, [true, true, true]);
  assert.equal(all.timeout, false);
  assert.ok(
    Math.abs(
      all.fees -
        (100 + 102 * 0.5 + 104 * 0.25 + 106 * 0.25) * DEFAULT_COSTS.feeRate,
    ) < 1e-10,
  );
  const timed = simulate(p, [{ ...c, high: 101, low: 99, close: 100 }]);
  assert.equal(timed.timeout, true);
  assert.ok(timed.netR < 0);
});
function candles(n) {
  return Array.from({ length: n }, (_, i) => {
    const v = 100 + Math.sin(i / 10) * 5 + i * 0.005;
    return {
      time: 1700000000000 + i * 3600000,
      open: v,
      close: v + 0.1,
      high: v + 1,
      low: v - 1,
      volume: 100 + (i % 7),
    };
  });
}
test("historical snapshots and completed records are invariant to appended future candles", () => {
  const a = candles(600),
    b = candles(700);
  for (let i = 600; i < b.length; i++)
    b[i] = { ...b[i], high: 200, close: 180 };
  const r = buildRecords("ETHUSDT", "INTRADAY", a),
    extended = buildRecords("ETHUSDT", "INTRADAY", b);
  assert.ok(r.length > 0);
  for (const x of r)
    assert.deepEqual(
      x,
      extended.find(
        (y) => y.timestamp === x.timestamp && y.direction === x.direction,
      ),
    );
  const feature = snapshot(a.slice(0, 200), "INTRADAY", "LONG");
  assert.deepEqual(nearest(r, feature, 1), []);
  const lows = r.filter((x) => x.direction === "LONG");
  for (let i = 1; i < lows.length; i++)
    assert.ok(lows[i].timestamp >= lows[i - 1].endTime);
});
test("Wilson interval and insufficient sample keep NO TRADE", () => {
  const interval = wilson(50, 74);
  assert.ok(interval[0] > 55 && interval[1] < 79);
  assert.equal(wilson(0, 0), null);
  const r = runEngine("ETHUSDT", 100, candles(200), [], {
    capital: 5000,
    riskPct: 1,
    leverage: 3,
    style: "INTRADAY",
  });
  assert.equal(r.direction, "NEUTRAL");
  assert.equal(r.action, "NO TRADE");
  assert.doesNotMatch(r.verdict, /confidence/i);
});
test("GET and POST signatures use the exact transmitted representation", () => {
  assert.equal(
    signedPayload("GET", { accountType: "UNIFIED" }),
    "accountType=UNIFIED",
  );
  assert.equal(
    signedPayload("POST", { reduceOnly: true, qty: "1" }),
    '"bad"'.replace('"bad"', '{"reduceOnly":true,"qty":"1"}'),
  );
});
function exchangeMock({ failTP = false, failClose = false } = {}) {
  let pos = null;
  const orders = new Map(),
    calls = [];
  async function request(method, path, params = {}) {
    calls.push({ method, path, params });
    if (path.includes("wallet-balance"))
      return {
        result: {
          list: [{ totalEquity: "5000", totalAvailableBalance: "5000" }],
        },
      };
    if (path === "/v5/position/list")
      return { result: { list: pos ? [pos] : [] } };
    if (path === "/v5/order/realtime")
      return {
        result: {
          list: params.orderLinkId
            ? orders.has(params.orderLinkId)
              ? [orders.get(params.orderLinkId)]
              : []
            : [...orders.values()].filter((o) => o.orderStatus === "New"),
        },
      };
    if (path === "/v5/order/create") {
      if (params.reduceOnly && params.orderType === "Market") {
        if (failClose) throw new Error("close failed");
        pos = null;
        return { result: { orderId: "close" } };
      }
      if (params.reduceOnly) {
        if (failTP && params.orderLinkId.endsWith("tp2"))
          throw new Error("TP2 failed");
        orders.set(params.orderLinkId, { ...params, orderStatus: "New" });
        return { result: { orderId: params.orderLinkId } };
      }
      pos = {
        size: params.qty,
        avgPrice: "100",
        side: "Buy",
        positionIdx: "0",
        stopLoss: "0",
        liqPrice: "50",
      };
      orders.set(params.orderLinkId, { ...params, orderStatus: "Filled" });
      return { result: { orderId: "entry" } };
    }
    if (path === "/v5/position/trading-stop") {
      pos.stopLoss = params.stopLoss;
      return { result: {} };
    }
    if (path === "/v5/order/cancel") {
      const o = orders.get(params.orderLinkId);
      if (o && o.orderStatus === "New") o.orderStatus = "Cancelled";
      return { result: {} };
    }
    return { result: {} };
  }
  return { request, calls };
}
const executionInput = {
  ...p,
  symbol: "ETHUSDT",
  riskPct: 1,
  leverage: 3,
  orderType: "Market",
  requestId: "test-12345678",
};
test("execution confirms stop and every staged TP, with no full TP1 attached", async () => {
  const m = exchangeMock();
  const r = await executeTrade(
    executionInput,
    rules,
    DEFAULT_COSTS,
    m.request,
    async () => {},
  );
  assert.equal(r.status, "PROTECTED");
  const entry = m.calls.find(
    (c) => c.path === "/v5/order/create" && !c.params.reduceOnly,
  );
  assert.equal(entry.params.takeProfit, undefined);
  assert.equal(entry.params.timeInForce, "IOC");
  const exits = m.calls.filter(
    (c) => c.path === "/v5/order/create" && c.params.reduceOnly,
  );
  assert.equal(exits.length, 3);
  assert.ok(
    Math.abs(exits.reduce((s, c) => s + Number(c.params.qty), 0) - r.qty) <
      1e-8,
  );
});
test("TP failure closes and verifies flat; failed close reports attention", async () => {
  for (const failClose of [false, true]) {
    const m = exchangeMock({ failTP: true, failClose });
    const r = await executeTrade(
      executionInput,
      rules,
      DEFAULT_COSTS,
      m.request,
      async () => {},
    );
    assert.equal(r.success, false);
    assert.equal(
      r.status,
      failClose ? "REQUIRES_ATTENTION" : "CLOSED_AFTER_FAILURE",
    );
  }
});

test("each symbol and style uses only its own historical records", () => {
  const c = candles(600),
    records = buildRecords("ETHUSDT", "INTRADAY", c);
  const prefs = { capital: 5000, riskPct: 1, leverage: 3, style: "INTRADAY" };
  const foreign = runEngine("SOLUSDT", 100, c, records, prefs);
  assert.equal(foreign.history.all.n, 0);
  const otherStyle = runEngine("ETHUSDT", 100, c, records, {
    ...prefs,
    style: "SCALP",
  });
  assert.equal(otherStyle.history.all.n, 0);
  const same = runEngine("ETHUSDT", 100, c, records, prefs);
  assert.ok(same.history.all.n > 0);
});
