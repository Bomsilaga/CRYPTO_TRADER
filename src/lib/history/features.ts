/**
 * history/features.ts — feature snapshot at a decision time.
 *
 * Inputs are candle maps that have ALREADY been truncated to candles closed
 * at or before the decision time (see resample.closedBefore). This module
 * never looks at array indices beyond what it is given, so it cannot leak
 * future information as long as callers truncate correctly. The backtester
 * and the live scanner both call it with the same shape of input.
 */
import type { EngineResult } from '@/lib/signalEngine';
import { atr, macd, bollingerBands, vwap, poc, volRatio, swingHighLow, trendLabel } from '@/lib/indicators';
import type { CandleMap, FeatureSnapshot, TrendRegime, VolRegime, VolumeRegime, StoredCandle } from './types';

export function atrPctSeries(h1: StoredCandle[], period = 14, span = 200): number[] {
  const out: number[] = [];
  const start = Math.max(period + 1, h1.length - span);
  for (let i = start; i <= h1.length; i++) {
    const slice = h1.slice(Math.max(0, i - period - 1), i);
    const a = atr(slice, period);
    const px = slice[slice.length - 1]?.close ?? 0;
    out.push(px > 0 ? a / px : 0);
  }
  return out;
}

export function percentileRank(series: number[], value: number): number {
  if (!series.length) return 50;
  const below = series.filter(v => v < value).length;
  return Math.round((below / series.length) * 100);
}

export function volRegimeOf(atrPercentile: number): VolRegime {
  return atrPercentile < 33 ? 'LOW' : atrPercentile < 67 ? 'NORMAL' : 'HIGH';
}
export function volumeRegimeOf(ratio: number): VolumeRegime {
  return ratio < 0.7 ? 'THIN' : ratio > 1.5 ? 'HEAVY' : 'NORMAL';
}
export function trendRegimeOf(trend1h: string, trend4h: string): TrendRegime {
  const up = [trend1h, trend4h].filter(t => t.includes('UP')).length;
  const down = [trend1h, trend4h].filter(t => t.includes('DOWN')).length;
  if (up === 2) return 'BULL';
  if (down === 2) return 'BEAR';
  return 'RANGE';
}

export function regimeKey(f: Pick<FeatureSnapshot, 'volRegime' | 'trendRegime' | 'btcRegime'>): string {
  return `${f.volRegime}VOL_${f.trendRegime}_BTC${f.btcRegime}`;
}

