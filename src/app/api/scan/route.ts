import { NextRequest, NextResponse } from 'next/server';
import { fetchKlines, fetchSpotKlines, fetchTicker, fetchFundingRate } from '@/lib/bybit';
import { runEngine } from '@/lib/signalEngine';
import { computeFeatures } from '@/lib/history/features';
import { buildEvidence } from '@/lib/history/evidence';
import { getHistoryStore } from '@/lib/history/store';
import type { CandleMap } from '@/lib/history/types';

export const maxDuration = 30;

function toSpotSymbol(sym: string) { return sym.replace(/^\d+/, ''); }

function normalizeSymbol(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return 'BTCUSDT';
  if (/^\d/.test(s)) return s;
  const quotes = ['USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'SOL', 'BUSD'];
  if (quotes.some(q => s.endsWith(q))) return s;
  return s + 'USDT';
}

const withTimeout = <T,>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), ms))]);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = normalizeSymbol(searchParams.get('symbol') ?? 'ETHUSDT');
  const spotSym = toSpotSymbol(symbol);
  const wantEvidence = searchParams.get('evidence') !== '0';

  try {
    const [ticker, c1m, c5m, c15m, c1h, c4h, c1d] = await Promise.all([
      fetchTicker(symbol),
      fetchKlines(symbol, '1', 80), fetchKlines(symbol, '5', 100), fetchKlines(symbol, '15', 100),
      fetchKlines(symbol, '60', 200), fetchKlines(symbol, '240', 100), fetchKlines(symbol, 'D', 100),
    ]);
    const [spotD1, spotH4, btcH1, btcH4, funding] = await Promise.allSettled([
      fetchSpotKlines(spotSym, 'D', 30), fetchSpotKlines(spotSym, '240', 40),
      symbol === 'BTCUSDT' ? Promise.resolve(c1h) : fetchKlines('BTCUSDT', '60', 200),
      symbol === 'BTCUSDT' ? Promise.resolve(c4h) : fetchKlines('BTCUSDT', '240', 100),
      fetchFundingRate(symbol),
    ]).then(r => r.map(s => (s.status === 'fulfilled' ? s.value : null)));

    const candleMap = { '1m': c1m, '5m': c5m, '15m': c15m, '1h': c1h, '4h': c4h, '1d': c1d, 'spot_1d': spotD1 ?? [], 'spot_4h': spotH4 ?? [] } as Record<string, typeof c1h>;
    const timestamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' });
    const result = runEngine(symbol, ticker.price, candleMap, timestamp);

    // Feature snapshot + independent historical evidence (never from the journal)
    let features = null, historicalEvidence = null;
    if (result.direction !== 'NEUTRAL') {
      features = computeFeatures({
        symbol, time: Date.now(), direction: result.direction, engine: result,
        candleMap: { '1m': c1m, '5m': c5m, '15m': c15m, '1h': c1h, '4h': c4h, '1d': c1d } as CandleMap,
        btcCandleMap: { '1h': (btcH1 as typeof c1h) ?? [], '4h': (btcH4 as typeof c1h) ?? [] } as CandleMap,
        fundingRate: typeof funding === 'number' ? funding : null, change24hPct: ticker.change24h,
      });
    }
    if (wantEvidence) {
      const run = await withTimeout(getHistoryStore('read').getBacktest(symbol).catch(() => null), 12_000, null);
      historicalEvidence = buildEvidence({ run, symbol, direction: result.direction, current: features });
    }

    return NextResponse.json({ ok: true, symbol, price: ticker.price, change24h: ticker.change24h, fundingRate: typeof funding === 'number' ? funding : null, ...result, features, historicalEvidence });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
