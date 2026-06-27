import { NextRequest, NextResponse } from 'next/server';
import { fetchFundingRate, fetchAllTickers } from '@/lib/bybit';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol')?.toUpperCase();

  try {
    if (symbol) {
      const rate = await fetchFundingRate(symbol);
      const riskSide = rate > 0.001 ? 'LONG_RISK' : rate < -0.001 ? 'SHORT_RISK' : 'NEUTRAL';
      return NextResponse.json({ symbol, fundingRate: rate, fundingRatePct: (rate * 100).toFixed(4), riskSide });
    }

    // Return funding rates for top 20 pairs by volume
    const tickers = await fetchAllTickers();
    const top20 = tickers.sort((a, b) => b.volume24h - a.volume24h).slice(0, 20);
    const results = await Promise.allSettled(top20.map(t => fetchFundingRate(t.symbol)));

    const rates = top20.map((t, i) => {
      const rate = results[i].status === 'fulfilled' ? results[i].value : 0;
      return {
        symbol: t.symbol,
        fundingRate: rate,
        fundingRatePct: (rate * 100).toFixed(4),
        riskSide: rate > 0.001 ? 'LONG_RISK' : rate < -0.001 ? 'SHORT_RISK' : 'NEUTRAL',
      };
    });

    return NextResponse.json({ ok: true, count: rates.length, rates });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
