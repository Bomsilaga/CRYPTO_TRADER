/**
 * levels.ts — structural entry / stop / target engine.
 *
 * Entries are NOT price ± ATR. They come from candlestick structure across
 * timeframes: order blocks, fair value gaps, OTE retracements, swing-low
 * retests, breakout retests, VWAP — found on each timeframe (≥50 candles on
 * 1m/5m/15m/1h, ≥20 on 4h/1d), merged into confluence zones, and confirmed
 * by reversal candles (engulfing, pin bar, inside-bar break).
 *
 * Output is an exact advised entry with a mode:
 *   MARKET (in zone, confirmed)  · LIMIT at a pullback zone  · LIMIT at a breakout retest
 * Stops sit beyond the zone and the nearest swing below it (structural
 * invalidation). Targets are liquidity levels (swing highs, equal highs,
 * opposing FVGs, HTF highs) at ≥1R / ≥2R / ≥3R, with an R-multiple fallback
 * that is flagged as such.
 *
 * SHORT is computed by mirroring prices (p → −p), running the LONG logic,
 * and mirroring back — one code path, no sign bugs.
 */
import type { RawCandle } from './bybit';

export type LevelTf = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type SetupStyleName = 'SCALP' | 'INTRADAY' | 'SWING';
export type ZoneKind = 'OB' | 'FVG' | 'OTE' | 'SWING' | 'BREAKOUT' | 'VWAP';
export type EntryMode = 'MARKET' | 'LIMIT';
export type EntryStatus = 'NOW' | 'WAIT_PULLBACK' | 'WAIT_RETEST';

export interface Zone { lo: number; hi: number; tf: LevelTf; kind: ZoneKind; age: number; touches: number; score: number }
export interface Confirmation { pattern: 'ENGULFING' | 'PIN_BAR' | 'INSIDE_BAR_BREAK' | 'DISPLACEMENT'; tf: LevelTf }

export interface StructuralLevels {
  direction: 'LONG' | 'SHORT';
  price: number;
  entry: number;
  entryZone: [number, number];
  entryMode: EntryMode;
  entryStatus: EntryStatus;
  entryBasis: string;
  entryKinds: ZoneKind[];
  entryTfs: LevelTf[];
  confluence: number;
  confirmation: Confirmation | null;
  stop: number;
  stopBasis: string;
  tp1: number; tp2: number; tp3: number;
  targetBasis: [string, string, string];
  rMultiples: { tp1: number; tp2: number; tp3: number };
  fallback: boolean;
  notes: string[];
  windows: Partial<Record<LevelTf, number>>;
  zones: Zone[];          // all candidate entry zones (for display / debugging)
}

const SHORT_TFS: LevelTf[] = ['1m', '5m', '15m', '1h'];
const LONG_TFS: LevelTf[] = ['4h', '1d'];
const MIN_SHORT = 50, MIN_LONG = 20;
const WINDOW: Record<LevelTf, number> = { '1m': 80, '5m': 80, '15m': 80, '1h': 120, '4h': 60, '1d': 40 };
const TF_WEIGHT: Record<LevelTf, number> = { '1m': 0.7, '5m': 0.85, '15m': 1.0, '1h': 1.15, '4h': 1.3, '1d': 1.4 };
const KIND_BASE: Record<ZoneKind, number> = { OB: 3, FVG: 2.5, OTE: 2.5, BREAKOUT: 2, SWING: 1.5, VWAP: 1 };
const STYLE_SETS: Record<SetupStyleName, { entry: LevelTf[]; target: LevelTf[]; maxWaitBars: number }> = {
  SCALP:    { entry: ['1m', '5m', '15m'], target: ['15m', '1h'], maxWaitBars: 6 },
  INTRADAY: { entry: ['15m', '1h', '4h'], target: ['1h', '4h'],  maxWaitBars: 12 },
  SWING:    { entry: ['1h', '4h', '1d'],  target: ['4h', '1d'],  maxWaitBars: 30 },
};

/* ─── helpers ───────────────────────────────────────────────────────────── */

