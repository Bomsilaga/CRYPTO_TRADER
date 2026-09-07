/**
 * history/costs.ts — transaction cost model (NET results are primary).
 *
 * Fees are charged on the notional of each partial fill, never as a flat
 * "full position × N exits" figure. Slippage applies to taker fills only.
 * Funding is charged on the fraction of the position still open at each
 * 8h settlement, using historical funding when supplied.
 */
import type { ExecutionProfile, FundingPoint } from './types';

export interface Fill { price: number; fraction: number; kind: 'entry' | 'tp' | 'stop' | 'timeout' }

export interface CostBreakdown {
  feesNotionalFrac: number;      // total fees as fraction of entry notional
  slippageNotionalFrac: number;  // total slippage cost as fraction of entry notional
  fundingNotionalFrac: number;   // net funding paid (+) or received (−)
  feesR: number;
  slippageR: number;
  fundingR: number;
  totalR: number;
}

/** Adjust a fill price for slippage against the trader (taker fills only). */
export function slip(price: number, side: 'buy' | 'sell', bps: number): number {
  const f = bps / 10_000;
  return side === 'buy' ? price * (1 + f) : price * (1 - f);
}

export function computeCosts(opts: {
  entry: number;
  direction: 'LONG' | 'SHORT';
  stopDistancePct: number;         // |entry - stop| / entry
  fills: Fill[];                   // entry + every exit with its fraction
  profile: ExecutionProfile;
  funding?: { points: FundingPoint[]; openTime: number; closeTime: number; fractionAt: (t: number) => number };
}): CostBreakdown {
  const { entry, stopDistancePct, fills, profile } = opts;
  let fees = 0, slippage = 0;
  for (const f of fills) {
    const notionalFrac = (f.price / entry) * f.fraction;   // relative to entry notional
    if (f.kind === 'entry') {
      fees += profile.entryFee * f.fraction;
      if (profile.entryIsTaker) slippage += (profile.slippageBps / 10_000) * f.fraction;
    } else if (f.kind === 'tp') {
      fees += profile.tpFee * notionalFrac;
    } else {
      fees += (f.kind === 'stop' ? profile.stopFee : profile.timeoutFee) * notionalFrac;
      slippage += (profile.slippageBps / 10_000) * notionalFrac;
    }
  }
  let funding = 0;
  if (opts.funding) {
    const { points, openTime, closeTime, fractionAt } = opts.funding;
    for (const p of points) {
      if (p.time <= openTime || p.time > closeTime) continue;
      const frac = fractionAt(p.time);
      if (frac <= 0) continue;
      // longs pay positive funding, shorts receive it
      funding += (opts.direction === 'LONG' ? p.rate : -p.rate) * frac;
    }
  }
  const toR = (x: number) => stopDistancePct > 0 ? x / stopDistancePct : 0;
  return {
    feesNotionalFrac: fees,
    slippageNotionalFrac: slippage,
    fundingNotionalFrac: funding,
    feesR: toR(fees),
    slippageR: toR(slippage),
    fundingR: toR(funding),
    totalR: toR(fees + slippage + funding),
  };
}
