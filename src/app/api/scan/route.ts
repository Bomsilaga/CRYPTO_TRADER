import { NextRequest, NextResponse } from 'next/server';
import { fetchKlines, fetchTicker } from '@/lib/bybit';
import { runEngine } from '@/lib/signalEngine';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get('symbol') ?? 'ETHUSDT').toUpperCase();

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

    const candleMap = { '1m': c1m, '5m': c5m, '15m': c15m, '1h': c1h, '4h': c4h, '1d': c1d };
    const timestamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' });
    const result = runEngine(symbol, ticker.price, candleMap, timestamp);

    return NextResponse.json({ ok: true, symbol, price: ticker.price, change24h: ticker.change24h, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
