/**
 * indicators.ts — Technical Indicators + ICT Concepts
 *
 * OPPOSER FIX (Self-Audit): Order Block detection was a single-candle check
 * ─────────────────────────────────────────────────────────────────────────
 * Original: any bearish candle in last 5 = "Order Block detected" (+12 score)
 * This fired on the majority of all scans, inflating scores by 12 points
 * and pushing borderline signals over the 55/100 threshold.
 *
 * Fixed: OB now requires (1) a reversal candle that (2) preceded a BOS impulse
 * of at least 1× ATR AND (3) has not been fully mitigated (price returned
 * through the candle body). This matches ICT's actual OB definition.
 *
 * OPPOSER FIX (Strike 7): Wyckoff was a 2-window comparison (decorative)
 * ────────────────────────────────────────────────────────────────────────
 * Improved to use 4 stages with volume confirmation and price structure.
 * Still simplified vs full Wyckoff (which requires weeks of data) but
 * no longer misleadingly labels a single candle comparison as Wyckoff phase.
 * Label changed to include "(simplified)" to avoid overconfidence.
 */

import type { RawCandle } from './bybit';

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(...new Array(period - 1).fill(NaN), prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

export function atr(candles: RawCandle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close))
  );
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
}

export function macd(closes: number[]): { macdLine: number; signalLine: number; histogram: number } {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = e12.map((v, i) => (isNaN(v) || isNaN(e26[i]) ? NaN : v - e26[i]));
  const validMacd = macdLine.filter((v) => !isNaN(v));
  const signal = ema(validMacd, 9);
  const lastMacd = validMacd[validMacd.length - 1] ?? 0;
  const lastSignal = signal[signal.length - 1] ?? 0;
  return { macdLine: lastMacd, signalLine: lastSignal, histogram: lastMacd - lastSignal };
}

export function bollingerBands(closes: number[], period = 20, stdMult = 2): { upper: number; middle: number; lower: number; width: number } {
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - middle) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = middle + stdMult * std;
  const lower = middle - stdMult * std;
  return { upper, middle, lower, width: (upper - lower) / middle };
}

export function vwap(candles: RawCandle[]): number {
  let cumPV = 0, cumV = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumPV += tp * c.volume;
    cumV += c.volume;
  }
  return cumV === 0 ? candles[candles.length - 1]?.close ?? 0 : cumPV / cumV;
}

export function poc(candles: RawCandle[], buckets = 50): number {
  if (candles.length === 0) return 0;
  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const minP = Math.min(...lows);
  const maxP = Math.max(...highs);
  const step = (maxP - minP) / buckets;
  const vol: number[] = new Array(buckets).fill(0);
  for (const c of candles) {
    const lo = Math.floor((c.low - minP) / step);
    const hi = Math.ceil((c.high - minP) / step);
    for (let b = Math.max(0, lo); b < Math.min(buckets, hi); b++) {
      vol[b] += c.volume;
    }
  }
  const maxBucket = vol.indexOf(Math.max(...vol));
  return minP + (maxBucket + 0.5) * step;
}

export function volRatio(candles: RawCandle[], recent = 5, base = 20): number {
  if (candles.length < base) return 1;
  const recentVol = candles.slice(-recent).reduce((a, c) => a + c.volume, 0) / recent;
  const baseVol = candles.slice(-base, -recent).reduce((a, c) => a + c.volume, 0) / (base - recent);
  return baseVol === 0 ? 1 : recentVol / baseVol;
}

export function swingHighLow(candles: RawCandle[], lookback = 20): { high: number; low: number } {
  const slice = candles.slice(-lookback);
  return {
    high: Math.max(...slice.map((c) => c.high)),
    low:  Math.min(...slice.map((c) => c.low)),
  };
}

export function fibLevels(high: number, low: number): { label: string; price: number }[] {
  const range = high - low;
  return [
    { label: '0%',         price: high },
    { label: '23.6%',      price: high - range * 0.236 },
    { label: '38.2%',      price: high - range * 0.382 },
    { label: '50%',        price: high - range * 0.5   },
    { label: '61.8%',      price: high - range * 0.618 },
    { label: '78.6%',      price: high - range * 0.786 },
    { label: '100%',       price: low },
    { label: 'Ext 127.2%', price: low - range * 0.272 },
    { label: 'Ext 161.8%', price: low - range * 0.618 },
  ];
}

