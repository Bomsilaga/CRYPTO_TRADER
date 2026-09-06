/** Shared linear-USDT trade economics. Rates are fractions, never percentages. */
export const DEFAULT_COSTS = {
  feeRate: 0.00055,
  slippageRate: 0.0005,
  fundingRate: 0,
};
export type Costs = typeof DEFAULT_COSTS;
export interface Levels {
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
}
export interface Rules {
  qtyStep: number;
  tickSize: number;
  minQty: number;
  minNotional: number;
  maxQty: number;
  maxLeverage: number;
}
export function positive(n: number, label: string) {
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${label}`);
}
export function roundStep(
  n: number,
  step: number,
  mode: "floor" | "ceil" | "round" = "floor",
) {
  positive(step, "step");
  return Number(
    (Math[mode](n / step + (mode === "floor" ? 1e-10 : 0)) * step).toPrecision(
      14,
    ),
  );
}
export function validateLevels(p: Levels) {
  for (const k of ["entry", "stopLoss", "tp1", "tp2", "tp3"] as const)
    positive(p[k], k);
  if (!["LONG", "SHORT"].includes(p.direction))
    throw new Error("NO TRADE: direction must be LONG or SHORT");
  const d = p.direction === "LONG" ? 1 : -1;
  if (
    d * (p.entry - p.stopLoss) <= 0 ||
    d * (p.tp1 - p.entry) <= 0 ||
    d * (p.tp2 - p.tp1) <= 0 ||
    d * (p.tp3 - p.tp2) <= 0
  )
    throw new Error("Invalid directional stop/target ordering");
}
export function exitEconomics(
  p: Levels,
  qty: number,
  exit: number,
  costs: Costs,
) {
  const gross = qty * (exit - p.entry) * (p.direction === "LONG" ? 1 : -1);
  const fees = qty * (p.entry + exit) * costs.feeRate;
  const slippage = qty * (p.entry + exit) * costs.slippageRate;
  const funding = qty * p.entry * costs.fundingRate;
  return {
    gross,
    fees,
    slippage,
    funding,
    net: gross - fees - slippage - funding,
  };
}
export function sizeTrade(
  p: Levels,
  capital: number,
  riskPct: number,
  leverage: number,
  availableMargin = capital,
  costs: Costs = DEFAULT_COSTS,
  rules?: Rules,
) {
  validateLevels(p);
  positive(capital, "capital");
  positive(riskPct, "risk percentage");
  positive(leverage, "leverage");
  positive(availableMargin, "available margin");
  if (riskPct > 100 || leverage < 1 || (rules && leverage > rules.maxLeverage))
    throw new Error("Risk or leverage exceeds allowed range");
  if (
    Object.values(costs).some((v) => !Number.isFinite(v)) ||
    costs.feeRate < 0 ||
    costs.slippageRate < 0
  )
    throw new Error("Invalid cost rates");
  const riskBudget = (capital * riskPct) / 100;
  // Do not use anticipated funding credits to enlarge the position.
  const unitLoss = -exitEconomics(p, 1, p.stopLoss, {
    ...costs,
    fundingRate: Math.max(0, costs.fundingRate),
  }).net;
  const marginPerUnit =
    p.entry / leverage + p.entry * (costs.feeRate + costs.slippageRate);
  let qty = Math.min(
    riskBudget / unitLoss,
    availableMargin / marginPerUnit,
    rules?.maxQty ?? Infinity,
  );
  if (rules) qty = roundStep(qty, rules.qtyStep);
  positive(qty, "quantity");
  if (rules && (qty < rules.minQty || qty * p.entry < rules.minNotional))
    throw new Error(
      "Risk budget is below instrument minimum; quantity will not be rounded up",
    );
  const stop = exitEconomics(p, qty, p.stopLoss, {
    ...costs,
    fundingRate: Math.max(0, costs.fundingRate),
  });
  const targets = [p.tp1, p.tp2, p.tp3].map((t) =>
    exitEconomics(p, qty, t, costs),
  );
  const stagedNet = targets.reduce(
    (s, t, i) => s + t.net * [0.5, 0.25, 0.25][i],
    0,
  );
  return {
    capital,
    riskPct,
    riskBudget,
    qty,
    notional: qty * p.entry,
    margin: (qty * p.entry) / leverage,
    margin3x: (qty * p.entry) / 3,
    margin5x: (qty * p.entry) / 5,
    plannedLoss: -stop.net,
    stopDistancePct: (Math.abs(p.entry - p.stopLoss) / p.entry) * 100,
    stop,
    targets,
    stagedNet,
    costs,
    liquidationPrice: null,
    liquidationNote:
      "Available only from the exchange for the actual position and margin mode.",
  };
}
export function splitQuantity(qty: number, rules: Rules, prices: number[]) {
  const a = roundStep(qty * 0.5, rules.qtyStep),
    b = roundStep(qty * 0.25, rules.qtyStep);
  const parts = [a, b, roundStep(qty - a - b, rules.qtyStep, "round")];
  if (
    parts.some((q, i) => q < rules.minQty || q * prices[i] < rules.minNotional)
  )
    throw new Error("Position too small for three valid staged exits");
  return parts;
}
