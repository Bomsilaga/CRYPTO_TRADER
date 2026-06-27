/**
 * bybit.ts — Bybit Public Market Data
 *
 * OPPOSER FIX 1: Price source mismatch (LETHAL)
 * ─────────────────────────────────────────────
 * The original file was named bybit.ts but fetched from KuCoin.
 * This caused all signal entries, stop losses, and take profits
 * to be calculated on KuCoin prices while orders executed on Bybit.
 * On volatile pairs this divergence is 0.05–1.5%, which corrupts
 * stop placement and can trigger stops on valid setups.
 *
 * This file now uses Bybit's public V5 API exclusively.
 * No API key required for market data endpoints.
 * The trade/route.ts already uses Bybit for execution — now
 * signals and execution use the same price source.
 */

const BYBIT_PUBLIC = 'https://api.bybit.com';

export interface RawCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function bybitFetch(url: string, retries = 4): Promise<unknown> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 429) {
      if (attempt === retries) throw new Error(`Bybit rate limit (429) — ${url}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status} — ${url}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error(`Bybit bad JSON: ${text.slice(0, 120)}`); }
  }
  throw new Error(`Bybit fetch failed after ${retries} retries`);
}

// Bybit interval map — V5 linear kline
const IV: Record<string, string> = {
  '1': '1', '5': '5', '15': '15', '60': '60', '240': '240',
  'D': 'D', 'W': 'W',
  '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D',
};

export async function fetchKlines(symbol: string, interval: string, limit = 200): Promise<RawCandle[]> {
  const iv = IV[interval] ?? '60';
  const url = `${BYBIT_PUBLIC}/v5/market/kline?category=linear&symbol=${symbol}&interval=${iv}&limit=${limit}`;
  const json = await bybitFetch(url) as { retCode: number; result: { list: string[][] } };
  if (json.retCode !== 0) throw new Error(`Bybit kline error for ${symbol}`);
  // Bybit returns newest first — reverse to chronological
  return (json.result?.list ?? [])
    .reverse()
    .map(([t, o, h, l, c, v]) => ({
      time:   Number(t),
      open:   parseFloat(o),
      high:   parseFloat(h),
      low:    parseFloat(l),
      close:  parseFloat(c),
      volume: parseFloat(v),
    }));
}

export async function fetchTicker(symbol: string): Promise<{ price: number; change24h: number; volume24h: number }> {
  const url = `${BYBIT_PUBLIC}/v5/market/tickers?category=linear&symbol=${symbol}`;
  const json = await bybitFetch(url) as { retCode: number; result: { list: Record<string, string>[] } };
  if (json.retCode !== 0) throw new Error(`Bybit ticker error for ${symbol}`);
  const d = json.result?.list?.[0];
  if (!d) throw new Error(`No ticker data for ${symbol}`);
  return {
    price:     parseFloat(d.lastPrice),
    change24h: parseFloat(d.price24hPcnt) * 100,
    volume24h: parseFloat(d.turnover24h),
  };
}

export async function fetchAllTickers(): Promise<{ symbol: string; price: number; change24h: number; volume24h: number }[]> {
  const url = `${BYBIT_PUBLIC}/v5/market/tickers?category=linear`;
  const json = await bybitFetch(url) as { retCode: number; result: { list: Record<string, string>[] } };
  if (json.retCode !== 0) throw new Error(`Bybit allTickers error`);
  return (json.result?.list ?? [])
    .filter(t => t.symbol?.endsWith('USDT') && t.symbol !== 'USDT')
    .map(t => ({
      symbol:    t.symbol,
      price:     parseFloat(t.lastPrice),
      change24h: parseFloat(t.price24hPcnt) * 100,
      volume24h: parseFloat(t.turnover24h),
    }))
    .filter(t => t.price > 0 && t.volume24h > 0);
}

/**
 * OPPOSER FIX 3 (Grey Zone): Funding rate check before trade
 * Returns current funding rate for a symbol.
 * Positive = longs pay shorts. Negative = shorts pay longs.
 * Threshold: reject longs if > +0.10%, reject shorts if < -0.10%
 */
export async function fetchFundingRate(symbol: string): Promise<number> {
  const url = `${BYBIT_PUBLIC}/v5/market/tickers?category=linear&symbol=${symbol}`;
  const json = await bybitFetch(url) as { retCode: number; result: { list: Record<string, string>[] } };
  if (json.retCode !== 0) return 0;
  const d = json.result?.list?.[0];
  return d ? parseFloat(d.fundingRate) : 0;
}
