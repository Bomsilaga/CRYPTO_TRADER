/**
 * history/pipeline.ts — orchestrates sync → load → replay → persist for one pair.
 * Used by the admin route and the CLI script.
 */
import { getHistoryStore, type HistoryStore } from './store';
import { syncCandles, syncFunding, DEFAULT_SYNC_TFS } from './sync';
import { runBacktest } from './backtest';
import type { BacktestConfig, CandleMap, Timeframe, BacktestRun } from './types';
import { resolveSource, type HistorySource } from './sources';

export interface BuildReport {
  symbol: string;
  source: string;
  sync: { timeframe: Timeframe; fetched: number; count: number; firstTime: number | null; lastTime: number | null }[];
  funding: number;
  btcSync?: { timeframe: Timeframe; fetched: number; count: number }[];
  backtest?: { trades: number; decisions: number; neutral: number; builtAt: string; longN: number; shortN: number; oosLongR: number; oosShortR: number };
  elapsedMs: number;
  complete: boolean;
  notes: string[];
}

export async function loadCandleMap(store: HistoryStore, symbol: string, tfs: Timeframe[] = DEFAULT_SYNC_TFS): Promise<CandleMap> {
  const out: CandleMap = {};
  for (const tf of tfs) { const c = await store.getCandles(symbol, tf); if (c.length) out[tf] = c; }
  return out;
}

export async function buildPair(symbol: string, opts: {
  store?: HistoryStore; backtest?: boolean; budgetMs?: number; timeframes?: Timeframe[]; config?: Partial<BacktestConfig>;
  source?: HistorySource; log?: (m: string) => void; includeBtc?: boolean;
} = {}): Promise<BuildReport> {
  const started = Date.now();
  const source = opts.source ?? await resolveSource({ log: opts.log });
  const store = opts.store ?? getHistoryStore('write');
  const tfs = opts.timeframes ?? DEFAULT_SYNC_TFS;
  const log = opts.log ?? (() => {});
  const notes: string[] = [];
  const report: BuildReport = { symbol, source: source.name, sync: [], funding: 0, elapsedMs: 0, complete: true, notes };
  if (source.name !== 'bybit') notes.push(`history source is ${source.name} (Bybit unreachable) — prices are from a different venue than execution`);
  const budget = opts.budgetMs ?? Infinity;
  const over = () => Date.now() - started > budget;

  for (const tf of tfs) {
    if (over()) { notes.push(`budget exhausted before ${tf} sync`); report.complete = false; break; }
    const r = await syncCandles(store, symbol, tf, { source, log });
    report.sync.push({ timeframe: tf, fetched: r.fetched, count: r.count, firstTime: r.firstTime, lastTime: r.lastTime });
  }
  if (!over()) report.funding = await syncFunding(store, symbol, { source }).catch(e => { notes.push(`funding sync failed: ${e}`); return 0; });
  if (opts.includeBtc !== false && symbol !== 'BTCUSDT' && !over()) {
    report.btcSync = [];
    for (const tf of ['1h', '4h', '1d'] as Timeframe[]) {
      const r = await syncCandles(store, 'BTCUSDT', tf, { source, log });
      report.btcSync.push({ timeframe: tf, fetched: r.fetched, count: r.count });
    }
  }
  if (opts.backtest !== false && !over()) {
    const candles = await loadCandleMap(store, symbol, tfs);
    const btc = symbol === 'BTCUSDT' ? undefined : await loadCandleMap(store, 'BTCUSDT', ['1h', '4h', '1d']);
    const funding = await store.getFunding(symbol);
    const run: BacktestRun = runBacktest({ symbol, candles, btcCandles: btc, funding, config: opts.config, source: source.name, onProgress: (d, t) => log(`replay ${d}/${t}`) });
    await store.saveBacktest(run);
    report.backtest = {
      trades: run.trades.length, decisions: run.decisions, neutral: run.neutralDecisions, builtAt: run.builtAt,
      longN: run.stats.LONG.n, shortN: run.stats.SHORT.n,
      oosLongR: run.stats.walkForward.LONG.outOfSample.expectancyR, oosShortR: run.stats.walkForward.SHORT.outOfSample.expectancyR,
    };
  } else if (opts.backtest !== false) { notes.push('budget exhausted before replay — call again'); report.complete = false; }
  report.elapsedMs = Date.now() - started;
  return report;
}
