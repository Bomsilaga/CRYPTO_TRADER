/** evidence/route.ts — read-only historical statistics for a pair (no per-trade payloads). */
import { NextRequest, NextResponse } from 'next/server';
import { getHistoryStore } from '@/lib/history/store';
import { buildEvidence } from '@/lib/history/evidence';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get('symbol') ?? '').toUpperCase();
  const store = getHistoryStore('read');
  try {
    if (!symbol) return NextResponse.json({ ok: true, runs: await store.listBacktests() });
    const run = await store.getBacktest(symbol, { withTrades: false });
    if (!run) return NextResponse.json({ ok: false, symbol, reason: 'no backtest for this pair' }, { status: 404 });
    return NextResponse.json({
      ok: true, symbol, builtAt: run.builtAt, config: run.config, coverage: run.coverage, decisions: run.decisions, neutralDecisions: run.neutralDecisions,
      LONG: buildEvidence({ run: { ...run, trades: [] }, symbol, direction: 'LONG' }),
      SHORT: buildEvidence({ run: { ...run, trades: [] }, symbol, direction: 'SHORT' }),
      stats: { all: run.stats.all, LONG: run.stats.LONG, SHORT: run.stats.SHORT, walkForward: run.stats.walkForward, decay: run.stats.decay, btcSplit: run.stats.btcSplit },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
