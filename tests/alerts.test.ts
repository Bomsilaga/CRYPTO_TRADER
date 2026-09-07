import { describe, it, expect } from 'vitest';
import { assessViability } from '../src/lib/alerts';
import { formatAlert } from '../src/lib/telegram';
import type { HistoricalEvidence, EvidenceBlock } from '../src/lib/history/evidence';

const rate = (r: number, n: number) => ({ rate: r, hits: Math.round(r * n), n, ci95: [Math.max(0, r - 0.1), Math.min(1, r + 0.1)] as [number, number] });
const block = (n: number, exp: number, pf = 1.4): EvidenceBlock => ({ label: 'x', n, quality: n >= 100 ? 'MODERATE' : 'LOW EVIDENCE', tp1: rate(0.58, n), tp2: rate(0.35, n), tp3: rate(0.2, n), stopFirst: rate(0.4, n), winRate: rate(0.55, n), timeout: rate(0.05, n), expectancyR: exp, profitFactor: pf, medianR: 0.1, avgWinR: 1.2, avgLossR: -0.9, avgMfeR: 1.5, avgMaeR: 0.5, maxDrawdownR: 6, maxConsecutiveLosses: 4, avgHoldHours: 9, netCumulativeR: exp * n, regimeConcentration: null, warnings: [] });
const ev = (o: Partial<HistoricalEvidence> = {}): HistoricalEvidence => ({ available: true, symbol: 'X', direction: 'LONG', warnings: [], noTradeReasons: [], sampleQualityScale: '', pairWide: block(120, 0.18), outOfSample: { ...block(80, 0.15, 1.3), inSampleExpectancyR: 0.2, inSampleN: 300, degradationR: 0.05, folds: 8, method: 'wf', foldsPositive: 6 }, decay: { status: 'STABLE', note: '', last20ExpectancyR: 0.1, last50ExpectancyR: 0.12, last90dExpectancyR: 0.1, longTermExpectancyR: 0.18, last50N: 50 }, ...o });
const base = { direction: 'LONG', score: 78, structural: true, rTp2: 2.1, liqSafe: true };

describe('alert viability gates', () => {
  it('passes a structural, positive-edge setup', () => {
    const v = assessViability({ ...base, evidence: ev() });
    expect(v.viable).toBe(true);
    expect(v.failed).toEqual([]);
  });
  it('fails on NEUTRAL, low score, ATR fallback, weak TP2, or unsafe liquidation', () => {
    expect(assessViability({ ...base, direction: 'NEUTRAL', evidence: ev() }).viable).toBe(false);
    expect(assessViability({ ...base, score: 60, evidence: ev() }).failed.join()).toMatch(/score/);
    expect(assessViability({ ...base, structural: false, evidence: ev() }).failed.join()).toMatch(/fallback/);
    expect(assessViability({ ...base, rTp2: 1.2, evidence: ev() }).failed.join()).toMatch(/TP2/);
    expect(assessViability({ ...base, liqSafe: false, evidence: ev() }).failed.join()).toMatch(/liquidation/);
  });
  it('requires positive pair-wide and out-of-sample evidence and no server no-trade reasons', () => {
    expect(assessViability({ ...base, evidence: null }).failed.join()).toMatch(/no historical replay/);
    expect(assessViability({ ...base, evidence: null, requireHistory: false }).viable).toBe(true);
    expect(assessViability({ ...base, evidence: ev({ pairWide: block(120, -0.05) }) }).failed.join()).toMatch(/pair exp/);
    expect(assessViability({ ...base, evidence: ev({ outOfSample: { ...block(80, -0.02, 0.95), inSampleExpectancyR: 0.2, inSampleN: 300, degradationR: 0.2, folds: 8, method: 'wf', foldsPositive: 3 } }) }).failed.join()).toMatch(/OOS/);
    expect(assessViability({ ...base, evidence: ev({ noTradeReasons: ['Pair-wide expectancy is -0.1R (≤ 0).'] }) }).failed.join()).toMatch(/history:/);
    expect(assessViability({ ...base, evidence: ev({ decay: { status: 'EDGE NEGATIVE', note: '', last20ExpectancyR: -0.3, last50ExpectancyR: -0.2, last90dExpectancyR: -0.1, longTermExpectancyR: 0.18, last50N: 50 } }) }).failed.join()).toMatch(/recent edge/);
  });
  it('formats a Telegram card with escaped HTML and the exact entry instruction', () => {
    const text = formatAlert({ symbol: 'EIGENUSDT', direction: 'LONG', price: 0.2134, score: 78, style: 'INTRADAY', entry: 0.2101, entryMode: 'LIMIT', entryStatus: 'WAIT_PULLBACK', entryBasis: 'Pullback entry: limit at top of OB+FVG 1h/4h zone <3 ATR>', entryKinds: ['OB', 'FVG'], entryTfs: ['1h', '4h'], confirmation: null, stop: 0.2064, stopBasis: 'below 1h swing low', tp1: 0.2145, tp2: 0.219, tp3: 0.2251, rTp1: 1.2, rTp2: 2.4, rTp3: 4.1, targetBasis: ['4h swing high', '4h equal highs', 'R-multiple'], leverage: 3, evidence: { pairN: 120, pairQuality: 'MODERATE', pairTp1: 0.58, pairExp: 0.18, oosN: 80, oosExp: 0.15, oosPf: 1.3, source: 'okx' }, risk: { capital: 5000, riskUsd: 50, notional: 2838, margin3x: 946, margin5x: 568, netStop: -55, netTp1: 48, netTp2: 101, netStaged: 92 }, reasonsPassed: ['bias LONG', 'score 78 ≥ 70'] });
    expect(text).toContain('<b>ENTRY LIMIT WAIT PULLBACK @ 0.210100</b>');
    expect(text).toContain('&lt;3 ATR&gt;');
    expect(text).toContain('OOS: n=80');
    expect(text).toContain('margin @3× $946');
  });
});
