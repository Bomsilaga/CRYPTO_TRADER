import { describe, it, expect } from 'vitest';
import { resolveOutcome } from '../src/lib/history/outcome';
import type { StoredCandle } from '../src/lib/history/types';

const H = 3_600_000, M15 = 900_000;
const c = (time: number, o: number, h: number, l: number, cl: number): StoredCandle => ({ time, open: o, high: h, low: l, close: cl, volume: 1 });
const levels = { entry: 100, stopLoss: 98, tp1: 102, tp2: 104, tp3: 106.5 };
const cfg = { tpSplit: [0.5, 0.25, 0.25] as [number, number, number], moveStopToBreakevenAfterTP1: true };
const t0 = 0;

describe('outcome resolution', () => {
  it('same-candle TP+SL with no lower timeframe → conservative STOP first', () => {
    const future = [c(t0, 100, 103, 97, 100)];
    const r = resolveOutcome({ direction: 'LONG', levels, decisionTime: t0, future, decisionTf: '1h', lower: {}, timeoutBars: 10, config: cfg });
    expect(r.firstOutcome).toBe('STOP');
    expect(r.tp1Hit).toBe(false);
    expect(r.ambiguousCandles).toBe(1);
    expect(r.ambiguityResolvedBy).toBe('conservative');
    expect(r.fills[0].kind).toBe('stop');
  });
  it('same-candle ambiguity resolved by lower timeframe when TP printed first', () => {
    const future = [c(t0, 100, 103, 97, 100), c(t0 + H, 100, 101, 99, 100)];
    const lower15 = [c(t0, 100, 102.5, 99.5, 102), c(t0 + M15, 102, 103, 100, 100.5), c(t0 + 2 * M15, 100.5, 101, 97, 98), c(t0 + 3 * M15, 98, 100, 97.5, 100)];
    const r = resolveOutcome({ direction: 'LONG', levels, decisionTime: t0, future, decisionTf: '1h', lower: { '15m': lower15 }, timeoutBars: 10, config: cfg });
    expect(r.firstOutcome).toBe('TP1');
    expect(r.tp1Hit).toBe(true);
    expect(r.ambiguityResolvedBy).toBe('lower-tf');
    // after TP1 the stop moves to breakeven; the later drop to 97 exits the rest at entry
    expect(r.finalExit).toBe('BREAKEVEN');
    expect(r.stopHit).toBe(false);
    expect(r.fills.map(f => f.kind)).toEqual(['tp', 'stop']);
    expect(r.fills[0].fraction).toBe(0.5);
  });
  it('staged exits: TP1 → TP2 → TP3 across candles with correct fractions, MFE/MAE in R', () => {
    const future = [c(t0, 100, 102.5, 99.5, 102), c(t0 + H, 102, 104.5, 101, 104), c(t0 + 2 * H, 104, 107, 103, 106)];
    const r = resolveOutcome({ direction: 'LONG', levels, decisionTime: t0, future, decisionTf: '1h', lower: {}, timeoutBars: 10, config: cfg });
    expect(r.tp1Hit && r.tp2Hit && r.tp3Hit).toBe(true);
    expect(r.finalExit).toBe('TP3');
    expect(r.fills.map(f => f.fraction)).toEqual([0.5, 0.25, 0.25]);
    expect(r.mfeR).toBeCloseTo(7 / 2, 6);
    expect(r.maeR).toBeCloseTo(0.5 / 2, 6);
    expect(r.timeToTP3).toBe(3 * H);
  });
  it('timeout closes the remainder at the last close', () => {
    const future = Array.from({ length: 5 }, (_, i) => c(t0 + i * H, 100, 101, 99, 100.5));
    const r = resolveOutcome({ direction: 'LONG', levels, decisionTime: t0, future, decisionTf: '1h', lower: {}, timeoutBars: 3, config: cfg });
    expect(r.firstOutcome).toBe('TIMEOUT');
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0].kind).toBe('timeout');
    expect(r.holdMs).toBe(3 * H);
  });
  it('SHORT direction mirrors correctly', () => {
    const lv = { entry: 100, stopLoss: 102, tp1: 98, tp2: 96, tp3: 93.5 };
    const future = [c(t0, 100, 100.5, 97.5, 98)];
    const r = resolveOutcome({ direction: 'SHORT', levels: lv, decisionTime: t0, future, decisionTf: '1h', lower: {}, timeoutBars: 5, config: cfg });
    expect(r.firstOutcome).toBe('TP1');
  });
});
