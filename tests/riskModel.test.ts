import { describe, it, expect } from 'vitest';
import { computeRiskModel } from '../src/lib/risk/riskModel';

describe('risk model — position sizing', () => {
  const base = { capital: 5000, riskPct: 1, entry: 0.21, stopLoss: 0.208, tp1: 0.214, tp2: 0.218, tp3: 0.223, direction: 'LONG' as const, orderType: 'Limit' as const };
  it('qty = risk / |entry - stop|, independent of leverage', () => {
    const a = computeRiskModel({ ...base, leverage: 3 });
    const b = computeRiskModel({ ...base, leverage: 5 });
    expect(a.riskAmount).toBeCloseTo(50, 6);
    expect(a.qty).toBeCloseTo(50 / 0.002, 3);
    expect(a.qty).toBeCloseTo(b.qty, 6);
    expect(a.notional).toBeCloseTo(5250, 0);
    expect(a.margin.x3).toBeCloseTo(1750, 0);
    expect(a.margin.x5).toBeCloseTo(1050, 0);
    expect(a.margin.atLeverage).not.toBeCloseTo(b.margin.atLeverage, 0);
  });
  it('net loss at stop exceeds the raw risk by fees + slippage', () => {
    const m = computeRiskModel({ ...base, leverage: 3 });
    expect(m.gross.stop).toBeCloseTo(-50, 2);
    expect(m.net.stop).toBeLessThan(-50);
    expect(m.net.stop).toBeGreaterThan(-60);
    expect(m.net.tp1Full).toBeGreaterThan(0);
    expect(m.net.tp2Full).toBeGreaterThan(m.net.tp1Full);
    expect(m.net.staged).toBeLessThan(m.net.tp3Full);
  });
  it('flags liquidation too close to the stop and computes max safe leverage', () => {
    const wide = computeRiskModel({ ...base, stopLoss: 0.19, leverage: 10 }); // ~9.5% stop, 10× liq at 9.5%
    expect(wide.liquidation.safe).toBe(false);
    expect(wide.liquidation.maxSafeLeverage).toBeLessThan(10);
    const ok = computeRiskModel({ ...base, leverage: 3 });
    expect(ok.liquidation.safe).toBe(true);
  });
  it('rejects a stop on the wrong side', () => {
    expect(() => computeRiskModel({ ...base, stopLoss: 0.22, leverage: 3 })).toThrow();
  });
});
