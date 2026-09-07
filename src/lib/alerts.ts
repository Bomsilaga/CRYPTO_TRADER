/**
 * alerts.ts — deterministic viability gates for background alerts. The AI is not involved.
 */
import type { HistoricalEvidence } from './history/evidence';

export interface ViabilityResult { viable: boolean; passed: string[]; failed: string[] }

/** Deterministic viability gates — the AI is not involved. */
export function assessViability(opts: {
  direction: string; score: number; structural: boolean; rTp2: number; liqSafe: boolean;
  evidence: HistoricalEvidence | null; requireHistory?: boolean; alertScore?: number;
}): ViabilityResult {
  const passed: string[] = [], failed: string[] = [];
  const req = opts.requireHistory ?? true;
  const minScore = opts.alertScore ?? 70;
  if (opts.direction === 'LONG' || opts.direction === 'SHORT') passed.push(`bias ${opts.direction}`); else failed.push('bias NEUTRAL');
  if (opts.score >= minScore) passed.push(`score ${opts.score} ≥ ${minScore}`); else failed.push(`score ${opts.score} < ${minScore}`);
  if (opts.structural) passed.push('structural entry'); else failed.push('ATR-fallback entry');
  if (opts.rTp2 >= 1.9) passed.push(`TP2 ${opts.rTp2.toFixed(1)}R`); else failed.push(`TP2 only ${opts.rTp2.toFixed(1)}R`);
  if (opts.liqSafe) passed.push('liq buffer ok @3×'); else failed.push('liquidation too close at 3×');
  const ev = opts.evidence;
  if (!ev || !ev.available || !ev.pairWide) { (req ? failed : passed).push(req ? 'no historical replay for pair' : 'history not required'); }
  else {
    if (ev.noTradeReasons.length) failed.push(`history: ${ev.noTradeReasons[0]}`); else passed.push('no server no-trade reasons');
    if (ev.pairWide.n >= 20) passed.push(`pair n=${ev.pairWide.n}`); else failed.push(`pair n=${ev.pairWide.n} < 20`);
    if (ev.pairWide.expectancyR > 0) passed.push(`pair exp ${ev.pairWide.expectancyR >= 0 ? '+' : ''}${ev.pairWide.expectancyR.toFixed(2)}R`); else failed.push(`pair exp ${ev.pairWide.expectancyR.toFixed(2)}R ≤ 0`);
    const oos = ev.outOfSample;
    if (oos && oos.n >= 20) {
      if (oos.expectancyR > 0 && oos.profitFactor >= 1.1) passed.push(`OOS exp +${oos.expectancyR.toFixed(2)}R PF ${oos.profitFactor.toFixed(2)}`); else failed.push(`OOS exp ${oos.expectancyR.toFixed(2)}R PF ${oos.profitFactor.toFixed(2)}`);
    } else failed.push(`OOS n=${oos?.n ?? 0} < 20`);
    if (ev.decay?.status === 'EDGE NEGATIVE') failed.push('recent edge negative'); else passed.push(`recent edge ${ev.decay?.status ?? 'n/a'}`);
    if (ev.similarSetups && ev.similarSetups.n >= 30 && ev.similarSetups.expectancyR <= 0) failed.push(`closest matches ${ev.similarSetups.expectancyR.toFixed(2)}R`);
  }
  return { viable: failed.length === 0, passed, failed };
}