function atrOf(c: RawCandle[], period = 14): number {
  if (c.length < 2) return 0;
  const trs = c.slice(1).map((x, i) => Math.max(x.high - x.low, Math.abs(x.high - c[i].close), Math.abs(x.low - c[i].close)));
  const s = trs.slice(-period);
  return s.reduce((a, b) => a + b, 0) / (s.length || 1);
}

function mirror(c: RawCandle[]): RawCandle[] {
  return c.map(x => ({ time: x.time, open: -x.open, high: -x.low, low: -x.high, close: -x.close, volume: x.volume }));
}

interface Swing { idx: number; price: number }
function swingLows(c: RawCandle[], strength = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = strength; i < c.length - strength; i++) {
    let ok = true;
    for (let k = 1; k <= strength; k++) if (c[i - k].low <= c[i].low || c[i + k].low <= c[i].low) { ok = false; break; }
    if (ok) out.push({ idx: i, price: c[i].low });
  }
  return out;
}
function swingHighs(c: RawCandle[], strength = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = strength; i < c.length - strength; i++) {
    let ok = true;
    for (let k = 1; k <= strength; k++) if (c[i - k].high >= c[i].high || c[i + k].high >= c[i].high) { ok = false; break; }
    if (ok) out.push({ idx: i, price: c[i].high });
  }
  return out;
}

/** Touch/mitigation bookkeeping for a demand zone (LONG frame): later lows entering the zone count as touches; a close below lo mitigates it. */
function zoneState(c: RawCandle[], fromIdx: number, lo: number, hi: number): { touches: number; mitigated: boolean } {
  let touches = 0;
  for (let j = fromIdx; j < c.length; j++) {
    if (c[j].close < lo) return { touches, mitigated: true };
    if (c[j].low <= hi) touches++;
  }
  return { touches, mitigated: false };
}

/* ─── zone finders (LONG frame: demand below / at price) ──────────────── */

function findOB(c: RawCandle[], tf: LevelTf, atr: number, price: number): Zone[] {
  const out: Zone[] = [];
  for (let i = 0; i < c.length - 2; i++) {
    const ob = c[i];
    if (ob.close >= ob.open) continue;                                  // need a bearish candle
    const imp = c.slice(i + 1, i + 4);
    const impHigh = Math.max(...imp.map(x => x.high));
    const disp = impHigh - ob.high;
    const closedAbove = imp.some(x => x.close > ob.high);
    if (disp < atr * 0.8 || !closedAbove) continue;
    const lo = ob.low, hi = Math.max(ob.open, ob.close);                  // wick low → body top
    const st = zoneState(c, i + 4, lo, hi);
    if (st.mitigated || lo > price + atr * 0.05) continue;
    out.push({ lo, hi, tf, kind: 'OB', age: c.length - 1 - i, touches: st.touches, score: 0 });
  }
  return out;
}

function findFVG(c: RawCandle[], tf: LevelTf, atr: number, price: number): Zone[] {
  const out: Zone[] = [];
  for (let i = 2; i < c.length; i++) {
    const lo = c[i - 2].high, hi = c[i].low;
    if (hi - lo < atr * 0.3) continue;
    const st = zoneState(c, i + 1, lo, hi);
    if (st.mitigated || lo > price + atr * 0.05) continue;
    out.push({ lo, hi, tf, kind: 'FVG', age: c.length - 1 - i, touches: st.touches, score: 0 });
  }
  return out;
}

function findSwingRetests(c: RawCandle[], tf: LevelTf, atr: number, price: number): Zone[] {
  return swingLows(c).filter(s => s.price <= price && c.length - 1 - s.idx <= WINDOW[tf])
    .map(s => ({ lo: s.price - atr * 0.1, hi: s.price + atr * 0.25, tf, kind: 'SWING' as const, age: c.length - 1 - s.idx, touches: zoneState(c, s.idx + 3, s.price - atr * 0.1, s.price + atr * 0.25).touches, score: 0 }))
    .filter(z => z.lo <= price + atr * 0.05);
}

