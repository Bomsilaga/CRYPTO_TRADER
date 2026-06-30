import { NextResponse } from 'next/server';
import { fetchAllTickers } from '@/lib/bybit';

export async function GET() {
  try {
    const tickers = await fetchAllTickers();
    // Return all pairs sorted by volume, client filters by name
    return NextResponse.json({
      ok: true,
      markets: tickers
        .sort((a, b) => b.volume24h - a.volume24h)
        .map(t => ({
          symbol:    t.symbol,
          price:     t.price,
          change24h: t.change24h,
          volume24h: t.volume24h,
        })),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