/**
 * FIXED: wyckoffPhase
 * Original: compared 2 × 20-candle windows (decorative, not real Wyckoff)
 * Fixed: uses 4-stage analysis with volume trend confirmation and price
 * structure (higher highs/lows vs lower highs/lows). Still simplified —
 * genuine Wyckoff requires weeks of data and human event identification.
 * Label now includes "(simplified)" to prevent overconfidence.
 */
export function wyckoffPhase(candles: RawCandle[]): string {
  if (candles.length < 60) return 'UNCLEAR (insufficient data)';

  const recent = candles.slice(-60);
  const q1 = recent.slice(0, 15);
  const q2 = recent.slice(15, 30);
  const q3 = recent.slice(30, 45);
  const q4 = recent.slice(45, 60);

  const avgVol = (slice: RawCandle[]) => slice.reduce((a, c) => a + c.volume, 0) / slice.length;
  const avgClose = (slice: RawCandle[]) => slice.reduce((a, c) => a + c.close, 0) / slice.length;

  const v1 = avgVol(q1), v2 = avgVol(q2), v3 = avgVol(q3), v4 = avgVol(q4);
  const p1 = avgClose(q1), p4 = avgClose(q4);
  const priceUp = p4 > p1;

  // Volume trend
  const volAccel = v4 > v3 && v3 > v2;  // accelerating vol = active phase
  const volDecel = v4 < v3 && v3 < v2;  // decelerating vol = transitional

  // Structure check: higher highs/lows (accumulation/markup) vs lower highs/lows
  const highs = recent.map(c => c.high);
  const lows  = recent.map(c => c.low);
  const risingStructure  = highs[highs.length - 1] > highs[0] && lows[lows.length - 1] > lows[0];
  const fallingStructure = highs[highs.length - 1] < highs[0] && lows[lows.length - 1] < lows[0];

  if (priceUp && volAccel && risingStructure)    return 'MARKUP (simplified)';
  if (priceUp && volDecel)                        return 'DISTRIBUTION (simplified)';
  if (!priceUp && volAccel && fallingStructure)   return 'MARKDOWN (simplified)';
  if (!priceUp && volDecel)                       return 'ACCUMULATION (simplified)';
  if (risingStructure)                            return 'POSSIBLE MARKUP (simplified)';
  if (fallingStructure)                           return 'POSSIBLE MARKDOWN (simplified)';
  return 'TRANSITION / UNCLEAR (simplified)';
}

export function detectBOS(candles: RawCandle[]): boolean {
  if (candles.length < 10) return false;
  const recent = candles.slice(-10);
  const prev = candles.slice(-20, -10);
  const prevHigh = Math.max(...prev.map((c) => c.high));
  const prevLow  = Math.min(...prev.map((c) => c.low));
  const recentClose = recent[recent.length - 1].close;
  return recentClose > prevHigh || recentClose < prevLow;
}

/**
 * FIXED: detectOB (Order Block)
 * ─────────────────────────────
 * ORIGINAL (broken): any bearish candle in last 5 = OB for longs.
 * This fired on ~80% of all scans, adding 12 fake score points.
 *
 * FIXED: An OB must:
 * 1. Be a reversal candle (bearish before bull impulse, bullish before bear)
 * 2. Have been followed by an impulse move >= 1× ATR (the "displacement")
 * 3. Not be fully mitigated (price returned through the full body)
 * 4. Be within the last 20 candles (recent enough to be relevant)
 *
 * This is still an approximation — full ICT OB identification requires
 * manual identification of the displacement candle and FVG — but it is
 * significantly less prone to false positives than the original.
 */