function findBreakoutRetest(c: RawCandle[], tf: LevelTf, atr: number, price: number): Zone[] {
  // most recent swing high broken by a close within the last 10 bars, price still above → retest zone
  const highs = swingHighs(c);
  const out: Zone[] = [];
  for (const h of highs) {
    if (h.idx >= c.length - 3) continue;
    const brokeAt = c.findIndex((x, j) => j > h.idx + 2 && x.close > h.price);
    if (brokeAt < 0 || c.length - 1 - brokeAt > 10) continue;
    if (price < h.price) continue;
    out.push({ lo: h.price - atr * 0.2, hi: h.price + atr * 0.15, tf, kind: 'BREAKOUT', age: c.length - 1 - brokeAt, touches: zoneState(c, brokeAt + 1, h.price - atr * 0.2, h.price + atr * 0.15).touches, score: 0 });
  }
  return out;
}

function findOTE(c: RawCandle[], tf: LevelTf, atr: number, price: number): Zone[] {
  // last impulse: most recent swing low → highest high after it, requires price above the 61.8% level
  const lows = swingLows(c);
  if (!lows.length) return [];
  const sl = lows[lows.length - 1];
  const after = c.slice(sl.idx);
  const high = Math.max(...after.map(x => x.high));
  const range = high - sl.price;
  if (range < atr * 1.5) return [];
  const hi = high - range * 0.618, lo = high - range * 0.786;
  if (lo > price + atr * 0.05) return [];
  return [{ lo, hi, tf, kind: 'OTE', age: c.length - 1 - sl.idx, touches: zoneState(c, c.length - 3, lo, hi).touches, score: 0 }];
}

function findVWAP(c: RawCandle[], tf: LevelTf, atr: number, price: number): Zone[] {
  const w = c.slice(-100);
  let pv = 0, v = 0;
  for (const x of w) { const tp = (x.high + x.low + x.close) / 3; pv += tp * x.volume; v += x.volume; }
  if (v <= 0) return [];
  const vw = pv / v;
  if (vw - atr * 0.12 > price + atr * 0.05) return [];
  return [{ lo: vw - atr * 0.12, hi: vw + atr * 0.12, tf, kind: 'VWAP', age: 0, touches: 0, score: 0 }];
}

/* ─── candlestick confirmation (LONG frame) ──────────────────────────── */

function confirmationAt(c: RawCandle[], tf: LevelTf, lo: number, hi: number, atr: number): Confirmation | null {
  const n = c.length;
  for (let i = n - 1; i >= Math.max(1, n - 3); i--) {
    const x = c[i], p = c[i - 1];
    const near = x.low <= hi + atr * 0.2 && x.low >= lo - atr * 0.3;
    if (!near) continue;
    const body = Math.abs(x.close - x.open), range = x.high - x.low || 1e-12;
    const lowerWick = Math.min(x.open, x.close) - x.low;
    if (x.close > x.open && p.close < p.open && x.close > p.open && x.open <= p.close) return { pattern: 'ENGULFING', tf };
    if (lowerWick >= 2 * body && lowerWick >= range * 0.5 && x.close >= x.low + range * 0.6) return { pattern: 'PIN_BAR', tf };
    if (i >= 2) { const pp = c[i - 2]; if (p.high <= pp.high && p.low >= pp.low && x.close > p.high && x.close > x.open) return { pattern: 'INSIDE_BAR_BREAK', tf }; }
    if (x.close > x.open && body >= atr * 0.8 && x.close >= x.low + range * 0.75) return { pattern: 'DISPLACEMENT', tf };
  }
  return null;
}

/* ─── liquidity targets (LONG frame: above entry) ─────────────────────── */

function targetLevels(c: RawCandle[], tf: LevelTf, atr: number, entry: number): { price: number; basis: string }[] {
  const out: { price: number; basis: string }[] = [];
  const highs = swingHighs(c).filter(h => c.length - 1 - h.idx <= WINDOW[tf]);
  for (const h of highs) if (h.price > entry) out.push({ price: h.price, basis: `${tf} swing high` });
  // equal highs → stronger BSL
  for (let i = 0; i < highs.length; i++) for (let j = i + 1; j < highs.length; j++) {
    if (Math.abs(highs[i].price - highs[j].price) <= atr * 0.15 && highs[j].price > entry) out.push({ price: Math.max(highs[i].price, highs[j].price), basis: `${tf} equal highs (BSL)` });
  }
  // bearish FVG (supply) above: its lower edge is a draw
  for (let i = 2; i < c.length; i++) {
    const lo = c[i].high, hi = c[i - 2].low;
    if (hi - lo < atr * 0.3 || lo <= entry) continue;
    if (c.slice(i + 1).some(x => x.close > hi)) continue;
    out.push({ price: lo, basis: `${tf} bearish FVG` });
  }
  if (tf === '1d' || tf === '4h') { const w = c.slice(-WINDOW[tf]); const hh = Math.max(...w.map(x => x.high)); if (hh > entry) out.push({ price: hh, basis: `${tf} range high` }); }
  return out;
}

