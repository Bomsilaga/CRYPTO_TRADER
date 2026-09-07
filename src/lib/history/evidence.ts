/**
 * history/evidence.ts — turns a stored BacktestRun into the structured
 * historicalEvidence object consumed by the UI and the AI. Three layers
 * (pair-wide, current regime, closest matches) plus out-of-sample, BTC
 * split and recent decay. Nothing here is estimated; every number is a
 * count or ratio over replayed trades.
 */
import type { BacktestRun, BacktestTrade, FeatureSnapshot, RateStat, SampleQuality, StatBlock } from './types';
import { summarize } from './stats';
import { nearest } from './similarity';
import { regimeKey } from './features';

export interface EvidenceRate { rate: number; hits: number; n: number; ci95: [number, number] }
export interface EvidenceBlock {
  label: string; n: number; quality: SampleQuality;
  tp1: EvidenceRate; tp2: EvidenceRate; tp3: EvidenceRate; stopFirst: EvidenceRate; winRate: EvidenceRate; timeout: EvidenceRate;
  expectancyR: number; profitFactor: number; medianR: number; avgWinR: number; avgLossR: number;
  avgMfeR: number; avgMaeR: number; maxDrawdownR: number; maxConsecutiveLosses: number; avgHoldHours: number; netCumulativeR: number;
  regimeConcentration: { key: string; share: number } | null;
  warnings: string[];
}

export interface HistoricalEvidence {
  available: boolean;
  reason?: string;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  builtAt?: string;
  source?: string;
  coverage?: BacktestRun['coverage'];
  decisions?: number;
  neutralDecisions?: number;
  minSetupScore?: number;
  executionProfile?: string;
  pairWide?: EvidenceBlock;
  regime?: EvidenceBlock & { regimeKey: string; regimeShareOfPair: number; rare: boolean };
  similarSetups?: EvidenceBlock & { k: number; avgDistance: number };
  outOfSample?: EvidenceBlock & { inSampleExpectancyR: number; inSampleN: number; degradationR: number; folds: number; method: string; foldsPositive: number };
  btcSplit?: BacktestRun['stats']['btcSplit']['LONG'] & { alignedNow: 'ALIGNED' | 'OPPOSED' | 'RANGE' | 'UNKNOWN' };
  btcRelation?: BacktestRun['stats']['btcRelation'];
  decay?: { status: string; note: string; last20ExpectancyR: number; last50ExpectancyR: number; last90dExpectancyR: number; longTermExpectancyR: number; last50N: number };
  scoreBand?: EvidenceBlock;
  warnings: string[];
  noTradeReasons: string[];
  sampleQualityScale: string;
}

const rate = (r: RateStat): EvidenceRate => ({ rate: r.rate, hits: r.hits, n: r.n, ci95: [r.ci95.low, r.ci95.high] });

export function toBlock(s: StatBlock, extraWarnings: string[] = []): EvidenceBlock {
  const warnings = [...extraWarnings];
  if (s.n < 20) warnings.push(`Sample too small (n=${s.n}) for any claim.`);
  else if (s.n < 50) warnings.push(`Very small sample (n=${s.n}) — treat rates as indicative only.`);
  if (s.regimeConcentration && s.n >= 50 && s.regimeConcentration.share > 0.7) warnings.push(`${Math.round(s.regimeConcentration.share * 100)}% of this sample comes from one regime (${s.regimeConcentration.key}).`);
  if (s.n >= 20 && s.expectancyR <= 0) warnings.push(`Historical expectancy is not positive (${s.expectancyR.toFixed(2)}R).`);
  return {
    label: s.label, n: s.n, quality: s.quality,
    tp1: rate(s.tp1), tp2: rate(s.tp2), tp3: rate(s.tp3), stopFirst: rate(s.stopFirst), winRate: rate(s.winRate), timeout: rate(s.timeout),
    expectancyR: s.expectancyR, profitFactor: Number.isFinite(s.profitFactor) ? s.profitFactor : 99, medianR: s.medianR, avgWinR: s.avgWinR, avgLossR: s.avgLossR,
    avgMfeR: s.avgMfeR, avgMaeR: s.avgMaeR, maxDrawdownR: s.maxDrawdownR, maxConsecutiveLosses: s.maxConsecutiveLosses,
    avgHoldHours: s.avgHoldMs / 3_600_000, netCumulativeR: s.netCumulativeR, regimeConcentration: s.regimeConcentration, warnings,
  };
}

