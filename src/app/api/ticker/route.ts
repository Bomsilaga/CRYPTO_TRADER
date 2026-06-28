import { NextRequest, NextResponse } from 'next/server';
import { fetchTicker } from '@/lib/bybit';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbols = (searchParams.get('symbols') ?? '').toUpperCase().split(',').filter(Boolean);
  if (!symbols.length) return NextResponse.json({ error: 'No symbols' }, { status: 400 });
  try {
    const prices = await Promise.all(
      symbols.map(async s => {
        try {
          const t = await fetchTicker(s);
          return { symbol: s, price: t.price, change24h: t.change24h };
        } catch {
          return { symbol: s, price: null, change24h: null };
        }
      })
    );
    return NextResponse.json({ ok: true, prices });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