/* ─── core (LONG frame) ──────────────────────────────────────────────── */

function computeLong(cm: Partial<Record<LevelTf, RawCandle[]>>, price: number, style: SetupStyleName, atrRef: number): StructuralLevels {
  const sets = STYLE_SETS[style];
  const notes: string[] = [];
  const windows: Partial<Record<LevelTf, number>> = {};
  const zones: Zone[] = [];
  const atrByTf: Partial<Record<LevelTf, number>> = {};

  for (const tf of [...SHORT_TFS, ...LONG_TFS]) {
    const all = cm[tf];
    const min = SHORT_TFS.includes(tf) ? MIN_SHORT : MIN_LONG;
    if (!all || all.length < min) continue;
    const c = all.slice(-WINDOW[tf]);
    windows[tf] = c.length;
    const a = atrOf(c) || atrRef;
    atrByTf[tf] = a;
    const found = [...findOB(c, tf, a, price), ...findFVG(c, tf, a, price), ...findOTE(c, tf, a, price), ...findSwingRetests(c, tf, a, price), ...findBreakoutRetest(c, tf, a, price), ...findVWAP(c, tf, a, price)];
    for (const z of found) {
      const inZone = price >= z.lo && price <= z.hi;
      const d = inZone ? 0 : (price - z.hi) / atrRef;
      if (d > 3) continue;
      const fresh = z.touches === 0 ? 1 : z.touches === 1 ? 0.8 : 0.5;
      const ageF = z.age <= 30 ? 1 : 0.8;
      const distF = d <= 0.5 ? 1 : d <= 1.5 ? 0.9 : 0.7;
      const setF = sets.entry.includes(tf) ? 1.25 : 1;
      z.score = KIND_BASE[z.kind] * TF_WEIGHT[tf] * setF * fresh * ageF * distF;
      zones.push(z);
    }
  }

  // merge overlapping zones into confluence clusters
  type Cluster = { lo: number; hi: number; score: number; members: Zone[] };
  const sorted = [...zones].sort((a, b) => b.score - a.score);
  const clusters: Cluster[] = [];
  for (const z of sorted) {
    const hit = clusters.find(k => Math.min(k.hi, z.hi) - Math.max(k.lo, z.lo) >= 0.3 * Math.min(k.hi - k.lo, z.hi - z.lo));
    if (hit) { hit.lo = Math.min(hit.lo, z.lo); hit.hi = Math.max(hit.hi, z.hi); if (hit.hi - hit.lo > atrRef) { hit.hi = Math.min(hit.hi, hit.lo + atrRef); } hit.score += z.score; hit.members.push(z); }
    else clusters.push({ lo: z.lo, hi: z.hi, score: z.score, members: [z] });
  }
  clusters.sort((a, b) => b.score - a.score);
  const best = clusters[0] ?? null;

  let entry: number, entryZone: [number, number], entryMode: EntryMode, entryStatus: EntryStatus, entryBasis: string, fallback = false;
  let confirmation: Confirmation | null = null;
  let entryKinds: ZoneKind[] = [], entryTfs: LevelTf[] = [], confluence = 0;

  if (best) {
    entryKinds = [...new Set(best.members.map(m => m.kind))];
    entryTfs = [...new Set(best.members.map(m => m.tf))];
    confluence = best.members.length;
    for (const tf of sets.entry) { const c = cm[tf]; if (c && c.length >= 5) { confirmation = confirmationAt(c.slice(-WINDOW[tf]), tf, best.lo, best.hi, atrByTf[tf] ?? atrRef); if (confirmation) break; } }
    const inZone = price >= best.lo && price <= best.hi;
    entryZone = [best.lo, best.hi];
    const label = `${entryKinds.join('+')} ${entryTfs.join('/')}`;
    if (inZone && confirmation) { entry = price; entryMode = 'MARKET'; entryStatus = 'NOW'; entryBasis = `Price inside ${label} zone with ${confirmation.pattern.toLowerCase().replace('_', ' ')} on ${confirmation.tf} — enter at market.`; }
    else if (inZone) { entry = best.lo + (best.hi - best.lo) * 0.5; entryMode = 'LIMIT'; entryStatus = 'NOW'; entryBasis = `Price inside ${label} zone, no confirmation candle yet — limit at zone midpoint; a reversal candle on ${sets.entry.join('/')} upgrades this to market.`; }
    else if (entryKinds.includes('BREAKOUT') && entryKinds.length === 1) { entry = best.hi; entryMode = 'LIMIT'; entryStatus = 'WAIT_RETEST'; entryBasis = `Structure broke above ${best.hi.toFixed(6).replace(/0+$/, '')} — wait for the retest of the broken level (${label}) and buy the first touch.`; }
    else { entry = best.hi; entryMode = 'LIMIT'; entryStatus = 'WAIT_PULLBACK'; entryBasis = `Pullback entry: limit at the top of the ${label} zone (${((price - best.hi) / price * 100).toFixed(2)}% below price). Do not chase.`; }
    if (confluence >= 3) notes.push(`${confluence} structural elements overlap here (${label}).`);
  } else {
    fallback = true;
    const c = cm[sets.entry[1]] ?? cm['1h'] ?? [];
    const last3 = c.slice(-3);
    const momentum = last3.length === 3 && last3.every((x, i) => i === 0 || x.close > last3[i - 1].close) && last3[2].close > last3[2].open;
    if (momentum) { entry = price; entryMode = 'MARKET'; entryStatus = 'NOW'; entryZone = [price - atrRef * 0.25, price]; entryBasis = 'No structure within 3 ATR below price; momentum continuation at market — reduce size.'; }
    else { entry = price - atrRef * 0.5; entryMode = 'LIMIT'; entryStatus = 'WAIT_PULLBACK'; entryZone = [price - atrRef * 0.75, price - atrRef * 0.25]; entryBasis = 'No structure within 3 ATR below price — ATR pullback fallback (flagged).'; }
    notes.push('ATR fallback used for entry: structure not found in the lookback windows.');
  }

  // stop: beyond zone low and the nearest swing low below it (on entry TFs)
  const buffer = Math.max(atrRef * 0.15, price * 0.0008);
  let stop = entryZone[0] - buffer;
  let stopBasis = `below ${entryKinds.length ? entryKinds.join('+') : 'entry'} zone low (${entryZone[0].toFixed(6).replace(/0+$/, '')}) + ${(buffer / price * 100).toFixed(2)}% buffer`;
  for (const tf of sets.entry) {
    const c = cm[tf];
    if (!c) continue;
    const w = c.slice(-WINDOW[tf]);
    const below = swingLows(w).map(s => s.price).filter(p => p < entryZone[0] && entryZone[0] - p <= atrRef * 2);
    if (below.length) { const s = Math.max(...below) - buffer; if (s < stop) { stop = s; stopBasis = `below ${tf} swing low ${Math.max(...below).toFixed(6).replace(/0+$/, '')} (structural invalidation) + buffer`; } }
  }
  if (entry - stop > atrRef * 3.5) { stop = entryZone[0] - buffer; stopBasis += ' (swing extension skipped: > 3.5 ATR)'; }
  if (entry - stop < atrRef * 0.35) { stop = entry - atrRef * 0.35; stopBasis = 'minimum 0.35 ATR stop (zone too tight)'; notes.push('Stop widened to 0.35 ATR minimum.'); }
  const risk = entry - stop;

  // targets from liquidity on target TFs
  const cands: { price: number; basis: string }[] = [];
  for (const tf of sets.target) { const c = cm[tf]; if (c && c.length >= 10) cands.push(...targetLevels(c.slice(-WINDOW[tf]), tf, atrByTf[tf] ?? atrRef, entry)); }
  cands.sort((a, b) => a.price - b.price);
  const pick = (minR: number, above: number): { price: number; basis: string } | null => {
    const lv = cands.find(x => x.price - atrRef * 0.1 >= entry + minR * risk && x.price - atrRef * 0.1 > above);
    return lv ? { price: lv.price - atrRef * 0.1, basis: `${lv.basis} (front-run 0.1 ATR)` } : null;
  };
  const t1 = pick(1.0, entry) ?? { price: entry + 1.0 * risk, basis: 'R-multiple fallback (1R)' };
  const t2 = pick(2.0, t1.price + 0.3 * risk) ?? { price: Math.max(entry + 2.0 * risk, t1.price + 0.5 * risk), basis: 'R-multiple fallback (2R)' };
  const t3 = pick(3.0, t2.price + 0.3 * risk) ?? { price: Math.max(entry + 3.5 * risk, t2.price + 0.5 * risk), basis: 'R-multiple fallback (3.5R)' };
  if ([t1, t2, t3].every(t => t.basis.startsWith('R-multiple'))) notes.push('No liquidity targets found in target windows — R-multiple targets used.');

  return {
    direction: 'LONG', price, entry, entryZone, entryMode, entryStatus, entryBasis, entryKinds, entryTfs, confluence, confirmation,
    stop, stopBasis, tp1: t1.price, tp2: t2.price, tp3: t3.price, targetBasis: [t1.basis, t2.basis, t3.basis],
    rMultiples: { tp1: (t1.price - entry) / risk, tp2: (t2.price - entry) / risk, tp3: (t3.price - entry) / risk },
    fallback, notes, windows, zones,
  };
}