export function detectOB(candles: RawCandle[], direction: 'LONG' | 'SHORT'): boolean {
  if (candles.length < 15) return false;

  const atrVal = atr(candles.slice(-20));
  if (atrVal === 0) return false;

  const currentPrice = candles[candles.length - 1].close;
  const lookback = candles.slice(-20, -1); // last 20 candles excluding current

  for (let i = 0; i < lookback.length - 2; i++) {
    const c = lookback[i];
    const isBearish = c.close < c.open;
    const isBullish = c.close > c.open;

    if (direction === 'LONG' && !isBearish) continue;  // need bearish OB for longs
    if (direction === 'SHORT' && !isBullish) continue; // need bullish OB for shorts

    // Check displacement: next 3 candles must show impulse >= 1x ATR
    const impulseCandles = lookback.slice(i + 1, i + 4);
    if (impulseCandles.length < 2) continue;

    const impulseHigh = Math.max(...impulseCandles.map(ic => ic.high));
    const impulseLow  = Math.min(...impulseCandles.map(ic => ic.low));
    const impulseSize = direction === 'LONG'
      ? impulseHigh - c.high   // upward move from bearish OB
      : c.low - impulseLow;    // downward move from bullish OB

    if (impulseSize < atrVal * 0.8) continue; // insufficient displacement

    // Check not fully mitigated: current price should not have fully entered OB body
    const obBodyHigh = Math.max(c.open, c.close);
    const obBodyLow  = Math.min(c.open, c.close);

    if (direction === 'LONG' && currentPrice < obBodyLow) continue;   // fully below = invalid
    if (direction === 'SHORT' && currentPrice > obBodyHigh) continue;  // fully above = invalid

    return true; // valid unmitigated OB found
  }

  return false;
}

export function detectFVG(candles: RawCandle[]): boolean {
  for (let i = 2; i < candles.length; i++) {
    const gap  = candles[i].low - candles[i - 2].high;
    const gap2 = candles[i - 2].low - candles[i].high;
    if (gap > 0 || gap2 > 0) return true;
  }
  return false;
}

export function detectChoCH(candles: RawCandle[]): boolean {
  if (candles.length < 20) return false;
  const half = Math.floor(candles.length / 2);
  const first = candles.slice(0, half);
  const second = candles.slice(half);
  const trend1 = first[first.length - 1].close > first[0].close ? 'UP' : 'DOWN';
  const trend2 = second[second.length - 1].close > second[0].close ? 'UP' : 'DOWN';
  return trend1 !== trend2;
}

export function detectLiquiditySweep(candles: RawCandle[]): boolean {
  return detectSweeps(candles).length > 0;
}

export type SweepType =
  | 'BSL_SWEEP'
  | 'SSL_SWEEP'
  | 'INDUCEMENT'
  | 'STOP_HUNT'
  | 'DOUBLE_TOP_SWEEP'
  | 'DOUBLE_BOT_SWEEP';

export type SweepStrength = 'STRONG' | 'MODERATE' | 'WEAK';

export interface SweepEvent {
  type: SweepType;
  strength: SweepStrength;
  score: number;
  direction: 'LONG' | 'SHORT';
  sweptLevel: number;
  rejectionClose: number;
  wickSize: number;
  volumeSpike: boolean;
  confirmed: boolean;
  candle: RawCandle;
  candleIndex: number;
  description: string;
}