export const SAMPLE_QUALITY_SCALE = 'n<20 INSUFFICIENT · 20–49 VERY LOW · 50–99 LOW · 100–249 MODERATE · 250–499 GOOD · 500+ STRONGER';

export function buildEvidence(opts: {
  run: BacktestRun | null;
  symbol: string;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  current?: FeatureSnapshot | null;      // live features for regime + similarity
  now?: number;
}): HistoricalEvidence {
  const { run, symbol, direction } = opts;
  const base: HistoricalEvidence = { available: false, symbol, direction, warnings: [], noTradeReasons: [], sampleQualityScale: SAMPLE_QUALITY_SCALE };
  if (!run) return { ...base, reason: 'No historical replay exists for this pair yet. Run the history build (Settings → History) to download and replay exchange data.' };
  if (direction === 'NEUTRAL') return { ...base, available: true, builtAt: run.builtAt, coverage: run.coverage, decisions: run.decisions, neutralDecisions: run.neutralDecisions, reason: 'Engine bias is NEUTRAL — no directional population to compare against.', noTradeReasons: ['Engine bias is NEUTRAL'] };

  const cfg = run.config;
  const dirTrades = run.trades.filter(t => t.direction === direction);
  const setups = dirTrades.filter(t => t.score >= cfg.minSetupScore);
  // When the run was loaded without per-trade payloads (evidence/status routes), fall back to the stored block.
  const pairWide = run.trades.length
    ? toBlock(summarize(setups, `${symbol} ${direction} · score ≥ ${cfg.minSetupScore}`))
    : toBlock({ ...run.stats[direction], label: `${symbol} ${direction} · score ≥ ${cfg.minSetupScore}` });
  const warnings: string[] = [];
  const noTrade: string[] = [];

  let regime: HistoricalEvidence['regime'];
  let similar: HistoricalEvidence['similarSetups'];
  let scoreBand: EvidenceBlock | undefined;
  if (opts.current) {
    const key = regimeKey(opts.current);
    const inRegime = setups.filter(t => t.regimeKey === key);
    const share = setups.length ? inRegime.length / setups.length : 0;
    regime = { ...toBlock(summarize(inRegime, `${key}`)), regimeKey: key, regimeShareOfPair: share, rare: setups.length >= 100 && share < 0.05 };
    if (regime.rare) warnings.push(`Current regime ${key} is rare for this pair (${(share * 100).toFixed(1)}% of setups).`);
    const nn = nearest(opts.current, setups, run.featureNorms);
    similar = { ...toBlock(summarize(nn.matches, `closest ${nn.k} setups`)), k: nn.k, avgDistance: nn.avgDistance };
    const band = setups.filter(t => Math.abs(t.score - opts.current!.score) <= 7);
    scoreBand = toBlock(summarize(band, `score ${opts.current.score - 7}–${opts.current.score + 7}`));
  }

  const wf = run.stats.walkForward[direction];
  const outOfSample: HistoricalEvidence['outOfSample'] = {
    ...toBlock(wf.outOfSample, wf.warnings), inSampleExpectancyR: wf.inSample.expectancyR, inSampleN: wf.inSample.n, degradationR: wf.degradationR,
    folds: wf.folds.length, method: wf.method, foldsPositive: wf.folds.filter(f => f.validation.n >= 5 && f.validation.expectancyR > 0).length,
  };
  const split = run.stats.btcSplit[direction];
  const btcNow = opts.current?.btcRegime ?? 'UNKNOWN';
  const alignedNow = btcNow === 'UNKNOWN' ? 'UNKNOWN' : btcNow === 'RANGE' ? 'RANGE' : (btcNow === 'BULL') === (direction === 'LONG') ? 'ALIGNED' : 'OPPOSED';
  const dc = run.stats.decay[direction];
  const decay = { status: dc.status, note: dc.note, last20ExpectancyR: dc.last20.expectancyR, last50ExpectancyR: dc.last50.expectancyR, last90dExpectancyR: dc.last90d.expectancyR, longTermExpectancyR: dc.longTerm.expectancyR, last50N: dc.last50.n };

  // ── No-trade logic (server-side, deterministic) ──
  if (pairWide.n < 20) noTrade.push(`Insufficient pair history for ${direction} (n=${pairWide.n} < 20).`);
  if (pairWide.n >= 20 && pairWide.expectancyR <= 0) noTrade.push(`Pair-wide expectancy is ${pairWide.expectancyR.toFixed(2)}R (≤ 0).`);
  if (outOfSample.n >= 30 && outOfSample.expectancyR <= 0) noTrade.push(`Out-of-sample expectancy is ${outOfSample.expectancyR.toFixed(2)}R (≤ 0).`);
  if (outOfSample.n >= 30 && outOfSample.profitFactor < 1.1) noTrade.push(`Out-of-sample profit factor ${outOfSample.profitFactor.toFixed(2)} is too low.`);
  if (similar && similar.n >= 30 && similar.expectancyR <= 0) noTrade.push(`Closest historical matches lost money (${similar.expectancyR.toFixed(2)}R over ${similar.n}).`);
  if (regime && regime.n >= 30 && regime.expectancyR < -0.1) noTrade.push(`This pair's ${direction} setups in the current regime have negative expectancy (${regime.expectancyR.toFixed(2)}R, n=${regime.n}).`);
  if (dc.status === 'EDGE NEGATIVE') noTrade.push('Recent edge decay: last-50 expectancy is negative.');
  if (dc.status === 'EDGE WEAKENING') warnings.push(dc.note);
  if (outOfSample.n >= 30 && outOfSample.degradationR > 0.25) warnings.push(`In-sample → out-of-sample degradation of ${outOfSample.degradationR.toFixed(2)}R suggests curve-fit or regime change.`);
  if (split.evidenceSupportsSizingRule && alignedNow === 'OPPOSED') warnings.push(`BTC opposes and this pair's history supports smaller size when BTC opposes (${split.differenceR.toFixed(2)}R gap).`);
  if (!split.evidenceSupportsSizingRule) warnings.push('BTC-context sizing rule not applied: history does not show a material, adequately-sampled gap.');
  if (run.stats.btcRelation?.coupling === 'LOOSE') warnings.push(run.stats.btcRelation.note);

  return {
    ...base,
    available: true,
    builtAt: run.builtAt, source: run.source, coverage: run.coverage, decisions: run.decisions, neutralDecisions: run.neutralDecisions,
    minSetupScore: cfg.minSetupScore, executionProfile: cfg.profile,
    pairWide, regime, similarSetups: similar, outOfSample, scoreBand,
    btcSplit: { ...split, alignedNow },
    btcRelation: run.stats.btcRelation,
    decay, warnings, noTradeReasons: noTrade,
  };
}

/** Realised (user journal) vs model — kept separate, never blended. */
export function compareRealized(model: EvidenceBlock | undefined, realized: { n: number; expectancyR: number; tp1Rate: number }): string | null {
  if (!model || realized.n < 10) return null;
  const gap = realized.expectancyR - model.expectancyR;
  if (Math.abs(gap) < 0.1) return `Your realised expectancy (${realized.expectancyR.toFixed(2)}R, n=${realized.n}) tracks the model (${model.expectancyR.toFixed(2)}R).`;
  return gap < 0
    ? `Your realised expectancy (${realized.expectancyR.toFixed(2)}R, n=${realized.n}) trails the model (${model.expectancyR.toFixed(2)}R) by ${Math.abs(gap).toFixed(2)}R — check execution, slippage and discipline before sizing up.`
    : `Your realised expectancy (${realized.expectancyR.toFixed(2)}R, n=${realized.n}) exceeds the model (${model.expectancyR.toFixed(2)}R); small samples flatter — do not size up on this alone.`;
}

export type { BacktestTrade };