export function computeFeatures(opts: {
  symbol: string;
  time: number;
  direction: 'LONG' | 'SHORT';
  engine: EngineResult;
  candleMap: CandleMap;         // truncated to <= time
  btcCandleMap?: CandleMap;     // truncated to <= time
  fundingRate?: number | null;
  change24hPct?: number;
}): FeatureSnapshot {
  const { symbol, time, direction, engine, candleMap } = opts;
  const h1 = candleMap['1h'] ?? candleMap['15m'] ?? [];
  const h4 = candleMap['4h'] ?? [];
  const price = h1[h1.length - 1]?.close ?? engine.masterSignal.entry;
  const closes = h1.map(c => c.close);
  const m = macd(closes);
  const a = atr(h1);
  const atrPct = price > 0 ? a / price : 0;
  const series = atrPctSeries(h1);
  const atrPercentile = percentileRank(series.slice(0, -1), atrPct);
  const bb = bollingerBands(closes);
  const vw = vwap(h1.slice(-100));
  const pc = poc(h1.slice(-100));
  const vr = volRatio(h1);
  const sw = swingHighLow(h4.length >= 20 ? h4 : h1, 30);
  const tm = engine.trendMap;
  const btcH1 = opts.btcCandleMap?.['1h'] ?? [];
  const btcH4 = opts.btcCandleMap?.['4h'] ?? [];
  const btcTrend1h = btcH1.length >= 50 ? trendLabel(btcH1) : 'UNKNOWN';
  const btcTrend4h = btcH4.length >= 50 ? trendLabel(btcH4) : 'UNKNOWN';
  const btcRegime: FeatureSnapshot['btcRegime'] = btcTrend1h === 'UNKNOWN' && btcTrend4h === 'UNKNOWN' ? 'UNKNOWN' : trendRegimeOf(btcTrend1h, btcTrend4h);
  let btcVolRegime: FeatureSnapshot['btcVolRegime'] = 'UNKNOWN';
  if (btcH1.length >= 30) {
    const bs = atrPctSeries(btcH1);
    const bpx = btcH1[btcH1.length - 1].close;
    btcVolRegime = volRegimeOf(percentileRank(bs.slice(0, -1), atr(btcH1) / bpx));
  }
  const ote = engine.deep.oteZone;
  const inOTE = price >= ote.low && price <= ote.high;
  const coverage = (['1m', '5m', '15m', '1h', '4h', '1d'] as const).filter(tf => (candleMap[tf]?.length ?? 0) >= 50).join(',');
  const change24 = opts.change24hPct ?? (h1.length >= 25 ? ((price - h1[h1.length - 25].close) / h1[h1.length - 25].close) * 100 : 0);

  const f: FeatureSnapshot = {
    symbol, time, direction,
    score: engine.totalScore, confidence: engine.confidence, setupStyle: engine.bestSetup,
    trend1m: tm['1m'] ?? 'NEUTRAL', trend5m: tm['5m'] ?? 'NEUTRAL', trend15m: tm['15m'] ?? 'NEUTRAL',
    trend1h: tm['1h'] ?? 'NEUTRAL', trend4h: tm['4h'] ?? 'NEUTRAL', trend1d: tm['1d'] ?? 'NEUTRAL',
    alignment: engine.alignmentScore,
    rsi: engine.deep.rsi, macdLine: m.macdLine, macdSignal: m.signalLine, macdHist: m.histogram,
    atr: a, atrPct, atrPercentile, bbWidth: bb.width,
    volRegime: volRegimeOf(atrPercentile),
    trendRegime: trendRegimeOf(tm['1h'] ?? '', tm['4h'] ?? ''),
    volumeRatio: vr, volumeRegime: volumeRegimeOf(vr),
    vwapDistPct: price > 0 ? ((price - vw) / price) * 100 : 0,
    pocDistPct: price > 0 ? ((price - pc) / price) * 100 : 0,
    swingHighDistPct: price > 0 ? ((sw.high - price) / price) * 100 : 0,
    swingLowDistPct: price > 0 ? ((price - sw.low) / price) * 100 : 0,
    bos: engine.deep.hasBOS, choch: engine.deep.hasChoCH, orderBlock: engine.deep.hasOB, fvg: engine.deep.hasFVG, sweep: engine.deep.hasSweep,
    inOTE, wyckoff: engine.deep.wyckoffPhase,
    fundingRate: opts.fundingRate ?? null,
    change24hPct: change24,
    btcRegime, btcTrend1h, btcTrend4h, btcVolRegime,
    tfCoverage: coverage,
  };
  return f;
}

/** Numeric features used for similarity matching, with weights. Highly correlated indicators share a lower total weight. */
export const SIMILARITY_FEATURES: { key: keyof FeatureSnapshot; weight: number }[] = [
  { key: 'atrPercentile', weight: 1.0 },
  { key: 'rsi', weight: 1.0 },
  { key: 'alignment', weight: 1.0 },
  { key: 'score', weight: 0.8 },
  { key: 'volumeRatio', weight: 0.8 },
  { key: 'vwapDistPct', weight: 0.7 },
  { key: 'macdHist', weight: 0.4 },      // correlated with RSI/trend → down-weighted
  { key: 'bbWidth', weight: 0.4 },       // correlated with ATR → down-weighted
  { key: 'swingHighDistPct', weight: 0.5 },
  { key: 'swingLowDistPct', weight: 0.5 },
];
export const SIMILARITY_FLAGS: { key: keyof FeatureSnapshot; weight: number }[] = [
  { key: 'bos', weight: 0.6 }, { key: 'choch', weight: 0.4 }, { key: 'orderBlock', weight: 0.4 }, { key: 'fvg', weight: 0.3 }, { key: 'sweep', weight: 0.6 }, { key: 'inOTE', weight: 0.3 },
];
export const SIMILARITY_CATEGORICAL: { key: keyof FeatureSnapshot; weight: number }[] = [
  { key: 'trendRegime', weight: 1.0 }, { key: 'volRegime', weight: 0.6 }, { key: 'btcRegime', weight: 0.8 }, { key: 'volumeRegime', weight: 0.4 },
];