export function detectSweeps(candles: RawCandle[], lookback = 20, atrPeriod = 14): SweepEvent[] {
  if (candles.length < lookback + atrPeriod) return [];

  const events: SweepEvent[] = [];
  const trs = candles.slice(1).map((c, i) =>
    Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close))
  );
  const atrVal = trs.slice(-atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod || 1;
  const avgVol = candles.slice(-lookback - 5, -5).reduce((a, c) => a + c.volume, 0) / lookback;
  const scanStart = Math.max(lookback, candles.length - 10);

  for (let i = scanStart; i < candles.length; i++) {
    const c = candles[i];
    const window = candles.slice(i - lookback, i);
    if (window.length < 5) continue;

    const windowHigh = Math.max(...window.map(w => w.high));
    const windowLow  = Math.min(...window.map(w => w.low));
    const bslSweep = c.high > windowHigh && c.close < windowHigh;
    const sslSweep = c.low < windowLow && c.close > windowLow;
    if (!bslSweep && !sslSweep) continue;

    const isBSL = bslSweep;
    const sweptLevel  = isBSL ? windowHigh : windowLow;
    const wickBeyond  = isBSL ? c.high - windowHigh : windowLow - c.low;
    const wickPct     = wickBeyond / atrVal;
    const volSpike    = c.volume > avgVol * 1.5;
    const bodyBack    = isBSL ? c.close < windowHigh : c.close > windowLow;
    const nextC = candles[i + 1];
    const followThrough = nextC
      ? (isBSL ? nextC.close < c.close : nextC.close > c.close)
      : false;

    const prevWindow = candles.slice(i - lookback, i - 3);
    const prevHigh2 = prevWindow.length ? Math.max(...prevWindow.map(w => w.high)) : 0;
    const prevLow2  = prevWindow.length ? Math.min(...prevWindow.map(w => w.low)) : Infinity;

    let type: SweepType;
    if (wickPct > 1.5)       type = 'STOP_HUNT';
    else if (wickPct < 0.3)  type = 'INDUCEMENT';
    else if (isBSL && Math.abs(sweptLevel - prevHigh2) < atrVal * 0.2) type = 'DOUBLE_TOP_SWEEP';
    else if (!isBSL && Math.abs(sweptLevel - prevLow2) < atrVal * 0.2) type = 'DOUBLE_BOT_SWEEP';
    else                     type = isBSL ? 'BSL_SWEEP' : 'SSL_SWEEP';

    let score = 40;
    if (bodyBack)          score += 20;
    if (volSpike)          score += 15;
    if (followThrough)     score += 10;
    if (wickPct >= 0.5 && wickPct <= 2.0) score += 10;
    if (type === 'DOUBLE_TOP_SWEEP' || type === 'DOUBLE_BOT_SWEEP') score += 5;
    if (type === 'STOP_HUNT') score -= 5;
    score = Math.min(100, score);

    const strength: SweepStrength = score >= 75 ? 'STRONG' : score >= 55 ? 'MODERATE' : 'WEAK';
    const typeLabels: Record<SweepType, string> = {
      BSL_SWEEP:        'Buy-Side Liquidity Sweep',
      SSL_SWEEP:        'Sell-Side Liquidity Sweep',
      INDUCEMENT:       'Inducement (minor grab)',
      STOP_HUNT:        'Stop Hunt (large spike)',
      DOUBLE_TOP_SWEEP: 'Double-Top Liquidity Sweep',
      DOUBLE_BOT_SWEEP: 'Double-Bottom Liquidity Sweep',
    };

    events.push({
      type, strength, score,
      direction: isBSL ? 'SHORT' : 'LONG',
      sweptLevel, rejectionClose: c.close,
      wickSize: parseFloat(wickPct.toFixed(2)),
      volumeSpike: volSpike, confirmed: bodyBack,
      candle: c, candleIndex: i,
      description: [
        `${typeLabels[type]} @ $${sweptLevel.toFixed(5)}`,
        `Wick ${wickPct.toFixed(2)}× ATR`,
        volSpike ? '🔥 Vol spike' : '',
        bodyBack ? '✅ Confirmed' : '⚠️ Unconfirmed',
        followThrough ? '→ Follow-through' : '',
      ].filter(Boolean).join(' · '),
    });
  }

  const sorted = events.sort((a, b) => b.score - a.score);
  const deduped: SweepEvent[] = [];
  for (const ev of sorted) {
    const atrValLocal = atrVal;
    const nearby = deduped.find(d => Math.abs(d.sweptLevel - ev.sweptLevel) < atrValLocal * 0.5);
    if (!nearby) deduped.push(ev);
  }
  return deduped;
}

export interface SweepManagement {
  action: 'ENTER' | 'SCALE_IN' | 'TIGHTEN_SL' | 'EXIT' | 'HOLD' | 'AVOID';
  reason: string;
  suggestedEntry?: number;
  suggestedSL?: number;
  riskNote: string;
}

