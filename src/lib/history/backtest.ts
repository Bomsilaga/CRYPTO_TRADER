/**
 * history/backtest.ts — true historical replay of the live engine.
 *
 * For every closed decision-timeframe candle T (after warm-up):
 *   1. Build the candle map the live scanner would have had at T: for each TF,
 *      only candles closed at or before T, truncated to the live fetch limits.
 *   2. Run the unchanged live engine (runEngine) on that map.
 *   3. NEUTRAL → no trade (counted, not traded). Otherwise take the master
 *      signal's entry/stop/TPs exactly as the live UI would display them.
 *   4. Walk forward through candles AFTER T to resolve the outcome.
 *   5. Record features, costs, MFE/MAE, timing.
 * Future candles are never visible to steps 1–3.
 */
import { runEngine } from '@/lib/signalEngine';
import type { BacktestConfig, BacktestRun, BacktestTrade, CandleMap, FeatureNorm, FundingPoint, StoredCandle, Timeframe } from './types';
import { DEFAULT_BACKTEST_CONFIG, EXECUTION_PROFILES, TF_MS, TF_ORDER } from './types';
import { closedBefore, candlesBetween } from './resample';
import { computeFeatures, regimeKey, SIMILARITY_FEATURES } from './features';
import { resolveOutcome, grossRFromFills } from './outcome';
import { computeCosts, slip, type Fill } from './costs';
import { summarize, walkForward, decay, btcSplit, btcRelation } from './stats';

export interface BacktestInput {
  symbol: string;
  candles: CandleMap;            // full history per TF (ascending)
  btcCandles?: CandleMap;        // BTCUSDT history for regime features
  funding?: FundingPoint[];
  config?: Partial<BacktestConfig>;
  source?: string;
  from?: number;                 // restrict decisions to [from, to]
  to?: number;
  onProgress?: (done: number, total: number) => void;
}

function sliceMap(full: CandleMap, decisionTime: number, limits: BacktestConfig['liveLimits']): CandleMap {
  const out: CandleMap = {};
  for (const tf of TF_ORDER) {
    const arr = full[tf];
    if (!arr?.length) continue;
    const closed = closedBefore(arr, tf, decisionTime);
    const lim = limits[tf] ?? 200;
    out[tf] = closed.length > lim ? closed.slice(-lim) : closed;
  }
  return out;
}

function fundingAt(funding: FundingPoint[] | undefined, t: number): number | null {
  if (!funding?.length) return null;
  let lo = 0, hi = funding.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (funding[mid].time <= t) lo = mid + 1; else hi = mid; }
  return lo ? funding[lo - 1].rate : null;
}

export function replayOne(opts: {
  symbol: string; decisionIdx: number; decisionTf: Timeframe; candles: CandleMap; btcCandles?: CandleMap; funding?: FundingPoint[]; config: BacktestConfig;
}): { trade: BacktestTrade | null; neutral: boolean } {
  const { symbol, decisionIdx, decisionTf, candles, config } = opts;
  const base = candles[decisionTf]!;
  const dc = base[decisionIdx];
  const decisionTime = dc.time + TF_MS[decisionTf];
  const cm = sliceMap(candles, decisionTime, config.liveLimits);
  const price = dc.close;
  const engine = runEngine(symbol, price, cm as Record<string, StoredCandle[]>, new Date(decisionTime).toISOString());
  if (engine.direction === 'NEUTRAL') return { trade: null, neutral: true };
  const direction = engine.direction;
  const ms = engine.masterSignal;
  const profile = EXECUTION_PROFILES[config.profile];
  const entry = profile.entryIsTaker ? slip(price, direction === 'LONG' ? 'buy' : 'sell', profile.slippageBps) : price;
  // levels are defined relative to the engine's price; keep the engine's absolute stop/TP prices
  const levels = { entry, stopLoss: ms.stopLoss, tp1: ms.tp1, tp2: ms.tp2, tp3: ms.tp3 };
  const stopDistancePct = Math.abs(entry - levels.stopLoss) / entry;
  if (stopDistancePct <= 0) return { trade: null, neutral: false };

  const future = candlesBetween(base, decisionTime, Number.MAX_SAFE_INTEGER);
  const lower: Partial<Record<Timeframe, StoredCandle[]>> = {};
  for (const tf of TF_ORDER) { if (TF_MS[tf] < TF_MS[decisionTf] && candles[tf]?.length) lower[tf] = candles[tf]; }
  const timeoutBars = config.timeoutBarsByStyle[engine.bestSetup];
  const out = resolveOutcome({ direction, levels, decisionTime, future, decisionTf, lower, timeoutBars, config });
  const fills: Fill[] = [{ price: entry, fraction: 1, kind: 'entry' }, ...out.fills];
  const grossR = grossRFromFills(direction, entry, levels.stopLoss, fills);
  const costs = computeCosts({
    entry, direction, stopDistancePct, fills, profile,
    funding: opts.funding ? { points: opts.funding, openTime: decisionTime, closeTime: out.closeTime, fractionAt: out.fractionAt } : undefined,
  });
  const btcMap = opts.btcCandles ? sliceMap(opts.btcCandles, decisionTime, config.liveLimits) : undefined;
  const features = computeFeatures({ symbol, time: decisionTime, direction, engine, candleMap: cm, btcCandleMap: btcMap, fundingRate: fundingAt(opts.funding, decisionTime) });
  const trade: BacktestTrade = {
    symbol, time: decisionTime, direction, setupStyle: engine.bestSetup, score: engine.totalScore,
    entry, stopLoss: levels.stopLoss, tp1: levels.tp1, tp2: levels.tp2, tp3: levels.tp3, stopDistancePct,
    tp1Hit: out.tp1Hit, tp2Hit: out.tp2Hit, tp3Hit: out.tp3Hit, stopHit: out.stopHit,
    firstOutcome: out.firstOutcome, finalExit: out.finalExit,
    mfePct: out.mfePct, maePct: out.maePct, mfeR: out.mfeR, maeR: out.maeR,
    timeToTP1: out.timeToTP1, timeToTP2: out.timeToTP2, timeToTP3: out.timeToTP3, timeToStop: out.timeToStop,
    holdMs: out.holdMs,
    grossR, netR: grossR - costs.totalR, feesR: costs.feesR, fundingR: costs.fundingR, slippageR: costs.slippageR,
    ambiguousCandles: out.ambiguousCandles, ambiguityResolvedBy: out.ambiguityResolvedBy,
    regimeKey: regimeKey(features),
    features,
  };
  return { trade, neutral: false };
}

