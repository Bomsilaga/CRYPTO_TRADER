/**
 * history/outcome.ts — walk a replayed trade forward through future candles.
 *
 * Staged exits: TP1 (50%) → TP2 (25%) → TP3 (25%). After TP1, the stop moves
 * to entry when config.moveStopToBreakevenAfterTP1 is true.
 *
 * SAME-CANDLE AMBIGUITY (documented): when one candle touches both a target
 * and the stop we do NOT credit the target. We descend to the lowest available
 * timeframe inside that candle to find which was touched first. If the lowest
 * available candle is still ambiguous, STOP is assumed to have come first.
 */
import type { BacktestConfig, FirstOutcome, StoredCandle, Timeframe } from './types';
import { TF_MS, TF_ORDER } from './types';
import { candlesBetween } from './resample';
import type { Fill } from './costs';

export interface Levels { entry: number; stopLoss: number; tp1: number; tp2: number; tp3: number }

export interface OutcomeResult {
  tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean; stopHit: boolean;
  firstOutcome: FirstOutcome;
  finalExit: 'TP3' | 'STOP' | 'BREAKEVEN' | 'TIMEOUT';
  mfePct: number; maePct: number; mfeR: number; maeR: number;
  timeToTP1: number | null; timeToTP2: number | null; timeToTP3: number | null; timeToStop: number | null;
  holdMs: number;
  closeTime: number;
  fills: Fill[];                 // exits only (entry added by caller)
  fractionAt: (t: number) => number;
  ambiguousCandles: number;
  ambiguityResolvedBy: 'lower-tf' | 'conservative' | 'none';
}

interface Walker {
  dir: 1 | -1;
  entry: number;
  stop: number;
  nextTp: 1 | 2 | 3 | null;
  levels: Levels;
}

function touched(w: Walker, c: StoredCandle, ignoreStop = false): { tp: boolean; sl: boolean } {
  const tpPrice = w.nextTp === 1 ? w.levels.tp1 : w.nextTp === 2 ? w.levels.tp2 : w.nextTp === 3 ? w.levels.tp3 : null;
  const tp = tpPrice !== null && (w.dir === 1 ? c.high >= tpPrice : c.low <= tpPrice);
  const sl = !ignoreStop && (w.dir === 1 ? c.low <= w.stop : c.high >= w.stop);
  return { tp, sl };
}

/** Resolve order of TP vs SL inside candle `c` of timeframe `tf` using lower timeframes. */
function resolveInside(
  w: Walker, c: StoredCandle, tf: Timeframe, lower: Partial<Record<Timeframe, StoredCandle[]>>,
): { first: 'TP' | 'SL'; by: 'lower-tf' | 'conservative'; time: number } {
  const idx = TF_ORDER.indexOf(tf);
  for (let i = idx - 1; i >= 0; i--) {
    const ltf = TF_ORDER[i];
    const arr = lower[ltf];
    if (!arr?.length) continue;
    const inside = candlesBetween(arr, c.time, c.time + TF_MS[tf]);
    if (!inside.length) continue;
    for (const lc of inside) {
      const t = touched(w, lc);
      if (t.tp && !t.sl) return { first: 'TP', by: 'lower-tf', time: lc.time + TF_MS[ltf] };
      if (t.sl && !t.tp) return { first: 'SL', by: 'lower-tf', time: lc.time + TF_MS[ltf] };
      if (t.tp && t.sl) return resolveInside(w, lc, ltf, lower);
    }
    // lower TF candles exist but none touched (data gap) → fall through to conservative
    break;
  }
  return { first: 'SL', by: 'conservative', time: c.time + TF_MS[tf] };
}

