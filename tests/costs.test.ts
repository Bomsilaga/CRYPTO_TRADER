import { describe, it, expect } from 'vitest';
import { computeCosts } from '../src/lib/history/costs';
import { EXECUTION_PROFILES } from '../src/lib/history/types';

describe('transaction cost model', () => {
  const profile = EXECUTION_PROFILES.conservative;
  it('charges fees on partial exit sizes, not full position per exit', () => {
    const c = computeCosts({ entry: 100, direction: 'LONG', stopDistancePct: 0.02, profile, fills: [
      { price: 100, fraction: 1, kind: 'entry' }, { price: 102, fraction: 0.5, kind: 'tp' }, { price: 104, fraction: 0.25, kind: 'tp' }, { price: 106.5, fraction: 0.25, kind: 'tp' },
    ] });
    const expectedFees = profile.entryFee * 1 + profile.tpFee * (1.02 * 0.5 + 1.04 * 0.25 + 1.065 * 0.25);
    expect(c.feesNotionalFrac).toBeCloseTo(expectedFees, 10);
    expect(c.feesR).toBeCloseTo(expectedFees / 0.02, 8);
    // naive "3 × full-position fee" would be much larger
    expect(c.feesNotionalFrac).toBeLessThan(profile.entryFee + 3 * profile.tpFee);
  });
  it('applies slippage to taker fills only and funding by open fraction with correct sign', () => {
    const pts = [{ time: 10, rate: 0.0001 }, { time: 20, rate: 0.0001 }, { time: 30, rate: 0.0001 }];
    const fractionAt = (t: number) => (t < 15 ? 1 : t < 25 ? 0.5 : 0);
    const long = computeCosts({ entry: 100, direction: 'LONG', stopDistancePct: 0.02, profile, fills: [{ price: 100, fraction: 1, kind: 'entry' }, { price: 98, fraction: 1, kind: 'stop' }], funding: { points: pts, openTime: 0, closeTime: 40, fractionAt } });
    expect(long.fundingNotionalFrac).toBeCloseTo(0.0001 * 1 + 0.0001 * 0.5, 12);
    const short = computeCosts({ entry: 100, direction: 'SHORT', stopDistancePct: 0.02, profile, fills: [{ price: 100, fraction: 1, kind: 'entry' }, { price: 102, fraction: 1, kind: 'stop' }], funding: { points: pts, openTime: 0, closeTime: 40, fractionAt } });
    expect(short.fundingNotionalFrac).toBeCloseTo(-(0.0001 * 1.5), 12);
    expect(long.slippageNotionalFrac).toBeCloseTo(profile.slippageBps / 10_000 * (1 + 0.98), 10);
    const maker = computeCosts({ entry: 100, direction: 'LONG', stopDistancePct: 0.02, profile: EXECUTION_PROFILES.base, fills: [{ price: 100, fraction: 1, kind: 'entry' }, { price: 102, fraction: 1, kind: 'tp' }] });
    expect(maker.slippageNotionalFrac).toBe(0);
  });
});
