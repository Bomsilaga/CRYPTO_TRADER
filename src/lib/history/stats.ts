/**
 * history/stats.ts — statistics over replayed trades. R-multiples are primary.
 */
import type { BacktestTrade, DecayResult, RateStat, SampleQuality, StatBlock, WalkForwardFold, WalkForwardResult, WilsonInterval, BtcSplitResult, BtcRelation, StoredCandle } from './types';

export function wilson(hits: number, n: number, z = 1.96): WilsonInterval {
  if (n <= 0) return { low: 0, high: 0 };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function sampleQuality(n: number): SampleQuality {
  if (n < 20) return 'INSUFFICIENT';
  if (n < 50) return 'VERY LOW EVIDENCE';
  if (n < 100) return 'LOW EVIDENCE';
  if (n < 250) return 'MODERATE';
  if (n < 500) return 'GOOD';
  return 'STRONGER EVIDENCE';
}

export function rateStat(hits: number, n: number): RateStat {
  return { rate: n ? hits / n : 0, hits, n, ci95: wilson(hits, n) };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

export function summarize(trades: BacktestTrade[], label = ''): StatBlock {
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  const n = sorted.length;
  const rs = sorted.map(t => t.netR);
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r <= 0);
  const grossW = wins.reduce((a, b) => a + b, 0);
  const grossL = Math.abs(losses.reduce((a, b) => a + b, 0));

  let cum = 0, peak = 0, maxDD = 0, maxDDPct = 0, streak = 0, maxStreak = 0;
  for (const r of rs) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0 && dd / peak > maxDDPct) maxDDPct = dd / peak;
    if (r <= 0) { streak++; if (streak > maxStreak) maxStreak = streak; } else streak = 0;
  }

  const regimeCounts = new Map<string, number>();
  for (const t of sorted) regimeCounts.set(t.regimeKey, (regimeCounts.get(t.regimeKey) ?? 0) + 1);
  let top: { key: string; share: number } | null = null;
  for (const [key, c] of regimeCounts) if (!top || c / n > top.share) top = { key, share: c / n };

  return {
    label,
    n,
    quality: sampleQuality(n),
    winRate: rateStat(wins.length, n),
    tp1: rateStat(sorted.filter(t => t.tp1Hit).length, n),
    tp2: rateStat(sorted.filter(t => t.tp2Hit).length, n),
    tp3: rateStat(sorted.filter(t => t.tp3Hit).length, n),
    stopFirst: rateStat(sorted.filter(t => t.firstOutcome === 'STOP').length, n),
    timeout: rateStat(sorted.filter(t => t.firstOutcome === 'TIMEOUT').length, n),
    avgWinR: mean(wins),
    avgLossR: mean(losses),
    expectancyR: mean(rs),
    medianR: median(rs),
    profitFactor: grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0),
    avgMfeR: mean(sorted.map(t => t.mfeR)),
    avgMaeR: mean(sorted.map(t => t.maeR)),
    maxDrawdownR: maxDD,
    maxDrawdownPct: maxDDPct * 100,
    maxConsecutiveLosses: maxStreak,
    avgHoldMs: mean(sorted.map(t => t.holdMs)),
    medianHoldMs: median(sorted.map(t => t.holdMs)),
    netCumulativeR: rs.reduce((a, b) => a + b, 0),
    grossCumulativeR: sorted.reduce((a, t) => a + t.grossR, 0),
    firstTime: n ? sorted[0].time : null,
    lastTime: n ? sorted[n - 1].time : null,
    regimeConcentration: top,
  };
}

const MONTH = 30 * 86_400_000;

/**
 * Walk-forward: rolling 6-month train / 1-month validation. The only tunable
 * is the minimum Setup Quality score admitted as a "setup"; it is chosen on
 * the train window and applied blind to the following month. Validation
 * months are pooled as the out-of-sample set. No validation data feeds tuning.
 */
