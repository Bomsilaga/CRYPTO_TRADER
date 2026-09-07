/**
 * risk/limits.ts — HARD server-side risk limits. Not advisory. Not overridable
 * by the client, by `force`, or by the AI. `force` only bypasses SOFT checks
 * (funding-rate warning). Everything here is a hard rejection.
 */
export type Env = Record<string, string | undefined>;

export interface RiskLimits {
  maxRiskPctPerTrade: number;     // 1
  maxOpenRiskPct: number;         // 3  (sum of open-position risk at stop)
  maxDailyLossPct: number;        // 3  (realised)
  maxTradesPerDay: number;        // 5
  maxConcurrentPositions: number; // 2
  maxLeverage: number;            // 5
  maxNotionalPctOfEquity: number; // 300
  minStopToLiqBufferPct: number;  // 50 → liquidation distance must be ≥ 1.5× stop distance
  maxCorrelatedPositions: number; // 1 per correlation group (BTC/ETH majors vs alts) — best effort
}

export const DEFAULT_LIMITS: RiskLimits = {
  maxRiskPctPerTrade: 1,
  maxOpenRiskPct: 3,
  maxDailyLossPct: 3,
  maxTradesPerDay: 5,
  maxConcurrentPositions: 2,
  maxLeverage: 5,
  maxNotionalPctOfEquity: 300,
  minStopToLiqBufferPct: 50,
  maxCorrelatedPositions: 2,
};

export function loadLimits(env: Env = process.env): RiskLimits {
  try {
    const o = env.RISK_LIMITS ? JSON.parse(env.RISK_LIMITS) as Partial<RiskLimits> : {};
    const merged = { ...DEFAULT_LIMITS, ...o };
    // never allow env to loosen beyond sane ceilings
    merged.maxRiskPctPerTrade = Math.min(merged.maxRiskPctPerTrade, 2);
    merged.maxLeverage = Math.min(merged.maxLeverage, 10);
    merged.maxDailyLossPct = Math.min(merged.maxDailyLossPct, 5);
    return merged;
  } catch { return DEFAULT_LIMITS; }
}

export interface LimitContext {
  equity: number;
  riskPct: number;
  riskUsd: number;
  leverage: number;
  notional: number;
  openPositions: number;
  openRiskUsd: number;
  dailyRealizedPnlUsd: number;   // negative when losing
  tradesToday: number;
  stopDistancePct: number;       // fraction
  liqDistancePct: number;        // fraction (from exchange or estimate)
  symbol: string;
  openSymbols: string[];
}

export interface LimitResult { ok: boolean; rejections: string[]; warnings: string[] }

const CORR_GROUPS: Record<string, string[]> = {
  majors: ['BTCUSDT', 'ETHUSDT'],
  sol: ['SOLUSDT', 'JUPUSDT', 'PYTHUSDT', 'JTOUSDT', 'WIFUSDT', '1000BONKUSDT'],
  l2: ['ARBUSDT', 'OPUSDT', 'STRKUSDT', 'POLUSDT', 'MNTUSDT'],
  memes: ['DOGEUSDT', '1000PEPEUSDT', '1000FLOKIUSDT', '1000BONKUSDT', 'WIFUSDT'],
};
export function correlationGroup(symbol: string): string | null {
  for (const [g, syms] of Object.entries(CORR_GROUPS)) if (syms.includes(symbol)) return g;
  return null;
}

export function checkHardLimits(ctx: LimitContext, limits: RiskLimits = DEFAULT_LIMITS): LimitResult {
  const rej: string[] = [], warn: string[] = [];
  const pct = (x: number) => (ctx.equity > 0 ? (x / ctx.equity) * 100 : Infinity);
  if (ctx.riskPct > limits.maxRiskPctPerTrade + 1e-9) rej.push(`Risk ${ctx.riskPct}% exceeds max ${limits.maxRiskPctPerTrade}% per trade.`);
  if (pct(ctx.riskUsd) > limits.maxRiskPctPerTrade + 1e-6) rej.push(`Dollar risk $${ctx.riskUsd.toFixed(2)} is ${pct(ctx.riskUsd).toFixed(2)}% of equity, above ${limits.maxRiskPctPerTrade}%.`);
  if (ctx.leverage > limits.maxLeverage) rej.push(`Leverage ${ctx.leverage}× exceeds max ${limits.maxLeverage}×.`);
  if (pct(ctx.notional) > limits.maxNotionalPctOfEquity) rej.push(`Notional $${ctx.notional.toFixed(0)} is ${pct(ctx.notional).toFixed(0)}% of equity, above ${limits.maxNotionalPctOfEquity}%.`);
  if (ctx.openPositions >= limits.maxConcurrentPositions) rej.push(`${ctx.openPositions} positions already open (max ${limits.maxConcurrentPositions}).`);
  if (pct(ctx.openRiskUsd + ctx.riskUsd) > limits.maxOpenRiskPct + 1e-6) rej.push(`Total open risk would be ${pct(ctx.openRiskUsd + ctx.riskUsd).toFixed(2)}% (max ${limits.maxOpenRiskPct}%).`);
  const dailyLossPct = ctx.dailyRealizedPnlUsd < 0 ? pct(-ctx.dailyRealizedPnlUsd) : 0;
  if (dailyLossPct >= limits.maxDailyLossPct) rej.push(`Daily loss limit hit: ${dailyLossPct.toFixed(2)}% realised today (max ${limits.maxDailyLossPct}%). Terminal closed for the day.`);
  else if (dailyLossPct >= limits.maxDailyLossPct * 0.66) warn.push(`Daily loss at ${dailyLossPct.toFixed(2)}% of the ${limits.maxDailyLossPct}% limit.`);
  if (ctx.tradesToday >= limits.maxTradesPerDay) rej.push(`${ctx.tradesToday} trades already today (max ${limits.maxTradesPerDay}).`);
  if (ctx.stopDistancePct > 0 && ctx.liqDistancePct < ctx.stopDistancePct * (1 + limits.minStopToLiqBufferPct / 100)) {
    rej.push(`Liquidation (${(ctx.liqDistancePct * 100).toFixed(2)}% away) is too close to the stop (${(ctx.stopDistancePct * 100).toFixed(2)}% away); need ≥ ${100 + limits.minStopToLiqBufferPct}% of stop distance.`);
  }
  if (ctx.openSymbols.includes(ctx.symbol)) rej.push(`A position in ${ctx.symbol} is already open.`);
  const g = correlationGroup(ctx.symbol);
  if (g) {
    const same = ctx.openSymbols.filter(s => correlationGroup(s) === g).length;
    if (same >= limits.maxCorrelatedPositions) rej.push(`${same} correlated position(s) already open in group "${g}" (max ${limits.maxCorrelatedPositions}).`);
    else if (same >= 1) warn.push(`Correlated exposure: ${same} open position(s) in group "${g}".`);
  }
  return { ok: rej.length === 0, rejections: rej, warnings: warn };
}

export const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