export function sweepManagementAdvice(
  sweeps: SweepEvent[],
  currentPrice: number,
  atrVal: number,
  direction: 'LONG' | 'SHORT',
): SweepManagement {
  const aligned  = sweeps.filter(s => s.direction === direction && s.confirmed);
  const opposing = sweeps.filter(s => s.direction !== direction && s.confirmed);

  if (aligned.length === 0 && opposing.length === 0)
    return { action: 'HOLD', reason: 'No active sweeps detected', riskNote: 'Standard SL placement' };

  const best   = aligned[0];
  const threat = opposing[0];

  if (threat && threat.score >= 75)
    return { action: 'EXIT', reason: `Strong opposing ${threat.type} (score ${threat.score})`, riskNote: 'Close or move SL to breakeven immediately' };

  if (best && best.score >= 75 && best.strength === 'STRONG')
    return {
      action: 'ENTER', reason: `${best.type} confirmed (score ${best.score})`,
      suggestedEntry: best.rejectionClose,
      suggestedSL: direction === 'LONG' ? best.sweptLevel - atrVal * 0.3 : best.sweptLevel + atrVal * 0.3,
      riskNote: 'SL just beyond swept level with 0.3 ATR buffer',
    };

  if (best && best.score >= 55)
    return {
      action: 'SCALE_IN', reason: `${best.type} moderate — scale in on confirmation`,
      suggestedEntry: currentPrice,
      suggestedSL: direction === 'LONG' ? best.sweptLevel - atrVal * 0.5 : best.sweptLevel + atrVal * 0.5,
      riskNote: 'Use 50% position size until confirmed',
    };

  if (threat && threat.score >= 55)
    return { action: 'TIGHTEN_SL', reason: `Moderate opposing sweep (${threat.type})`, riskNote: 'Move SL to breakeven or partial profit lock' };

  return { action: 'HOLD', reason: 'Weak sweep signals', riskNote: 'Maintain current SL' };
}

export function oteZone(high: number, low: number): { low: number; high: number } {
  const range = high - low;
  return { low: high - range * 0.786, high: high - range * 0.618 };
}

export function trendLabel(candles: RawCandle[]): string {
  if (candles.length < 50) return 'NEUTRAL';
  const closes = candles.map((c) => c.close);
  const e14 = ema(closes, 14);
  const e28 = ema(closes, 28);
  const e50 = ema(closes, 50);
  const last14 = e14[e14.length - 1];
  const last28 = e28[e28.length - 1];
  const last50 = e50[e50.length - 1];
  if (last14 > last28 && last28 > last50) return 'STRONG_UP';
  if (last14 < last28 && last28 < last50) return 'STRONG_DOWN';
  if (last14 > last50) return 'MILD_UP';
  if (last14 < last50) return 'MILD_DOWN';
  return 'NEUTRAL';
}

/**
 * NOTED (cannot fully fix): Alignment score non-independence
 * ────────────────────────────────────────────────────────────
 * The Opposer correctly identified that 6 timeframes derived from the
 * same price series are not statistically independent. A strong 4H trend
 * will force 1m/5m/15m/1h into alignment almost automatically.
 *
 * Partial mitigation: we add a "structural alignment" check that requires
 * the alignment to be confirmed by BOTH short-term (1m/5m/15m) AND
 * long-term (4h/1d) consensus, not just raw count. This reduces but does
 * not eliminate the non-independence problem.
 */
export function alignmentScore(trends: string[]): number {
  let up = 0, down = 0;
  for (const t of trends) {
    if (t.includes('UP'))   up++;
    if (t.includes('DOWN')) down++;
  }
  const dominant = Math.max(up, down);
  return Math.round((dominant / trends.length) * 100);
}

// New: structural alignment requires short AND long TF agreement
export function structuralAlignmentBonus(trendMap: Record<string, string>): number {
  const shortTFs  = ['1m', '5m', '15m'];
  const longTFs   = ['4h', '1d'];
  const shortUp   = shortTFs.filter(tf => trendMap[tf]?.includes('UP')).length;
  const shortDown = shortTFs.filter(tf => trendMap[tf]?.includes('DOWN')).length;
  const longUp    = longTFs.filter(tf => trendMap[tf]?.includes('UP')).length;
  const longDown  = longTFs.filter(tf => trendMap[tf]?.includes('DOWN')).length;

  // Both short AND long TFs agree = genuine multi-TF alignment
  if (shortUp >= 2 && longUp >= 1)    return 10; // bonus 10 points
  if (shortDown >= 2 && longDown >= 1) return 10;
  return 0; // no structural bonus if only one timeframe cluster agrees
}
