import { describe, it, expect } from 'vitest';
import { replayOne, runBacktest } from '../src/lib/history/backtest';
import { buildEvidence } from '../src/lib/history/evidence';
import { computeFeatures } from '../src/lib/history/features';
import { DEFAULT_BACKTEST_CONFIG } from '../src/lib/history/types';
import { runEngine } from '../src/lib/signalEngine';
import { synthCandleMap } from './fixtures';

describe('replay backtester', () => {
  const candles = synthCandleMap(11);
  const cfg = { ...DEFAULT_BACKTEST_CONFIG };

  it('is look-ahead safe: altering future candles never changes a decision', () => {
    const idx = 400;
    const a = replayOne({ symbol: 'TESTUSDT', decisionIdx: idx, decisionTf: '1h', candles, config: cfg });
    // corrupt everything after the decision candle on every timeframe
    const tampered = Object.fromEntries(Object.entries(candles).map(([tf, arr]) => {
      const cut = candles['1h'][idx].time + 3_600_000;
      return [tf, arr.map(c => c.time + (tf === '1h' ? 3_600_000 : tf === '15m' ? 900_000 : tf === '4h' ? 14_400_000 : 86_400_000) > cut ? { ...c, open: c.open * 3, high: c.high * 3, low: c.low * 3, close: c.close * 3 } : c)];
    })) as typeof candles;
    const b = replayOne({ symbol: 'TESTUSDT', decisionIdx: idx, decisionTf: '1h', candles: tampered, config: cfg });
    expect(a.neutral).toBe(b.neutral);
    if (a.trade && b.trade) {
      expect(b.trade.entry).toBe(a.trade.entry);
      expect(b.trade.stopLoss).toBe(a.trade.stopLoss);
      expect(b.trade.tp1).toBe(a.trade.tp1);
      expect(b.trade.score).toBe(a.trade.score);
      expect(b.trade.features.rsi).toBe(a.trade.features.rsi);
      expect(b.trade.features.atrPercentile).toBe(a.trade.features.atrPercentile);
      // outcomes legitimately differ — the future changed
    }
  });

  it('runs end to end on synthetic history and produces internally consistent statistics', () => {
    const run = runBacktest({ symbol: 'TESTUSDT', candles, config: { warmupBars: 210 } });
    expect(run.decisions).toBeGreaterThan(500);
    expect(run.trades.length + run.neutralDecisions + run.skippedWhileOpen).toBeLessThanOrEqual(run.decisions);
    expect(run.trades.length).toBeGreaterThan(10);
    for (const t of run.trades) {
      expect(t.stopDistancePct).toBeGreaterThan(0);
      expect(t.netR).toBeLessThanOrEqual(t.grossR);          // costs only ever subtract
      expect(t.mfeR).toBeGreaterThanOrEqual(0);
      expect(t.maeR).toBeGreaterThanOrEqual(0);
      if (t.firstOutcome === 'STOP') expect(t.tp1Hit).toBe(false);
      if (t.tp2Hit) expect(t.tp1Hit).toBe(true);
      expect(t.features.time).toBe(t.time);
    }
    // one-at-a-time: no overlapping holds
    const sorted = [...run.trades].sort((a, b) => a.time - b.time);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].time).toBeGreaterThanOrEqual(sorted[i - 1].time + sorted[i - 1].holdMs);
    const s = run.stats.all;
    expect(s.n).toBe(run.trades.filter(t => t.score >= cfg.minSetupScore).length);
    expect(s.tp1.ci95.low).toBeLessThanOrEqual(s.tp1.rate);
    expect(s.tp1.ci95.high).toBeGreaterThanOrEqual(s.tp1.rate);
    expect(Object.keys(run.featureNorms).length).toBeGreaterThan(5);
  });

  it('NEUTRAL stays NEUTRAL: evidence for a neutral bias is a no-trade, and the engine does not default to LONG', () => {
    const flat = Object.fromEntries(Object.entries(candles).map(([tf, arr]) => [tf, arr.map(c => ({ ...c, open: 100, high: 100.01, low: 99.99, close: 100 }))]));
    const eng = runEngine('TESTUSDT', 100, flat as never, 'now');
    expect(eng.direction).toBe('NEUTRAL');
    expect(eng.verdict).toContain('NO TRADE');
    const ev = buildEvidence({ run: null, symbol: 'TESTUSDT', direction: 'NEUTRAL' });
    expect(ev.available).toBe(false);
    const run = runBacktest({ symbol: 'TESTUSDT', candles, config: { warmupBars: 210 } });
    const evN = buildEvidence({ run, symbol: 'TESTUSDT', direction: 'NEUTRAL' });
    expect(evN.noTradeReasons).toContain('Engine bias is NEUTRAL');
    expect(evN.pairWide).toBeUndefined();
  });

  it('evidence returns three layers with sample sizes and CIs, and raises no-trade on non-positive expectancy', () => {
    const run = runBacktest({ symbol: 'TESTUSDT', candles, config: { warmupBars: 210 } });
    const t = run.trades[0];
    const dir = t.direction;
    const eng = runEngine('TESTUSDT', candles['1h'][500].close, { '15m': candles['15m'].slice(0, 2000), '1h': candles['1h'].slice(0, 500), '4h': candles['4h'].slice(0, 125), '1d': candles['1d'].slice(0, 20) } as never, 'now');
    const feat = computeFeatures({ symbol: 'TESTUSDT', time: candles['1h'][500].time, direction: dir, engine: eng, candleMap: { '1h': candles['1h'].slice(0, 500), '4h': candles['4h'].slice(0, 125) } });
    const ev = buildEvidence({ run, symbol: 'TESTUSDT', direction: dir, current: feat });
    expect(ev.available).toBe(true);
    expect(ev.pairWide!.n).toBe(run.stats[dir].n);
    expect(ev.similarSetups!.k).toBeGreaterThan(0);
    expect(ev.similarSetups!.tp1.ci95[0]).toBeLessThanOrEqual(ev.similarSetups!.tp1.rate);
    expect(ev.regime!.regimeKey).toContain('VOL_');
    expect(typeof ev.outOfSample!.method).toBe('string');
    const negative = { ...run, trades: run.trades.map(x => ({ ...x, netR: -0.5 })) };
    negative.stats = { ...run.stats, [dir]: { ...run.stats[dir], expectancyR: -0.5 } };
    const evNeg = buildEvidence({ run: negative, symbol: 'TESTUSDT', direction: dir, current: feat });
    expect(evNeg.noTradeReasons.length).toBeGreaterThan(0);
    if (evNeg.pairWide!.n >= 20) expect(evNeg.noTradeReasons.some(r => r.includes('expectancy'))).toBe(true);
    expect(evNeg.pairWide!.expectancyR).toBeLessThan(0);
  });
});