export function walkForward(trades: BacktestTrade[], opts: { trainMonths?: number; testMonths?: number; candidates?: number[]; minTrainN?: number } = {}): WalkForwardResult {
  const trainMonths = opts.trainMonths ?? 6, testMonths = opts.testMonths ?? 1;
  const candidates = opts.candidates ?? [50, 60, 70, 80];
  const minTrainN = opts.minTrainN ?? 30;
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  const folds: WalkForwardFold[] = [];
  const warnings: string[] = [];
  if (!sorted.length) {
    return { method: `${trainMonths}m train / ${testMonths}m validate, rolling`, folds, inSample: summarize([], 'in-sample'), outOfSample: summarize([], 'out-of-sample'), degradationR: 0, warnings: ['no trades'] };
  }
  const start = sorted[0].time, end = sorted[sorted.length - 1].time;
  const pooledTrain: BacktestTrade[] = [], pooledTest: BacktestTrade[] = [];
  for (let testFrom = start + trainMonths * MONTH; testFrom <= end; testFrom += testMonths * MONTH) {
    const trainFrom = testFrom - trainMonths * MONTH, testTo = testFrom + testMonths * MONTH;
    const train = sorted.filter(t => t.time >= trainFrom && t.time < testFrom);
    const test = sorted.filter(t => t.time >= testFrom && t.time < testTo);
    if (train.length < minTrainN || !test.length) continue;
    const cand = candidates.map(minScore => {
      const sub = train.filter(t => t.score >= minScore);
      return { minScore, trainN: sub.length, trainExpectancyR: sub.length >= 15 ? mean(sub.map(t => t.netR)) : -Infinity };
    });
    const best = cand.reduce((a, b) => (b.trainExpectancyR > a.trainExpectancyR ? b : a), cand[0]);
    const chosen = Number.isFinite(best.trainExpectancyR) ? best.minScore : candidates[0];
    const trainSel = train.filter(t => t.score >= chosen);
    const testSel = test.filter(t => t.score >= chosen);
    pooledTrain.push(...trainSel);
    pooledTest.push(...testSel);
    folds.push({ trainFrom, trainTo: testFrom, testFrom, testTo, chosenMinScore: chosen, candidates: cand.map(c => ({ ...c, trainExpectancyR: Number.isFinite(c.trainExpectancyR) ? c.trainExpectancyR : 0 })), inSample: summarize(trainSel, 'train'), validation: summarize(testSel, 'validate') });
  }
  const inSample = summarize(pooledTrain, 'in-sample (pooled, overlapping windows)');
  const outOfSample = summarize(pooledTest, 'out-of-sample (pooled validation months)');
  const degradationR = inSample.expectancyR - outOfSample.expectancyR;
  if (folds.length < 3) warnings.push(`Only ${folds.length} walk-forward fold(s) — history too short for a stable out-of-sample read.`);
  if (outOfSample.n < 50) warnings.push(`Out-of-sample sample is small (n=${outOfSample.n}).`);
  if (inSample.n >= 30 && outOfSample.n >= 30 && degradationR > 0.25) warnings.push(`Large in/out-of-sample degradation: ${inSample.expectancyR.toFixed(2)}R → ${outOfSample.expectancyR.toFixed(2)}R.`);
  const monthShares = new Map<string, number>();
  for (const t of pooledTest) { const k = new Date(t.time).toISOString().slice(0, 7); monthShares.set(k, (monthShares.get(k) ?? 0) + t.netR); }
  const totalOOS = outOfSample.netCumulativeR;
  for (const [k, v] of monthShares) if (totalOOS > 0 && v / totalOOS > 0.5 && monthShares.size >= 4) warnings.push(`More than half of out-of-sample profit comes from a single month (${k}).`);
  const posFolds = folds.filter(f => f.validation.n >= 5 && f.validation.expectancyR > 0).length;
  if (folds.length >= 4 && posFolds / folds.length < 0.5) warnings.push(`Unstable: only ${posFolds}/${folds.length} validation months were positive.`);
  return { method: `${trainMonths}m train / ${testMonths}m validate, rolling monthly; tunable = min Setup Quality score chosen on train only`, folds, inSample, outOfSample, degradationR, warnings };
}

export function decay(trades: BacktestTrade[], now = Date.now()): DecayResult {
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  const longTerm = summarize(sorted, 'long-term');
  const last20 = summarize(sorted.slice(-20), 'last 20');
  const last50 = summarize(sorted.slice(-50), 'last 50');
  const last90d = summarize(sorted.filter(t => t.time >= now - 90 * 86_400_000), 'last 90 days');
  if (longTerm.n < 50 || last20.n < 20) return { last20, last50, last90d, longTerm, status: 'INSUFFICIENT', note: 'Not enough trades to judge recent edge decay.' };
  const recent = last50.n >= 50 ? last50 : last20;
  if (recent.expectancyR < 0) return { last20, last50, last90d, longTerm, status: 'EDGE NEGATIVE', note: `Recent expectancy ${recent.expectancyR.toFixed(2)}R is negative vs long-term ${longTerm.expectancyR.toFixed(2)}R — setup suspended for full size.` };
  if (longTerm.expectancyR > 0 && recent.expectancyR < longTerm.expectancyR * 0.5) return { last20, last50, last90d, longTerm, status: 'EDGE WEAKENING', note: `Recent expectancy ${recent.expectancyR.toFixed(2)}R is under half the long-term ${longTerm.expectancyR.toFixed(2)}R.` };
  return { last20, last50, last90d, longTerm, status: 'STABLE', note: `Recent ${recent.expectancyR.toFixed(2)}R vs long-term ${longTerm.expectancyR.toFixed(2)}R.` };
}

