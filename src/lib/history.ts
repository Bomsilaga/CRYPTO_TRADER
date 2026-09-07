import type { RawCandle } from "./bybit";
import {
  atr,
  rsi,
  macd,
  vwap,
  volRatio,
  trendLabel,
  detectBOS,
  detectChoCH,
  detectFVG,
  detectOB,
  detectSweeps,
} from "./indicators";
import { DEFAULT_COSTS, exitEconomics, type Levels } from "./risk";
export const MODEL_VERSION = "pair-edge-v1";
export const STYLE = {
  SCALP: { tf: "5", ms: 300000, horizon: 24, sl: 1.3 },
  INTRADAY: { tf: "60", ms: 3600000, horizon: 24, sl: 2.5 },
  SWING: { tf: "240", ms: 14400000, horizon: 42, sl: 5 },
};
export type Style = keyof typeof STYLE;
export interface Features {
  rsi: number;
  atrPct: number;
  volatilityPercentile: number;
  volumeRatio: number;
  vwapDistance: number;
  momentum: number;
  trend: string;
  regime: string;
  bos: boolean;
  choch: boolean;
  fvg: boolean;
  ob: boolean;
  sweep: boolean;
  swingDistance: number;
  change24h: number;
}
export interface RecordTrade extends Levels {
  symbol: string;
  style: Style;
  timestamp: number;
  endTime: number;
  features: Features;
  hits: boolean[];
  hitTimes: (number | null)[];
  stopHit: boolean;
  timeout: boolean;
  mfe: number;
  mae: number;
  netR: number;
  fees: number;
  slippage: number;
  holdingHours: number;
  oosEligible: boolean;
}
export function snapshot(
  c: RawCandle[],
  style: Style,
  direction: "LONG" | "SHORT",
): Features {
  const last = c[c.length - 1],
    a = atr(c),
    ap = a / last.close;
  const volatility = c.slice(-100).map((x) => (x.high - x.low) / x.close);
  const percentile =
    volatility.filter((v) => v <= ap).length / volatility.length;
  const trend = trendLabel(c),
    vr = volRatio(c);
  const high = Math.max(...c.slice(-30).map((x) => x.high)),
    low = Math.min(...c.slice(-30).map((x) => x.low));
  const prev =
    c[Math.max(0, c.length - 1 - Math.round(86400000 / STYLE[style].ms))].close;
  return {
    rsi: rsi(c.map((x) => x.close)),
    atrPct: ap,
    volatilityPercentile: percentile,
    volumeRatio: vr,
    vwapDistance: (last.close - vwap(c)) / a,
    momentum: macd(c.map((x) => x.close)).histogram / a,
    trend,
    regime: `${trend}:${percentile >= 0.7 ? "HIGH" : percentile <= 0.3 ? "LOW" : "NORMAL"}`,
    bos: detectBOS(c),
    choch: detectChoCH(c),
    fvg: detectFVG(c, direction),
    ob: detectOB(c, direction),
    sweep: detectSweeps(c).length > 0,
    swingDistance: (last.close - low) / Math.max(high - low, a),
    change24h: (last.close / prev - 1) * 100,
  };
}
export function levels(
  entry: number,
  a: number,
  style: Style,
  direction: "LONG" | "SHORT",
): Levels {
  const risk = a * STYLE[style].sl,
    d = direction === "LONG" ? 1 : -1;
  return {
    direction,
    entry,
    stopLoss: entry - d * risk,
    tp1: entry + d * risk,
    tp2: entry + d * 2 * risk,
    tp3: entry + d * 3 * risk,
  };
}
export function simulate(p: Levels, future: RawCandle[]) {
  const d = p.direction === "LONG" ? 1 : -1,
    risk = Math.abs(p.entry - p.stopLoss);
  const hits = [false, false, false],
    hitTimes: (number | null)[] = [null, null, null],
    weights = [0.5, 0.25, 0.25];
  let left = 1,
    net = 0,
    fees = 0,
    slippage = 0,
    mfe = 0,
    mae = 0,
    stopHit = false,
    end = future[0];
  const settle = (fraction: number, price: number) => {
    const e = exitEconomics(p, fraction, price, DEFAULT_COSTS);
    net += e.net;
    fees += e.fees;
    slippage += e.slippage;
    left -= fraction;
  };
  for (const c of future) {
    end = c;
    mfe = Math.max(
      mfe,
      d === 1 ? (c.high / p.entry - 1) * 100 : (1 - c.low / p.entry) * 100,
    );
    mae = Math.min(
      mae,
      d === 1 ? (c.low / p.entry - 1) * 100 : (1 - c.high / p.entry) * 100,
    );
    // OHLC cannot establish event order. Resolve stop before all new targets, including gap-through loss.
    if (d === 1 ? c.low <= p.stopLoss : c.high >= p.stopLoss) {
      settle(
        left,
        d === 1 ? Math.min(p.stopLoss, c.open) : Math.max(p.stopLoss, c.open),
      );
      stopHit = true;
      break;
    }
    [p.tp1, p.tp2, p.tp3].forEach((tp, i) => {
      if (!hits[i] && (d === 1 ? c.high >= tp : c.low <= tp)) {
        hits[i] = true;
        hitTimes[i] = c.time;
        settle(weights[i], tp);
      }
    });
    if (left < 1e-8) break;
  }
  const timeout = left > 1e-8;
  if (timeout) settle(left, end.close);
  return {
    hits,
    hitTimes,
    stopHit,
    timeout,
    mfe,
    mae,
    netR: net / risk,
    fees,
    slippage,
    endTime: end.time,
  };
}
export function buildRecords(
  symbol: string,
  style: Style,
  candles: RawCandle[],
): RecordTrade[] {
  const cfg = STYLE[style],
    records: RecordTrade[] = [];
  for (const direction of ["LONG", "SHORT"] as const) {
    for (let i = 100; i + cfg.horizon < candles.length; ) {
      const past = candles.slice(Math.max(0, i - 199), i + 1),
        future = candles.slice(i + 1, i + 1 + cfg.horizon);
      // Reject gaps; a missing candle could conceal a stop.
      if (
        [...past, ...future].some(
          (c, j, arr) => j > 0 && c.time - arr[j - 1].time !== cfg.ms,
        )
      ) {
        i++;
        continue;
      }
      const p = levels(future[0].open, atr(past), style, direction);
      if (p.stopLoss <= 0 || p.tp3 <= 0 || atr(past) <= 0) {
        i++;
        continue;
      }
      const outcome = simulate(p, future),
        timestamp = candles[i].time + cfg.ms;
      const prior = records.filter(
        (r) => r.direction === direction && r.endTime + cfg.ms < timestamp,
      );
      const features = snapshot(past, style, direction);
      const matches = nearest(prior, features, timestamp);
      const oosEligible =
        matches.length >= 50 && stats(matches, timestamp).expectancy! > 0;
      records.push({
        symbol,
        style,
        ...p,
        ...outcome,
        timestamp,
        features,
        oosEligible,
        endTime: outcome.endTime + cfg.ms,
        holdingHours: (outcome.endTime + cfg.ms - timestamp) / 3600000,
      });
      i = candles.findIndex((c) => c.time === outcome.endTime) + 1;
    }
  }
  return records.sort((a, b) => a.timestamp - b.timestamp);
}
export function distance(a: Features, b: Features) {
  // Group correlated OHLC-derived observations; do not treat them as independent votes.
  const trend =
    (a.trend === b.trend ? 0 : 1) +
    Math.min(1, Math.abs(a.momentum - b.momentum));
  const volatility =
    Math.abs(a.volatilityPercentile - b.volatilityPercentile) +
    Math.min(1, Math.abs(Math.log(a.atrPct / b.atrPct)));
  const location =
    Math.abs(a.rsi - b.rsi) / 100 +
    Math.min(1, Math.abs(a.vwapDistance - b.vwapDistance) / 4) +
    Math.abs(a.swingDistance - b.swingDistance);
  const structure =
    ["bos", "choch", "fvg", "ob", "sweep"].filter(
      (k) => a[k as keyof Features] !== b[k as keyof Features],
    ).length / 5;
  return (
    (trend / 2 +
      volatility / 2 +
      location / 3 +
      structure +
      Math.min(1, Math.abs(a.volumeRatio - b.volumeRatio) / 3)) /
    5
  );
}
export function nearest(
  records: RecordTrade[],
  feature: Features,
  asOf: number,
) {
  return records
    .filter((r) => r.endTime < asOf && distance(r.features, feature) <= 0.35)
    .sort(
      (a, b) =>
        distance(a.features, feature) +
        ((asOf - a.timestamp) / 86400000 / 365) * 0.05 -
        (distance(b.features, feature) +
          ((asOf - b.timestamp) / 86400000 / 365) * 0.05),
    )
    .slice(0, 250);
}
export function wilson(wins: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.96,
    p = wins / n,
    den = 1 + (z * z) / n,
    mid = (p + (z * z) / (2 * n)) / den,
    half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [(mid - half) * 100, (mid + half) * 100];
}
const average = (a: number[]) =>
  a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = (a: number[]) => {
  const v = [...a].sort((a, b) => a - b);
  return v.length
    ? (v[Math.floor((v.length - 1) / 2)] + v[Math.floor(v.length / 2)]) / 2
    : null;
};
export function stats(records: RecordTrade[], asOf: number) {
  const r = [...records].sort((a, b) => a.timestamp - b.timestamp),
    n = r.length;
  const wins = [0, 1, 2].map((i) => r.filter((x) => x.hits[i]).length);
  let equity = 0,
    peak = 0,
    drawdown = 0,
    streak = 0,
    maxStreak = 0;
  for (const x of r) {
    equity += x.netR;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
    streak = x.netR < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const positive = r.reduce((s, x) => s + Math.max(0, x.netR), 0),
    negative = -r.reduce((s, x) => s + Math.min(0, x.netR), 0);
  const weights = r.map((x) =>
      Math.pow(0.5, (asOf - x.timestamp) / 86400000 / 90),
    ),
    sum = weights.reduce((s, x) => s + x, 0);
  const recent = r.filter((x) => x.timestamp >= asOf - 30 * 86400000);
  return {
    n,
    wins,
    tpRates: wins.map((w) => (n ? (w / n) * 100 : null)),
    interval: wilson(wins[0], n),
    sampleLabel:
      n < 20
        ? "INSUFFICIENT DATA"
        : n < 50
          ? "LOW SAMPLE"
          : n < 100
            ? "MODERATE SAMPLE"
            : n < 250
              ? "GOOD SAMPLE"
              : "STRONG SAMPLE",
    expectancy: average(r.map((x) => x.netR)),
    profitFactor: negative > 0 ? positive / negative : null,
    weightedTp1: sum
      ? (r.reduce((s, x, i) => s + Number(x.hits[0]) * weights[i], 0) / sum) *
        100
      : null,
    effectiveSample: sum
      ? (sum * sum) / weights.reduce((s, x) => s + x * x, 0)
      : 0,
    avgMFE: average(r.map((x) => x.mfe)),
    avgMAE: average(r.map((x) => x.mae)),
    medianMFE: median(r.map((x) => x.mfe)),
    medianMAE: median(r.map((x) => x.mae)),
    holdingHours: average(r.map((x) => x.holdingHours)),
    maxLosingStreak: maxStreak,
    maxDrawdownR: drawdown,
    stopFirst: n
      ? (r.filter((x) => x.stopHit && !x.hits[0]).length / n) * 100
      : null,
    timeouts: r.filter((x) => x.timeout).length,
    recent30DayTp1: recent.length
      ? (recent.filter((x) => x.hits[0]).length / recent.length) * 100
      : null,
  };
}
export function evidence(
  records: RecordTrade[],
  feature: Features,
  direction: "LONG" | "SHORT",
  asOf: number,
) {
  const r = records.filter(
      (x) => x.direction === direction && x.endTime < asOf,
    ),
    comparable = nearest(r, feature, asOf);
  return {
    direction,
    features: feature,
    all: stats(r, asOf),
    regime: stats(
      r.filter((x) => x.features.regime === feature.regime),
      asOf,
    ),
    comparable: stats(comparable, asOf),
    outOfSample: stats(
      r.filter((x) => x.oosEligible),
      asOf,
    ),
    range: {
      from: r[0]?.timestamp ?? null,
      to: r[r.length - 1]?.endTime ?? null,
    },
    model: MODEL_VERSION,
    costNote:
      "Taker fee 0.055% and slippage 0.05% per side; historical funding unavailable and excluded. Rates are assumptions, not account fees.",
    validation:
      "Expanding walk-forward: each decision uses only previously completed same-pair, same-style, same-direction trades. Fixed parameters; not a calibrated forecast.",
    missingFeatures: [
      "historical funding",
      "BTC regime",
      "cross-timeframe snapshots",
      "order-book liquidity",
    ],
    records: comparable,
  };
}
