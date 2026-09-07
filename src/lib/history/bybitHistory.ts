/**
 * history/bybitHistory.ts — paginated Bybit V5 public history.
 *
 * - kline endpoint returns at most 1000 candles per call, newest first.
 * - We page backwards with `end`, de-duplicate by open time, sort ascending.
 * - Rate limiting: fixed inter-request gap + exponential backoff on 429/5xx.
 * - BYBIT_PROXY_URL (optional) prefixes the base URL for regions where
 *   api.bybit.com is CloudFront-blocked.
 */
import type { FundingPoint, StoredCandle, Timeframe } from './types';
import { TF_MS } from './types';

const BASE = () => process.env.BYBIT_PROXY_URL?.replace(/\/$/, '') || 'https://api.bybit.com';
const IV: Record<Timeframe, string> = { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
const PAGE = 1000;
const MIN_GAP_MS = 120;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

export type FetchLike = (url: string) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;
const defaultFetch: FetchLike = (url) => fetch(url, {
  cache: 'no-store',
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; 4scans-history/1.0)', Accept: 'application/json' },
});

async function getJson(url: string, fetchImpl: FetchLike, retries = 5): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchImpl(url);
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 403) throw new Error('Bybit 403 — region blocked. Set BYBIT_PROXY_URL or run from an allowed region.');
    if (res.status === 429 || res.status >= 500) {
      if (attempt === retries) throw new Error(`Bybit HTTP ${res.status} after ${retries} retries — ${url}`);
      await sleep(800 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status} — ${url}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`Bybit bad JSON: ${text.slice(0, 120)}`); }
  }
  throw new Error('unreachable');
}

interface KlineJson { retCode: number; retMsg?: string; result?: { list?: string[][] } }

function parse(list: string[][]): StoredCandle[] {
  return list.map(([t, o, h, l, c, v, to]) => ({
    time: Number(t), open: +o, high: +h, low: +l, close: +c, volume: +v, turnover: to !== undefined ? +to : undefined,
  }));
}

/**
 * Fetch every candle with open time in [startMs, endMs]. Pages backwards.
 * `onPage` lets a caller persist incrementally (useful under function timeouts).
 */
export async function fetchKlinesRange(
  symbol: string,
  tf: Timeframe,
  startMs: number,
  endMs: number = Date.now(),
  opts: { fetchImpl?: FetchLike; onPage?: (c: StoredCandle[]) => Promise<void> | void; maxPages?: number; category?: 'linear' | 'spot' } = {},
): Promise<StoredCandle[]> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const step = TF_MS[tf];
  const seen = new Map<number, StoredCandle>();
  let cursorEnd = endMs;
  let pages = 0;
  const maxPages = opts.maxPages ?? 10_000;

  while (cursorEnd >= startMs && pages < maxPages) {
    const url = `${BASE()}/v5/market/kline?category=${opts.category ?? 'linear'}&symbol=${symbol}&interval=${IV[tf]}&limit=${PAGE}&start=${Math.max(0, startMs)}&end=${cursorEnd}`;
    const json = await getJson(url, fetchImpl) as KlineJson;
    if (json.retCode !== 0) throw new Error(`Bybit kline ${symbol} ${tf}: ${json.retMsg ?? json.retCode}`);
    const page = parse(json.result?.list ?? []);
    pages++;
    if (!page.length) break;
    const fresh: StoredCandle[] = [];
    for (const c of page) {
      if (c.time < startMs || c.time > endMs) continue;
      if (!seen.has(c.time)) { seen.set(c.time, c); fresh.push(c); }
    }
    if (opts.onPage && fresh.length) await opts.onPage(fresh.sort((a, b) => a.time - b.time));
    const oldest = Math.min(...page.map(c => c.time));
    if (oldest <= startMs) break;
    if (page.length < PAGE) break;                // exchange has no older data
    cursorEnd = oldest - step;
  }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

/** Funding history (8h settlements). Bybit pages backwards with `endTime`, 200 per page. */
export async function fetchFundingRange(
  symbol: string, startMs: number, endMs: number = Date.now(), opts: { fetchImpl?: FetchLike; maxPages?: number } = {},
): Promise<FundingPoint[]> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const out = new Map<number, number>();
  let cursorEnd = endMs;
  let pages = 0;
  while (cursorEnd >= startMs && pages < (opts.maxPages ?? 2000)) {
    const url = `${BASE()}/v5/market/funding/history?category=linear&symbol=${symbol}&limit=200&startTime=${Math.max(0, startMs)}&endTime=${cursorEnd}`;
    const json = await getJson(url, fetchImpl) as { retCode: number; retMsg?: string; result?: { list?: { fundingRate: string; fundingRateTimestamp: string }[] } };
    if (json.retCode !== 0) throw new Error(`Bybit funding ${symbol}: ${json.retMsg ?? json.retCode}`);
    const list = json.result?.list ?? [];
    pages++;
    if (!list.length) break;
    for (const f of list) out.set(Number(f.fundingRateTimestamp), parseFloat(f.fundingRate));
    const oldest = Math.min(...list.map(f => Number(f.fundingRateTimestamp)));
    if (oldest <= startMs || list.length < 200) break;
    cursorEnd = oldest - 1;
  }
  return [...out.entries()].map(([time, rate]) => ({ time, rate })).sort((a, b) => a.time - b.time);
}

/** Default history depth targets per timeframe (ms). */
export const HISTORY_DEPTH_MS: Record<Timeframe, number> = {
  '1m':  21 * 86_400_000,          // 3 weeks
  '5m':  270 * 86_400_000,         // ~9 months
  '15m': 400 * 86_400_000,         // ~13 months
  '1h':  3 * 365 * 86_400_000,     // 3 years
  '4h':  5 * 365 * 86_400_000,     // 5 years (exchange returns what exists)
  '1d':  10 * 365 * 86_400_000,    // effectively all
};