export function featureNorms(trades: BacktestTrade[]): Record<string, FeatureNorm> {
  const out: Record<string, FeatureNorm> = {};
  for (const { key } of SIMILARITY_FEATURES) {
    const xs = trades.map(t => Number(t.features[key])).filter(v => Number.isFinite(v));
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const std = xs.length ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) : 1;
    out[key] = { mean, std: std > 1e-9 ? std : 1 };
  }
  return out;
}

export function buildStats(trades: BacktestTrade[], config: BacktestConfig): BacktestRun['stats'] {
  const setups = trades.filter(t => t.score >= config.minSetupScore);
  const L = setups.filter(t => t.direction === 'LONG'), S = setups.filter(t => t.direction === 'SHORT');
  const byRegime: Record<string, ReturnType<typeof summarize>> = {};
  for (const t of setups) {
    const k = `${t.direction}:${t.regimeKey}`;
    (byRegime[k] ??= summarize(setups.filter(x => x.direction === t.direction && x.regimeKey === t.regimeKey), k));
  }
  return {
    all: summarize(setups, 'all setups'),
    LONG: summarize(L, 'LONG'),
    SHORT: summarize(S, 'SHORT'),
    byRegime,
    walkForward: { LONG: walkForward(trades.filter(t => t.direction === 'LONG')), SHORT: walkForward(trades.filter(t => t.direction === 'SHORT')), all: walkForward(trades) },
    decay: { LONG: decay(L), SHORT: decay(S) },
    btcSplit: { LONG: btcSplit(setups, 'LONG'), SHORT: btcSplit(setups, 'SHORT') },
  };
}

export function runBacktest(input: BacktestInput): BacktestRun {
  const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...(input.config ?? {}) };
  const base = input.candles[config.decisionTf];
  if (!base || base.length < config.warmupBars + 10) throw new Error(`Not enough ${config.decisionTf} candles for ${input.symbol} (${base?.length ?? 0})`);
  const trades: BacktestTrade[] = [];
  let neutral = 0, skippedWhileOpen = 0, decisions = 0;
  let openUntil = -Infinity;
  const total = base.length - 1 - config.warmupBars;
  for (let i = config.warmupBars; i < base.length - 1; i++) {
    const t = base[i].time + TF_MS[config.decisionTf];
    if (input.from && t < input.from) continue;
    if (input.to && t > input.to) break;
    decisions++;
    if (config.oneAtATime && t < openUntil) { skippedWhileOpen++; continue; }
    const r = replayOne({ symbol: input.symbol, decisionIdx: i, decisionTf: config.decisionTf, candles: input.candles, btcCandles: input.btcCandles, funding: input.funding, config });
    if (r.neutral) { neutral++; continue; }
    if (r.trade) { trades.push(r.trade); openUntil = r.trade.time + r.trade.holdMs; }
    if (input.onProgress && (i - config.warmupBars) % 500 === 0) input.onProgress(i - config.warmupBars, total);
  }
  const coverage: BacktestRun['coverage'] = {};
  for (const tf of TF_ORDER) {
    const arr = input.candles[tf];
    if (arr?.length) coverage[tf] = { from: arr[0].time, to: arr[arr.length - 1].time, count: arr.length };
  }
  const stats = buildStats(trades, config);
  if (input.btcCandles?.['4h']?.length && input.candles['4h']?.length) {
    stats.btcRelation = btcRelation(input.candles['4h'], input.btcCandles['4h'], input.candles['1d'] ?? [], input.btcCandles['1d'] ?? []);
  }
  return {
    symbol: input.symbol, version: 2, builtAt: new Date().toISOString(), source: input.source, config, coverage,
    decisions, neutralDecisions: neutral, skippedWhileOpen, trades,
    featureNorms: featureNorms(trades),
    stats,
  };
}