/* ─── public API ─────────────────────────────────────────────────────── */

export function structuralLevels(opts: {
  candleMap: Partial<Record<LevelTf, RawCandle[]>>;
  direction: 'LONG' | 'SHORT';
  price: number;
  style: SetupStyleName;
  atr?: number;              // reference ATR (1h). Computed from 1h candles when omitted.
}): StructuralLevels {
  const { candleMap, direction, price, style } = opts;
  const atrRef = opts.atr && opts.atr > 0 ? opts.atr : atrOf((candleMap['1h'] ?? candleMap['15m'] ?? []).slice(-120)) || price * 0.01;
  if (direction === 'LONG') return computeLong(candleMap, price, style, atrRef);
  const m: Partial<Record<LevelTf, RawCandle[]>> = {};
  for (const tf of Object.keys(candleMap) as LevelTf[]) m[tf] = mirror(candleMap[tf]!);
  const r = computeLong(m, -price, style, atrRef);
  const neg = (x: number) => -x;
  return {
    ...r,
    direction: 'SHORT', price,
    entry: neg(r.entry), entryZone: [neg(r.entryZone[1]), neg(r.entryZone[0])],
    stop: neg(r.stop), tp1: neg(r.tp1), tp2: neg(r.tp2), tp3: neg(r.tp3),
    zones: r.zones.map(z => ({ ...z, lo: neg(z.hi), hi: neg(z.lo) })),
    entryBasis: r.entryBasis.replace('below price', 'above price').replace('buy the first touch', 'sell the first touch').replace('broke above', 'broke below').replace('at the top of', 'at the bottom of').replace(/-?\d+\.\d+(?=% above price| ?— wait)/, m0 => String(Math.abs(Number(m0)))),
    stopBasis: r.stopBasis.replace('below', 'above').replace('swing low', 'swing high').replace('zone low', 'zone high'),
    targetBasis: r.targetBasis.map(b => b.replace('swing high', 'swing low').replace('equal highs (BSL)', 'equal lows (SSL)').replace('bearish FVG', 'bullish FVG').replace('range high', 'range low')) as [string, string, string],
    notes: r.notes,
  };
}

/** Bars a limit entry is allowed to wait for a fill, per style (used by the replay engine and the manage route). */
export const MAX_WAIT_BARS: Record<SetupStyleName, number> = { SCALP: STYLE_SETS.SCALP.maxWaitBars, INTRADAY: STYLE_SETS.INTRADAY.maxWaitBars, SWING: STYLE_SETS.SWING.maxWaitBars };
