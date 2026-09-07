/**
 * history/sync.ts — incremental candle + funding sync into a HistoryStore.
 * Fetches only what is missing after the last synced candle; first run backfills to the depth target.
 */
import { fetchFundingRange, fetchKlinesRange, HISTORY_DEPTH_MS, type FetchLike } from './bybitHistory';
import type { HistoryStore } from './store';
import type { StoredCandle, SyncState, Timeframe } from './types';
import { TF_MS } from './types';

export interface SyncReport { symbol: string; timeframe: Timeframe; fetched: number; firstTime: number | null; lastTime: number | null; count: number; skipped?: string }

export async function syncCandles(
  store: HistoryStore, symbol: string, tf: Timeframe,
  opts: { depthMs?: number; now?: number; fetchImpl?: FetchLike; log?: (m: string) => void; budgetMs?: number } = {},
): Promise<SyncReport> {
  const now = opts.now ?? Date.now();
  const depth = opts.depthMs ?? HISTORY_DEPTH_MS[tf];
  const prev = await store.getSyncState(symbol, tf);
  const step = TF_MS[tf];
  // last fully closed candle open time
  const lastClosedOpen = Math.floor(now / step) * step - step;
  const from = prev ? prev.lastTime + step : lastClosedOpen - depth;
  if (from > lastClosedOpen) return { symbol, timeframe: tf, fetched: 0, firstTime: prev?.firstTime ?? null, lastTime: prev?.lastTime ?? null, count: prev?.count ?? 0, skipped: 'up to date' };

  const started = Date.now();
  let fetched = 0;
  let minT = prev?.firstTime ?? Infinity, maxT = prev?.lastTime ?? -Infinity;
  const persist = async (page: StoredCandle[]) => {
    await store.upsertCandles(symbol, tf, page);
    fetched += page.length;
    for (const c of page) { if (c.time < minT) minT = c.time; if (c.time > maxT) maxT = c.time; }
    opts.log?.(`${symbol} ${tf}: +${page.length} (total fetched ${fetched})`);
  };
  await fetchKlinesRange(symbol, tf, from, lastClosedOpen + step - 1, {
    fetchImpl: opts.fetchImpl,
    onPage: persist,
    maxPages: opts.budgetMs ? undefined : undefined,
  });
  if (opts.budgetMs && Date.now() - started > opts.budgetMs) opts.log?.(`${symbol} ${tf}: budget exceeded, partial sync persisted`);
  const count = (prev?.count ?? 0) + fetched;
  const state: SyncState = {
    symbol, timeframe: tf,
    firstTime: Number.isFinite(minT) ? minT : (prev?.firstTime ?? from),
    lastTime: Number.isFinite(maxT) ? maxT : (prev?.lastTime ?? from),
    count, updatedAt: new Date().toISOString(),
  };
  if (fetched > 0 || !prev) await store.setSyncState(state);
  return { symbol, timeframe: tf, fetched, firstTime: state.firstTime, lastTime: state.lastTime, count };
}

export async function syncFunding(store: HistoryStore, symbol: string, opts: { depthMs?: number; now?: number; fetchImpl?: FetchLike } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const existing = await store.getFunding(symbol);
  const from = existing.length ? existing[existing.length - 1].time + 1 : now - (opts.depthMs ?? HISTORY_DEPTH_MS['1h']);
  if (from >= now) return 0;
  const pts = await fetchFundingRange(symbol, from, now, { fetchImpl: opts.fetchImpl });
  if (pts.length) await store.upsertFunding(symbol, pts);
  return pts.length;
}

export const DEFAULT_SYNC_TFS: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
