/**
 * history/okxHistory.ts — OKX public history as a FALLBACK source.
 * Used only when Bybit is unreachable (CloudFront geo-block). Same USDT
 * perpetuals; prices track Bybit within basis points but it is a different
 * venue — runs record `source: 'okx'` and the report flags the mismatch.
 *
 * Multiplier pairs (1000PEPEUSDT on Bybit) map to PEPE-USDT-SWAP with price ×1000, volume ÷1000.
 */
import type { FundingPoint, StoredCandle, Timeframe } from './types';
import type { FetchLike } from './bybitHistory';

const BASE = 'https://www.okx.com';
const BAR: Record<Timeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc' };
const PAGE = 100;
const MIN_GAP_MS = 110;   // 20 req / 2 s
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let lastCall = 0;

export function toOkxInst(symbol: string): { instId: string; mult: number } {
  const m = symbol.match(/^(\d+)?([A-Z0-9]+?)USDT$/);
  if (!m) throw new Error(`Cannot map ${symbol} to OKX`);
  return { instId: `${m[2]}-USDT-SWAP`, mult: m[1] ? Number(m[1]) : 1 };
}

const defaultFetch: FetchLike = (url) => fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });

async function getJson(url: string, fetchImpl: FetchLike, retries = 5): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res: Awaited<ReturnType<FetchLike>>;
    try { res = await fetchImpl(url); } catch (e) { if (attempt === retries) throw e; await sleep(500 * 2 ** attempt); continue; }
    if (res.status === 429 || res.status >= 500) { if (attempt === retries) throw new Error(`OKX HTTP ${res.status}`); await sleep(800 * 2 ** attempt); continue; }
    if (!res.ok) throw new Error(`OKX HTTP ${res.status} — ${url}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`OKX bad JSON: ${text.slice(0, 120)}`); }
  }
  throw new Error('unreachable');
}

export async function okxFetchKlinesRange(
  symbol: string, tf: Timeframe, startMs: number, endMs: number = Date.now(),
  opts: { fetchImpl?: FetchLike; onPage?: (c: StoredCandle[]) => Promise<void> | void; maxPages?: number } = {},
): Promise<StoredCandle[]> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const { instId, mult } = toOkxInst(symbol);
  const seen = new Map<number, StoredCandle>();
  let after = endMs + 1;          // OKX returns records with ts < after
  let pages = 0;
  while (pages < (opts.maxPages ?? 20_000)) {
    const url = `${BASE}/api/v5/market/history-candles?instId=${instId}&bar=${BAR[tf]}&after=${after}&limit=${PAGE}`;
    const json = await getJson(url, fetchImpl) as { code: string; msg?: string; data?: string[][] };
    if (json.code !== '0') throw new Error(`OKX candles ${symbol} ${tf}: ${json.msg ?? json.code}`);
    const rows = json.data ?? [];
    pages++;
    if (!rows.length) break;
    const fresh: StoredCandle[] = [];
    for (const [ts, o, h, l, c, , volCcy, volQuote] of rows) {
      const t = Number(ts);
      if (t < startMs || t > endMs || seen.has(t)) continue;
      const cd: StoredCandle = { time: t, open: +o * mult, high: +h * mult, low: +l * mult, close: +c * mult, volume: +volCcy / mult, turnover: volQuote !== undefined ? +volQuote : undefined };
      seen.set(t, cd); fresh.push(cd);
    }
    if (opts.onPage && fresh.length) await opts.onPage(fresh.sort((a, b) => a.time - b.time));
    const oldest = Math.min(...rows.map(r => Number(r[0])));
    if (oldest <= startMs || rows.length < PAGE) break;
    after = oldest;
  }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

export async function okxFetchFundingRange(symbol: string, startMs: number, endMs: number = Date.now(), opts: { fetchImpl?: FetchLike; maxPages?: number } = {}): Promise<FundingPoint[]> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const { instId } = toOkxInst(symbol);
  const out = new Map<number, number>();
  let after = endMs + 1;
  let pages = 0;
  while (pages < (opts.maxPages ?? 5000)) {
    const url = `${BASE}/api/v5/public/funding-rate-history?instId=${instId}&after=${after}&limit=100`;
    const json = await getJson(url, fetchImpl) as { code: string; msg?: string; data?: { fundingRate: string; fundingTime: string }[] };
    if (json.code !== '0') throw new Error(`OKX funding ${symbol}: ${json.msg ?? json.code}`);
    const rows = json.data ?? [];
    pages++;
    if (!rows.length) break;
    for (const r of rows) { const t = Number(r.fundingTime); if (t >= startMs && t <= endMs) out.set(t, parseFloat(r.fundingRate)); }
    const oldest = Math.min(...rows.map(r => Number(r.fundingTime)));
    if (oldest <= startMs || rows.length < 100) break;
    after = oldest;
  }
  return [...out.entries()].map(([time, rate]) => ({ time, rate })).sort((a, b) => a.time - b.time);
}
