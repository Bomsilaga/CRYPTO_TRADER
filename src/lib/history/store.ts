/**
 * history/store.ts — persistence for candles, funding, sync state and backtest runs.
 *
 * Two implementations:
 *  - FileHistoryStore      : JSON files under data/history (local dev, scripts, tests)
 *  - SupabaseHistoryStore  : hist_* tables via PostgREST. Reads work with the anon
 *                            key; writes require SUPABASE_SERVICE_ROLE_KEY (RLS).
 */
import { promises as fs } from 'fs';
import path from 'path';
import type { BacktestRun, BacktestTrade, FundingPoint, StoredCandle, SyncState, Timeframe } from './types';

export interface HistoryStore {
  getCandles(symbol: string, tf: Timeframe, from?: number, to?: number): Promise<StoredCandle[]>;
  upsertCandles(symbol: string, tf: Timeframe, candles: StoredCandle[]): Promise<{ inserted: number; total: number }>;
  getSyncState(symbol: string, tf: Timeframe): Promise<SyncState | null>;
  setSyncState(state: SyncState): Promise<void>;
  getFunding(symbol: string, from?: number, to?: number): Promise<FundingPoint[]>;
  upsertFunding(symbol: string, points: FundingPoint[]): Promise<number>;
  saveBacktest(run: BacktestRun): Promise<void>;
  getBacktest(symbol: string, opts?: { withTrades?: boolean }): Promise<BacktestRun | null>;
  listBacktests(): Promise<{ symbol: string; builtAt: string; trades: number; source?: string; btcRelation?: BacktestRun['stats']['btcRelation'] }[]>;
}

const dedupe = (candles: StoredCandle[]) => {
  const m = new Map<number, StoredCandle>();
  for (const c of candles) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
};

/* ─── File store ─────────────────────────────────────────────────────────── */

export class FileHistoryStore implements HistoryStore {
  constructor(private root = path.join(process.cwd(), 'data', 'history')) {}
  private p(...segs: string[]) { return path.join(this.root, ...segs); }
  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; } catch { return fallback; }
  }
  private async writeJson(file: string, data: unknown) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, file);
  }
  async getCandles(symbol: string, tf: Timeframe, from = 0, to = Infinity) {
    const all = await this.readJson<StoredCandle[]>(this.p('candles', symbol, `${tf}.json`), []);
    return all.filter(c => c.time >= from && c.time <= to);
  }
  async upsertCandles(symbol: string, tf: Timeframe, candles: StoredCandle[]) {
    const file = this.p('candles', symbol, `${tf}.json`);
    const existing = await this.readJson<StoredCandle[]>(file, []);
    const before = existing.length;
    const merged = dedupe([...existing, ...candles]);
    await this.writeJson(file, merged);
    return { inserted: merged.length - before, total: merged.length };
  }
  async getSyncState(symbol: string, tf: Timeframe) {
    const all = await this.readJson<Record<string, SyncState>>(this.p('sync.json'), {});
    return all[`${symbol}:${tf}`] ?? null;
  }
  async setSyncState(state: SyncState) {
    const file = this.p('sync.json');
    const all = await this.readJson<Record<string, SyncState>>(file, {});
    all[`${state.symbol}:${state.timeframe}`] = state;
    await this.writeJson(file, all);
  }
  async getFunding(symbol: string, from = 0, to = Infinity) {
    const all = await this.readJson<FundingPoint[]>(this.p('funding', `${symbol}.json`), []);
    return all.filter(f => f.time >= from && f.time <= to);
  }
  async upsertFunding(symbol: string, points: FundingPoint[]) {
    const file = this.p('funding', `${symbol}.json`);
    const existing = await this.readJson<FundingPoint[]>(file, []);
    const m = new Map(existing.map(f => [f.time, f.rate] as const));
    const before = m.size;
    for (const f of points) m.set(f.time, f.rate);
    await this.writeJson(file, [...m.entries()].map(([time, rate]) => ({ time, rate })).sort((a, b) => a.time - b.time));
    return m.size - before;
  }
  async saveBacktest(run: BacktestRun) { await this.writeJson(this.p('backtests', `${run.symbol}.json`), run); }
  async getBacktest(symbol: string, opts: { withTrades?: boolean } = {}) {
    const run = await this.readJson<BacktestRun | null>(this.p('backtests', `${symbol}.json`), null);
    if (run && opts.withTrades === false) return { ...run, trades: [] };
    return run;
  }
  async listBacktests() {
    try {
      const files = await fs.readdir(this.p('backtests'));
      const out = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const run = await this.readJson<BacktestRun | null>(this.p('backtests', f), null);
        if (run) out.push({ symbol: run.symbol, builtAt: run.builtAt, trades: run.trades.length, source: run.source, btcRelation: run.stats.btcRelation });
      }
      return out;
    } catch { return []; }
  }
}

