import { describe, it, expect } from 'vitest';
import { checkHardLimits, DEFAULT_LIMITS, loadLimits } from '../src/lib/risk/limits';

const ok = { equity: 5000, riskPct: 1, riskUsd: 50, leverage: 3, notional: 5000, openPositions: 0, openRiskUsd: 0, dailyRealizedPnlUsd: 0, tradesToday: 0, stopDistancePct: 0.01, liqDistancePct: 0.328, symbol: 'EIGENUSDT', openSymbols: [] as string[] };

describe('hard risk limits', () => {
  it('accepts a compliant trade', () => { expect(checkHardLimits(ok).ok).toBe(true); });
  it('rejects when the daily loss limit is hit', () => {
    const r = checkHardLimits({ ...ok, dailyRealizedPnlUsd: -150 });
    expect(r.ok).toBe(false); expect(r.rejections.join()).toMatch(/Daily loss/);
  });
  it('rejects leverage above the cap', () => { expect(checkHardLimits({ ...ok, leverage: 6 }).rejections.join()).toMatch(/Leverage/); });
  it('rejects risk above 1% and notional above 300%', () => {
    expect(checkHardLimits({ ...ok, riskPct: 2, riskUsd: 100 }).rejections.length).toBeGreaterThan(0);
    expect(checkHardLimits({ ...ok, notional: 20000 }).rejections.join()).toMatch(/Notional/);
  });
  it('rejects too many positions, too much open risk, too many trades, duplicate symbol', () => {
    expect(checkHardLimits({ ...ok, openPositions: 2 }).rejections.join()).toMatch(/positions/);
    expect(checkHardLimits({ ...ok, openRiskUsd: 120 }).rejections.join()).toMatch(/open risk/);
    expect(checkHardLimits({ ...ok, tradesToday: 5 }).rejections.join()).toMatch(/trades already/);
    expect(checkHardLimits({ ...ok, openSymbols: ['EIGENUSDT'] }).rejections.join()).toMatch(/already open/);
  });
  it('rejects a stop too close to liquidation', () => {
    expect(checkHardLimits({ ...ok, stopDistancePct: 0.03, liqDistancePct: 0.04 }).rejections.join()).toMatch(/Liquidation/);
  });
  it('env overrides cannot loosen beyond ceilings', () => {
    const l = loadLimits({ RISK_LIMITS: JSON.stringify({ maxRiskPctPerTrade: 10, maxLeverage: 100, maxDailyLossPct: 50 }) });
    expect(l.maxRiskPctPerTrade).toBe(2); expect(l.maxLeverage).toBe(10); expect(l.maxDailyLossPct).toBe(5);
    expect(loadLimits({})).toEqual(DEFAULT_LIMITS);
  });
});
