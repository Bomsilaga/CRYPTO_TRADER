/**
 * history/sources.ts — pluggable market-history source.
 * Bybit is preferred (execution venue). OKX is the fallback for regions where
 * api.bybit.com is blocked. HISTORY_SOURCE=bybit|okx|auto (default auto).
 */
import type { FundingPoint, StoredCandle, Timeframe } from './types';
import { fetchFundingRange, fetchKlinesRange, type FetchLike } from './bybitHistory';
import { okxFetchFundingRange, okxFetchKlinesRange } from './okxHistory';

export type SourceName = 'bybit' | 'okx';
export interface HistorySource {
  name: SourceName;
  fetchKlines(symbol: string, tf: Timeframe, startMs: number, endMs: number, opts?: { onPage?: (c: StoredCandle[]) => Promise<void> | void; maxPages?: number }): Promise<StoredCandle[]>;
  fetchFunding(symbol: string, startMs: number, endMs: number): Promise<FundingPoint[]>;
}

export function bybitSource(fetchImpl?: FetchLike): HistorySource {
  return {
    name: 'bybit',
    fetchKlines: (s, tf, a, b, o) => fetchKlinesRange(s, tf, a, b, { ...o, fetchImpl }),
    fetchFunding: (s, a, b) => fetchFundingRange(s, a, b, { fetchImpl }),
  };
}
export function okxSource(fetchImpl?: FetchLike): HistorySource {
  return {
    name: 'okx',
    fetchKlines: (s, tf, a, b, o) => okxFetchKlinesRange(s, tf, a, b, { ...o, fetchImpl }),
    fetchFunding: (s, a, b) => okxFetchFundingRange(s, a, b, { fetchImpl }),
  };
}

let resolved: HistorySource | null = null;

/** Probe Bybit once; fall back to OKX when blocked. */
export async function resolveSource(opts: { prefer?: string; log?: (m: string) => void } = {}): Promise<HistorySource> {
  const prefer = (opts.prefer ?? process.env.HISTORY_SOURCE ?? 'auto').toLowerCase();
  if (prefer === 'okx') return okxSource();
  if (prefer === 'bybit') return bybitSource();
  if (resolved) return resolved;
  try {
    await fetchKlinesRange('BTCUSDT', '1h', Date.now() - 3 * 3_600_000, Date.now(), { maxPages: 1 });
    resolved = bybitSource();
  } catch (e) {
    opts.log?.(`Bybit history unreachable (${String(e).slice(0, 80)}) — falling back to OKX`);
    resolved = okxSource();
  }
  return resolved;
}