/* ─── Supabase store ─────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

export class SupabaseHistoryStore implements HistoryStore {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(private url: string, private key: string, private opts: { cacheMs?: number; fetchImpl?: typeof fetch; writeToken?: string } = {}) {}

  /** Writes go through SECURITY DEFINER RPCs guarded by HISTORY_WRITE_TOKEN when no service-role key is present. */
  private async rpc(fn: string, args: Record<string, unknown>) {
    await this.rest('POST', `/rpc/${fn}`, { p_token: this.opts.writeToken, ...args });
  }

  private async rest(method: 'GET' | 'POST' | 'PATCH', pathAndQuery: string, body?: unknown, headers: Record<string, string> = {}): Promise<Row[]> {
    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`${this.url}/rest/v1${pathAndQuery}`, {
      method,
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Supabase ${res.status} ${pathAndQuery}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) as Row[] : [];
  }
  private async pagedGet(pathAndQuery: string, pageSize = 1000): Promise<Row[]> {
    const out: Row[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.rest('GET', `${pathAndQuery}&limit=${pageSize}&offset=${offset}`, undefined, { Prefer: 'count=none' });
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  }
  private async upsert(table: string, rows: Row[], onConflict: string, batch = 1000) {
    for (let i = 0; i < rows.length; i += batch) {
      const chunk = rows.slice(i, i + batch);
      if (this.opts.writeToken) { await this.rpc('hist_upsert', { p_table: table, p_rows: chunk }); continue; }
      await this.rest('POST', `/${table}?on_conflict=${onConflict}`, chunk, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    }
  }
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const ttl = this.opts.cacheMs ?? 10 * 60_000;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value as T);
    return load().then(v => { this.cache.set(key, { at: Date.now(), value: v }); return v; });
  }

  async getCandles(symbol: string, tf: Timeframe, from = 0, to = Number.MAX_SAFE_INTEGER) {
    const rows = await this.pagedGet(`/hist_candles?symbol=eq.${symbol}&timeframe=eq.${tf}&time=gte.${from}&time=lte.${to}&order=time.asc&select=time,open,high,low,close,volume,turnover`);
    return rows.map(r => ({ time: Number(r.time), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close), volume: Number(r.volume), turnover: r.turnover == null ? undefined : Number(r.turnover) }));
  }
  async upsertCandles(symbol: string, tf: Timeframe, candles: StoredCandle[]) {
    const rows = dedupe(candles).map(c => ({ symbol, timeframe: tf, time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, turnover: c.turnover ?? null }));
    await this.upsert('hist_candles', rows, 'symbol,timeframe,time');
    const cnt = await this.rest('GET', `/hist_candles?symbol=eq.${symbol}&timeframe=eq.${tf}&select=time&limit=1`, undefined, { Prefer: 'count=exact' }).catch(() => []);
    return { inserted: rows.length, total: cnt.length ? rows.length : rows.length };
  }
  async getSyncState(symbol: string, tf: Timeframe) {
    const rows = await this.rest('GET', `/hist_sync_state?symbol=eq.${symbol}&timeframe=eq.${tf}&select=*`);
    const r = rows[0];
    return r ? { symbol, timeframe: tf, firstTime: Number(r.first_time), lastTime: Number(r.last_time), count: Number(r.count), updatedAt: String(r.updated_at), source: r.source ? String(r.source) : undefined } : null;
  }
  async setSyncState(s: SyncState) {
    await this.upsert('hist_sync_state', [{ symbol: s.symbol, timeframe: s.timeframe, first_time: s.firstTime, last_time: s.lastTime, count: s.count, updated_at: s.updatedAt, source: s.source ?? null }], 'symbol,timeframe');
  }
  async getFunding(symbol: string, from = 0, to = Number.MAX_SAFE_INTEGER) {
    const rows = await this.pagedGet(`/hist_funding?symbol=eq.${symbol}&time=gte.${from}&time=lte.${to}&order=time.asc&select=time,rate`);
    return rows.map(r => ({ time: Number(r.time), rate: Number(r.rate) }));
  }
  async upsertFunding(symbol: string, points: FundingPoint[]) {
    await this.upsert('hist_funding', points.map(p => ({ symbol, time: p.time, rate: p.rate })), 'symbol,time');
    return points.length;
  }
  async saveBacktest(run: BacktestRun) {
    const { trades, ...meta } = run;
    await this.upsert('hist_backtest_runs', [{
      symbol: meta.symbol, version: meta.version, built_at: meta.builtAt, source: meta.source ?? null, config: meta.config, coverage: meta.coverage,
      decisions: meta.decisions, neutral_decisions: meta.neutralDecisions, skipped_while_open: meta.skippedWhileOpen,
      feature_norms: meta.featureNorms, stats: meta.stats,
    }], 'symbol');
    // replace trades for this symbol
    if (this.opts.writeToken) await this.rpc('hist_delete_backtest_trades', { p_symbol: run.symbol });
    else {
      const f = this.opts.fetchImpl ?? fetch;
      await f(`${this.url}/rest/v1/hist_backtest_trades?symbol=eq.${run.symbol}`, { method: 'DELETE', headers: { apikey: this.key, Authorization: `Bearer ${this.key}` } });
    }
    await this.upsert('hist_backtest_trades', trades.map(t => ({
      symbol: t.symbol, time: t.time, direction: t.direction, setup_style: t.setupStyle, score: t.score,
      first_outcome: t.firstOutcome, tp1_hit: t.tp1Hit, tp2_hit: t.tp2Hit, tp3_hit: t.tp3Hit, stop_hit: t.stopHit,
      net_r: t.netR, gross_r: t.grossR, mfe_r: t.mfeR, mae_r: t.maeR, hold_ms: t.holdMs, regime_key: t.regimeKey, payload: t,
    })), 'symbol,time,direction', 500);
    this.cache.delete(`bt:${run.symbol}`);
  }
  async getBacktest(symbol: string, opts: { withTrades?: boolean } = {}) {
    return this.cached(`bt:${symbol}:${opts.withTrades !== false}`, async () => {
      const rows = await this.rest('GET', `/hist_backtest_runs?symbol=eq.${symbol}&select=*`);
      const r = rows[0];
      if (!r) return null;
      let trades: BacktestTrade[] = [];
      if (opts.withTrades !== false) {
        const trows = await this.pagedGet(`/hist_backtest_trades?symbol=eq.${symbol}&order=time.asc&select=payload`);
        trades = trows.map(x => x.payload as BacktestTrade);
      }
      return {
        symbol, version: Number(r.version), builtAt: String(r.built_at), source: r.source ? String(r.source) : undefined, config: r.config as BacktestRun['config'],
        coverage: r.coverage as BacktestRun['coverage'], decisions: Number(r.decisions), neutralDecisions: Number(r.neutral_decisions),
        skippedWhileOpen: Number(r.skipped_while_open), featureNorms: r.feature_norms as BacktestRun['featureNorms'],
        stats: r.stats as BacktestRun['stats'], trades,
      } as BacktestRun;
    });
  }
  async listBacktests() {
    const rows = await this.rest('GET', `/hist_backtest_runs?select=symbol,built_at,decisions,source,stats`);
    return rows.map(r => ({ symbol: String(r.symbol), builtAt: String(r.built_at), trades: Number(r.decisions), source: r.source ? String(r.source) : undefined, btcRelation: (r.stats as BacktestRun['stats'] | undefined)?.btcRelation }));
  }
}

