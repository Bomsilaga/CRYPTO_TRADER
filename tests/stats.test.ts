import { describe, it, expect } from 'vitest';
import { wilson, sampleQuality, summarize, walkForward, decay, btcSplit } from '../src/lib/history/stats';
import { trade } from './fixtures';

describe('statistics', () => {
  it('Wilson interval matches known values (50/74 → 56.3–77.2%)', () => {
    const ci = wilson(50, 74);
    expect(ci.low).toBeCloseTo(0.563, 2);
    expect(ci.high).toBeCloseTo(0.772, 2);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 0 });
  });
  it('sample quality thresholds', () => {
    expect(sampleQuality(19)).toBe('INSUFFICIENT');
    expect(sampleQuality(20)).toBe('VERY LOW EVIDENCE');
    expect(sampleQuality(50)).toBe('LOW EVIDENCE');
    expect(sampleQuality(100)).toBe('MODERATE');
    expect(sampleQuality(250)).toBe('GOOD');
    expect(sampleQuality(500)).toBe('STRONGER EVIDENCE');
  });
  it('expectancy, profit factor, MFE/MAE, drawdown and streaks', () => {
    const ts = [
      trade({ netR: 2, mfeR: 2.5, maeR: 0.3, tp1Hit: true, tp2Hit: true, firstOutcome: 'TP1' }),
      trade({ netR: -1, mfeR: 0.4, maeR: 1, tp1Hit: false, tp2Hit: false, firstOutcome: 'STOP', time: 1 }),
      trade({ netR: -1, mfeR: 0.2, maeR: 1, tp1Hit: false, tp2Hit: false, firstOutcome: 'STOP', time: 2 }),
      trade({ netR: 1.5, mfeR: 2, maeR: 0.5, tp1Hit: true, tp2Hit: false, firstOutcome: 'TP1', time: 3 }),
    ];
    const s = summarize(ts);
    expect(s.n).toBe(4);
    expect(s.expectancyR).toBeCloseTo(0.375, 6);
    expect(s.profitFactor).toBeCloseTo(3.5 / 2, 6);
    expect(s.tp1.rate).toBe(0.5);
    expect(s.tp2.rate).toBe(0.25);
    expect(s.stopFirst.rate).toBe(0.5);
    expect(s.avgMfeR).toBeCloseTo((2.5 + 0.4 + 0.2 + 2) / 4, 6);
    expect(s.avgMaeR).toBeCloseTo((0.3 + 1 + 1 + 0.5) / 4, 6);
    expect(s.maxDrawdownR).toBeCloseTo(2, 6);
    expect(s.maxConsecutiveLosses).toBe(2);
    expect(s.netCumulativeR).toBeCloseTo(1.5, 6);
  });
  it('walk-forward never lets validation trades into training and pools OOS months', () => {
    const start = Date.UTC(2024, 0, 1);
    const ts = Array.from({ length: 400 }, (_, i) => trade({ time: start + i * 86_400_000, score: 50 + (i % 5) * 10, netR: (i % 3 === 0 ? -1 : 0.9) }));
    const wf = walkForward(ts);
    expect(wf.folds.length).toBeGreaterThan(3);
    for (const f of wf.folds) {
      expect(f.testFrom).toBe(f.trainTo);
      expect(f.inSample.lastTime! < f.testFrom).toBe(true);
      expect(f.validation.firstTime! >= f.testFrom).toBe(true);
      expect([50, 60, 70, 80]).toContain(f.chosenMinScore);
    }
    expect(wf.outOfSample.n).toBeGreaterThan(0);
    expect(wf.outOfSample.n).toBeLessThan(ts.length);
  });
  it('decay flags weakening and negative recent edge', () => {
    const start = Date.UTC(2024, 0, 1);
    const good = Array.from({ length: 100 }, (_, i) => trade({ time: start + i * 3_600_000, netR: 0.5 }));
    const bad = Array.from({ length: 50 }, (_, i) => trade({ time: start + (100 + i) * 3_600_000, netR: -0.3 }));
    expect(decay(good, start + 200 * 3_600_000).status).toBe('STABLE');
    expect(decay([...good, ...bad], start + 200 * 3_600_000).status).toBe('EDGE NEGATIVE');
    expect(decay(good.slice(0, 30)).status).toBe('INSUFFICIENT');
  });
  it('BTC split only supports a sizing rule with adequate samples and a material gap', () => {
    const aligned = Array.from({ length: 60 }, (_, i) => trade({ time: i, netR: 0.6, features: { btcRegime: 'BULL' } }));
    const opposed = Array.from({ length: 60 }, (_, i) => trade({ time: 1000 + i, netR: -0.2, features: { btcRegime: 'BEAR' } }));
    expect(btcSplit([...aligned, ...opposed], 'LONG').evidenceSupportsSizingRule).toBe(true);
    expect(btcSplit([...aligned.slice(0, 10), ...opposed], 'LONG').evidenceSupportsSizingRule).toBe(false);
  });
});
