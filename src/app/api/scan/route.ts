import { NextRequest, NextResponse } from 'next/server';
import { fetchKlines, fetchSpotKlines, fetchTicker } from '@/lib/bybit';
import { runEngine } from '@/lib/signalEngine';

// Strip multiplier prefix (1000PEPEUSDT → PEPEUSDT, 10000SHIBUSDT → SHIBUSDT)
function toSpotSymbol(sym: string) {
  return sym.replace(/^\d+/, '');
}

function normalizeSymbol(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return 'BTCUSDT';
  if (/^\d/.test(s)) return s; // multiplier pairs e.g. 1000PEPEUSDT
  const quotes = ['USDT','USDC','BTC','ETH','BNB','SOL','BUSD'];
  if (quotes.some(q => s.endsWith(q))) return s;
  return s + 'USDT';
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = normalizeSymbol(searchParams.get('symbol') ?? 'ETHUSDT');
  const spotSym = toSpotSymbol(symbol);

  try {
    const [ticker, c1m, c5m, c15m, c1h, c4h, c1d] = await Promise.all([
      fetchTicker(symbol),
      fetchKlines(symbol, '1',   80),
      fetchKlines(symbol, '5',   100),
      fetchKlines(symbol, '15',  100),
      fetchKlines(symbol, '60',  200),
      fetchKlines(symbol, '240', 100),
      fetchKlines(symbol, 'D',   100),
    ]);

    // Fetch spot candles for historical range comparison — failures silently ignored
    const [spotD1, spotH4] = await Promise.allSettled([
      fetchSpotKlines(spotSym, 'D',   30),
      fetchSpotKlines(spotSym, '240', 40),
    ]).then(r => r.map(s => (s.status === 'fulfilled' ? s.value : [])));

    const candleMap = {
      '1m': c1m, '5m': c5m, '15m': c15m, '1h': c1h, '4h': c4h, '1d': c1d,
      'spot_1d': spotD1, 'spot_4h': spotH4,
    };
    const timestamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' });
    const result = runEngine(symbol, ticker.price, candleMap, timestamp);

    return NextResponse.json({ ok: true, symbol, price: ticker.price, change24h: ticker.change24h, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