/* ─── Factory ────────────────────────────────────────────────────────────── */

const SUPABASE_URL_DEFAULT = 'https://mrhekpgvfcwfnzmipjis.supabase.co';
const SUPABASE_ANON_DEFAULT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1yaGVrcGd2ZmN3Zm56bWlwamlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxMzQxMTQsImV4cCI6MjA5NTcxMDExNH0.mopznBoOZAhTeir31cJXlqnUPhIO9tk9eD4W5m1j_w4';

let singleton: HistoryStore | null = null;

/**
 * mode 'read'  → Supabase with anon key (works everywhere), unless HISTORY_STORE=file.
 * mode 'write' → Supabase with service-role key when present; else file store.
 */
export function getHistoryStore(mode: 'read' | 'write' = 'read'): HistoryStore {
  if (process.env.HISTORY_STORE === 'file') return singleton ??= new FileHistoryStore();
  const url = process.env.SUPABASE_URL ?? SUPABASE_URL_DEFAULT;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (mode === 'write') {
    if (service) return new SupabaseHistoryStore(url, service);
    const token = process.env.HISTORY_WRITE_TOKEN;
    if (token) return new SupabaseHistoryStore(url, process.env.SUPABASE_ANON_KEY || SUPABASE_ANON_DEFAULT, { writeToken: token });
    return new FileHistoryStore();
  }
  return singleton ??= new SupabaseHistoryStore(url, service || process.env.SUPABASE_ANON_KEY || SUPABASE_ANON_DEFAULT);
}
