import type { StoredCandle, Timeframe } from './types';
import { TF_MS } from './types';

/** Aggregate candles into a larger timeframe aligned to UTC epoch boundaries (matches Bybit alignment). */
export function resample(candles: StoredCandle[], target: Timeframe): StoredCandle[] {
  const step = TF_MS[target];
  const out: StoredCandle[] = [];
  let cur: StoredCandle | null = null;
  for (const c of candles) {
    const bucket = Math.floor(c.time / step) * step;
    if (!cur || cur.time !== bucket) {
      if (cur) out.push(cur);
      cur = { time: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, turnover: c.turnover };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
      if (cur.turnover !== undefined && c.turnover !== undefined) cur.turnover += c.turnover;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Merge + de-duplicate by open time, ascending. Later arrays win on conflict. */
export function mergeCandles(...sets: StoredCandle[][]): StoredCandle[] {
  const m = new Map<number, StoredCandle>();
  for (const s of sets) for (const c of s) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

/** Candles fully closed at or before `decisionTime` (open + tf <= decisionTime). */
export function closedBefore(candles: StoredCandle[], tf: Timeframe, decisionTime: number): StoredCandle[] {
  const step = TF_MS[tf];
  // candles are ascending; binary search for the last closed candle
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time + step <= decisionTime) lo = mid + 1; else hi = mid;
  }
  return candles.slice(0, lo);
}

/** Candles whose open time is in [from, to). */
export function candlesBetween(candles: StoredCandle[], from: number, to: number): StoredCandle[] {
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time < from) lo = mid + 1; else hi = mid; }
  const start = lo;
  hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time < to) lo = mid + 1; else hi = mid; }
  return candles.slice(start, lo);
}