export function btcSplit(trades: BacktestTrade[], direction: 'LONG' | 'SHORT'): BtcSplitResult {
  const dir = trades.filter(t => t.direction === direction);
  const aligned = dir.filter(t => t.features.btcRegime === (direction === 'LONG' ? 'BULL' : 'BEAR'));
  const opposed = dir.filter(t => t.features.btcRegime === (direction === 'LONG' ? 'BEAR' : 'BULL'));
  const range = dir.filter(t => t.features.btcRegime === 'RANGE');
  const a = summarize(aligned, 'BTC aligned'), o = summarize(opposed, 'BTC opposed'), r = summarize(range, 'BTC ranging');
  const diff = a.expectancyR - o.expectancyR;
  const adequate = a.n >= 50 && o.n >= 50;
  const supports = adequate && diff >= 0.2;
  return {
    withBtcAligned: a, withBtcOpposed: o, withBtcRange: r, differenceR: diff, evidenceSupportsSizingRule: supports,
    note: !adequate
      ? `Insufficient samples to test the BTC rule (aligned n=${a.n}, opposed n=${o.n}). No sizing rule is applied from BTC context.`
      : supports
        ? `${direction} with BTC aligned: ${a.expectancyR.toFixed(2)}R (n=${a.n}) vs opposed ${o.expectancyR.toFixed(2)}R (n=${o.n}). Gap ${diff.toFixed(2)}R supports reducing size when BTC opposes.`
        : `${direction} with BTC aligned: ${a.expectancyR.toFixed(2)}R (n=${a.n}) vs opposed ${o.expectancyR.toFixed(2)}R (n=${o.n}). Gap ${diff.toFixed(2)}R is not material — no BTC-based sizing rule.`,
  };
}

export const fmtR = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function alignedReturns(a: StoredCandle[], b: StoredCandle[]): { ra: number[]; rb: number[]; times: number[] } {
  const mb = new Map(b.map(c => [c.time, c] as const));
  const ra: number[] = [], rb: number[] = [], times: number[] = [];
  for (let i = 1; i < a.length; i++) {
    const prevB = mb.get(a[i - 1].time), curB = mb.get(a[i].time);
    if (!prevB || !curB || a[i - 1].close <= 0 || prevB.close <= 0) continue;
    ra.push(Math.log(a[i].close / a[i - 1].close));
    rb.push(Math.log(curB.close / prevB.close));
    times.push(a[i].time);
  }
  return { ra, rb, times };
}
function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

/** Measured BTC coupling for a pair from 4h and 1d candles (pair vs BTCUSDT). */
export function btcRelation(pair4h: StoredCandle[], btc4h: StoredCandle[], pair1d: StoredCandle[], btc1d: StoredCandle[], now = Date.now()): BtcRelation {
  const h = alignedReturns(pair4h, btc4h);
  const d = alignedReturns(pair1d, btc1d);
  if (h.ra.length < 60 || d.ra.length < 20) return { corr4hAll: 0, corr4h90d: 0, beta4h: 0, oppositeDayShare: 0, oppositeDayShare90d: 0, days: d.ra.length, coupling: 'UNKNOWN', note: 'Not enough overlapping history with BTC to measure coupling.' };
  const corrAll = pearson(h.ra, h.rb);
  const cut = now - 90 * 86_400_000;
  const idx90 = h.times.findIndex(t => t >= cut);
  const corr90 = idx90 >= 0 ? pearson(h.ra.slice(idx90), h.rb.slice(idx90)) : corrAll;
  const mb = h.rb.reduce((a, b) => a + b, 0) / h.rb.length, ma = h.ra.reduce((a, b) => a + b, 0) / h.ra.length;
  let cov = 0, vb = 0;
  for (let i = 0; i < h.ra.length; i++) { cov += (h.ra[i] - ma) * (h.rb[i] - mb); vb += (h.rb[i] - mb) ** 2; }
  const beta = vb > 0 ? cov / vb : 0;
  const opp = d.ra.filter((r, i) => Math.sign(r) !== Math.sign(d.rb[i]) && r !== 0 && d.rb[i] !== 0).length / d.ra.length;
  const d90 = d.times.findIndex(t => t >= cut);
  const opp90 = d90 >= 0 && d.ra.length - d90 >= 15 ? d.ra.slice(d90).filter((r, i) => Math.sign(r) !== Math.sign(d.rb[d90 + i]) && r !== 0 && d.rb[d90 + i] !== 0).length / (d.ra.length - d90) : opp;
  const coupling: BtcRelation['coupling'] = corr90 >= 0.7 ? 'TIGHT' : corr90 >= 0.4 ? 'MODERATE' : 'LOOSE';
  const note = coupling === 'LOOSE'
    ? `Loosely coupled to BTC: 90-day 4h correlation ${corr90.toFixed(2)} and it closed against BTC on ${(opp90 * 100).toFixed(0)}% of recent days. BTC direction is context here, not a gate.`
    : coupling === 'TIGHT'
      ? `Tightly coupled to BTC: 90-day 4h correlation ${corr90.toFixed(2)}, beta ${beta.toFixed(2)}; it moved against BTC on only ${(opp90 * 100).toFixed(0)}% of recent days. BTC direction matters for this pair.`
      : `Moderately coupled to BTC: 90-day 4h correlation ${corr90.toFixed(2)}, against BTC on ${(opp90 * 100).toFixed(0)}% of recent days. Weigh BTC context with the pair's own structure.`;
  return { corr4hAll: corrAll, corr4h90d: corr90, beta4h: beta, oppositeDayShare: opp, oppositeDayShare90d: opp90, days: d.ra.length, coupling, note };
}
