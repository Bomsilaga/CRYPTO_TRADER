import type { StoredCandle, Timeframe, BacktestTrade, FeatureSnapshot } from '../src/lib/history/types';
import { TF_MS } from '../src/lib/history/types';
import { resample } from '../src/lib/history/resample';
import type { BybitClient, PositionInfo, OrderInfo, Instrument } from '../src/lib/bybitPrivate';

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Deterministic geometric random walk with drifting regimes, base timeframe candles aligned to UTC. */
export function synthCandles(opts: { n: number; tf: Timeframe; start?: number; seed?: number; price?: number; vol?: number }): StoredCandle[] {
  const r = rng(opts.seed ?? 42);
  const step = TF_MS[opts.tf];
  const start = opts.start ?? Math.floor(Date.UTC(2025, 0, 1) / step) * step;
  let p = opts.price ?? 100;
  let drift = 0;
  const out: StoredCandle[] = [];
  for (let i = 0; i < opts.n; i++) {
    if (i % 300 === 0) drift = (r() - 0.5) * 0.002;
    const vol = (opts.vol ?? 0.006) * (0.6 + r() * 1.2);
    const o = p;
    const c = o * (1 + drift + (r() - 0.5) * 2 * vol);
    const hi = Math.max(o, c) * (1 + r() * vol * 0.8);
    const lo = Math.min(o, c) * (1 - r() * vol * 0.8);
    out.push({ time: start + i * step, open: o, high: hi, low: lo, close: c, volume: 1000 + r() * 2000 });
    p = c;
  }
  return out;
}

export function synthCandleMap(seed = 7, n15 = 4 * 1200) {
  const c15 = synthCandles({ n: n15, tf: '15m', seed });
  return { '15m': c15, '1h': resample(c15, '1h'), '4h': resample(c15, '4h'), '1d': resample(c15, '1d') };
}

export function feature(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    symbol: 'TESTUSDT', time: Date.UTC(2025, 0, 1), direction: 'LONG', score: 70, confidence: 60, setupStyle: 'INTRADAY',
    trend1m: 'UP', trend5m: 'UP', trend15m: 'UP', trend1h: 'UP', trend4h: 'UP', trend1d: 'UP', alignment: 80,
    rsi: 55, macdLine: 0.1, macdSignal: 0.05, macdHist: 0.05, atr: 1, atrPct: 0.01, atrPercentile: 50, bbWidth: 0.04,
    volRegime: 'NORMAL', trendRegime: 'BULL', volumeRatio: 1.2, volumeRegime: 'NORMAL', vwapDistPct: 0.2, pocDistPct: 0.1,
    swingHighDistPct: 1, swingLowDistPct: 1, bos: true, choch: false, orderBlock: true, fvg: false, sweep: true, inOTE: false, wyckoff: 'MARKUP',
    fundingRate: 0.0001, change24hPct: 1, btcRegime: 'BULL', btcTrend1h: 'UP', btcTrend4h: 'UP', btcVolRegime: 'NORMAL', tfCoverage: '15m,1h,4h,1d',
    ...overrides,
  };
}

export function trade(overrides: Partial<Omit<BacktestTrade, 'features'>> & { features?: Partial<FeatureSnapshot> } = {}): BacktestTrade {
  const f = feature(overrides.features ?? {});
  return {
    symbol: 'TESTUSDT', time: f.time, direction: f.direction, setupStyle: 'INTRADAY', score: f.score,
    entry: 100, stopLoss: 98, tp1: 102, tp2: 104, tp3: 106.5, stopDistancePct: 0.02,
    tp1Hit: true, tp2Hit: false, tp3Hit: false, stopHit: true, firstOutcome: 'TP1', finalExit: 'BREAKEVEN',
    mfePct: 2.5, maePct: 0.8, mfeR: 1.25, maeR: 0.4, timeToTP1: 3_600_000, timeToTP2: null, timeToTP3: null, timeToStop: 7_200_000,
    holdMs: 7_200_000, entryMode: 'LIMIT', entryStatus: 'WAIT_PULLBACK', entryKinds: ['OB'], structural: true, barsToFill: 1,
    grossR: 0.5, netR: 0.4, feesR: 0.07, fundingR: 0.01, slippageR: 0.02,
    ambiguousCandles: 0, ambiguityResolvedBy: 'none', regimeKey: 'NORMALVOL_BULL_BTCBULL',
    ...overrides,
    features: f,
  };
}

export const INST: Instrument = { tickSize: 0.01, qtyStep: 0.001, minQty: 0.001, maxQty: 100000, maxLeverage: 50 };

/** Scriptable fake exchange for execution tests. */
export function fakeClient(script: {
  positions?: PositionInfo[][];        // successive responses
  orders?: Record<string, OrderInfo>;
  tradingStopOk?: boolean;
  createOk?: boolean;
  onCreate?: (p: Record<string, string | number>) => void;
} = {}): BybitClient & { calls: { m: string; p?: unknown }[] } {
  const calls: { m: string; p?: unknown }[] = [];
  let posIdx = 0;
  const c = {
    calls,
    request: async () => ({ retCode: 0, retMsg: 'OK' }),
    setLeverage: async () => { calls.push({ m: 'setLeverage' }); },
    walletBalance: async () => ({ equity: 5000, available: 5000 }),
    positions: async () => { calls.push({ m: 'positions' }); const arr = script.positions ?? []; const r = arr[Math.min(posIdx, arr.length - 1)] ?? []; posIdx++; return r; },
    createOrder: async (p: Record<string, string | number>) => { calls.push({ m: 'createOrder', p }); script.onCreate?.(p); return script.createOk === false ? { retCode: 10001, retMsg: 'rejected' } : { retCode: 0, retMsg: 'OK', result: { orderId: `o-${calls.length}` } }; },
    cancelOrder: async () => { calls.push({ m: 'cancelOrder' }); return { retCode: 0, retMsg: 'OK' }; },
    openOrders: async () => [],
    getOrder: async (_s: string, id: string) => script.orders?.[id] ?? null,
    tradingStop: async () => { calls.push({ m: 'tradingStop' }); return script.tradingStopOk === false ? { retCode: 10001, retMsg: 'fail' } : { retCode: 0, retMsg: 'OK' }; },
    closedPnlSince: async () => ({ count: 0, pnl: 0 }),
  };
  return c as unknown as BybitClient & { calls: { m: string; p?: unknown }[] };
}