export function resolveOutcome(opts: {
  direction: 'LONG' | 'SHORT';
  levels: Levels;
  decisionTime: number;
  future: StoredCandle[];                                  // decision-TF candles opening at/after decisionTime, ascending
  decisionTf: Timeframe;
  lower: Partial<Record<Timeframe, StoredCandle[]>>;      // lower-TF candles for ambiguity resolution
  timeoutBars: number;
  config: Pick<BacktestConfig, 'tpSplit' | 'moveStopToBreakevenAfterTP1'>;
}): OutcomeResult {
  const { direction, levels, decisionTime, future, decisionTf, lower, timeoutBars, config } = opts;
  const dir: 1 | -1 = direction === 'LONG' ? 1 : -1;
  const riskPerUnit = Math.abs(levels.entry - levels.stopLoss);
  const w: Walker = { dir, entry: levels.entry, stop: levels.stopLoss, nextTp: 1, levels };
  const fills: Fill[] = [];
  const fractionEvents: { time: number; fraction: number }[] = [{ time: decisionTime, fraction: 1 }];
  let fraction = 1;
  let mfe = 0, mae = 0;
  let tp1Hit = false, tp2Hit = false, tp3Hit = false, stopHit = false;
  let timeToTP1: number | null = null, timeToTP2: number | null = null, timeToTP3: number | null = null, timeToStop: number | null = null;
  let firstOutcome: FirstOutcome | null = null;
  let finalExit: OutcomeResult['finalExit'] = 'TIMEOUT';
  let ambiguousCandles = 0;
  let ambiguityResolvedBy: OutcomeResult['ambiguityResolvedBy'] = 'none';
  let closeTime = decisionTime;
  const tpFrac = [config.tpSplit[0], config.tpSplit[1], config.tpSplit[2]];
  const step = TF_MS[decisionTf];

  const recordExit = (price: number, frac: number, kind: Fill['kind'], time: number) => {
    fills.push({ price, fraction: frac, kind });
    fraction = Math.max(0, fraction - frac);
    fractionEvents.push({ time, fraction });
    closeTime = time;
  };

  const bars = future.slice(0, timeoutBars);
  for (const c of bars) {
    // excursions are measured on the full candle range (before deciding exits)
    const fav = dir === 1 ? (c.high - levels.entry) : (levels.entry - c.low);
    const adv = dir === 1 ? (levels.entry - c.low) : (c.high - levels.entry);
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;

    // a single candle may hit several levels in sequence (e.g. TP1 then TP2). Loop until nothing more triggers.
    // Once a target has filled inside this candle, a stop moved to breakeven is NOT re-tested against the same
    // candle (its low may precede the target). Stop checks resume on the next candle.
    let guard = 0;
    let tpFilledThisCandle = false;
    while (fraction > 0 && guard++ < 4) {
      const t = touched(w, c, tpFilledThisCandle);
      if (!t.tp && !t.sl) break;
      let first: 'TP' | 'SL';
      let at = c.time + step;
      if (t.tp && t.sl) {
        ambiguousCandles++;
        const r = resolveInside(w, c, decisionTf, lower);
        first = r.first; at = r.time;
        if (ambiguityResolvedBy !== 'conservative') ambiguityResolvedBy = r.by;
        if (r.by === 'conservative') ambiguityResolvedBy = 'conservative';
      } else first = t.tp ? 'TP' : 'SL';

      if (first === 'SL') {
        const isBE = config.moveStopToBreakevenAfterTP1 && tp1Hit;
        if (!isBE) stopHit = true;
        if (timeToStop === null) timeToStop = at - decisionTime;
        if (firstOutcome === null) firstOutcome = 'STOP';
        recordExit(w.stop, fraction, 'stop', at);
        finalExit = isBE ? 'BREAKEVEN' : 'STOP';
        break;
      }
      // TP
      const lvl = w.nextTp!;
      const price = lvl === 1 ? levels.tp1 : lvl === 2 ? levels.tp2 : levels.tp3;
      const frac = Math.min(fraction, tpFrac[lvl - 1]);
      recordExit(price, frac, 'tp', at);
      tpFilledThisCandle = true;
      if (lvl === 1) { tp1Hit = true; timeToTP1 = at - decisionTime; if (firstOutcome === null) firstOutcome = 'TP1'; if (config.moveStopToBreakevenAfterTP1) w.stop = levels.entry; w.nextTp = 2; }
      else if (lvl === 2) { tp2Hit = true; timeToTP2 = at - decisionTime; w.nextTp = 3; }
      else { tp3Hit = true; timeToTP3 = at - decisionTime; w.nextTp = null; finalExit = 'TP3'; }
      if (fraction <= 1e-9) { fraction = 0; break; }
    }
    if (fraction <= 0) break;
  }

  if (fraction > 0) {
    const last = bars[bars.length - 1];
    const at = last ? last.time + step : decisionTime;
    recordExit(last ? last.close : levels.entry, fraction, 'timeout', at);
    if (firstOutcome === null) firstOutcome = 'TIMEOUT';
    finalExit = 'TIMEOUT';
  }

  const fractionAt = (t: number) => {
    let f = 1;
    for (const e of fractionEvents) { if (e.time <= t) f = e.fraction; else break; }
    return f;
  };
  const pctOf = (x: number) => (x / levels.entry) * 100;
  return {
    tp1Hit, tp2Hit, tp3Hit, stopHit,
    firstOutcome: firstOutcome ?? 'TIMEOUT',
    finalExit,
    mfePct: pctOf(mfe), maePct: pctOf(mae),
    mfeR: riskPerUnit > 0 ? mfe / riskPerUnit : 0, maeR: riskPerUnit > 0 ? mae / riskPerUnit : 0,
    timeToTP1, timeToTP2, timeToTP3, timeToStop,
    holdMs: closeTime - decisionTime,
    closeTime,
    fills, fractionAt,
    ambiguousCandles, ambiguityResolvedBy,
  };
}

/** Gross R from fills (exits) relative to entry and stop distance. */
export function grossRFromFills(direction: 'LONG' | 'SHORT', entry: number, stop: number, fills: Fill[]): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  const dir = direction === 'LONG' ? 1 : -1;
  return fills.filter(f => f.kind !== 'entry').reduce((a, f) => a + (f.fraction * (f.price - entry) * dir) / risk, 0);
}
