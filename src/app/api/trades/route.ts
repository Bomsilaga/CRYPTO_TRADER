import { NextRequest, NextResponse } from 'next/server';
import { supabaseFetch } from '@/lib/supabase';

type TradeRow = Record<string, unknown>;

function toDb(t: TradeRow, syncKey: string) {
  return {
    id:                t.id,
    sync_key:          syncKey,
    symbol:            t.symbol,
    direction:         t.direction,
    entry:             t.entry,
    stop_loss:         t.stopLoss,
    tp1:               t.tp1,
    tp2:               t.tp2,
    tp3:               t.tp3,
    leverage:          t.leverage,
    risk_pct:          t.riskPct,
    order_type:        t.orderType,
    mode:              t.mode,
    timestamp:         t.timestamp,
    timezone:          t.timezone,
    score:             t.score ?? 0,
    confidence:        t.confidence ?? 0,
    best_setup:        t.bestSetup ?? '',
    net_rr:            t.netRR ?? 0,
    qty:               t.qty ?? 0,
    position_notional: t.positionNotional ?? 0,
    margin_used:       t.marginUsed ?? 0,
    status:            t.status,
    exit_price:        t.exitPrice ?? null,
    pnl_dollars:       t.pnlDollars ?? null,
    order_id:          t.orderId ?? null,
    notes:             t.notes ?? '',
    highest_price:     t.highestPrice ?? null,
    lowest_price:      t.lowestPrice ?? null,
    hourly_candles:    t.hourlyCandles ?? [],
    full_analysis:     t.fullAnalysis ?? {},
    tp1_hit:           t.tp1Hit ?? false,
    tp2_hit:           t.tp2Hit ?? false,
    tp3_hit:           t.tp3Hit ?? false,
    updated_at:        new Date().toISOString(),
  };
}

function fromDb(row: TradeRow) {
  return {
    id:               row.id,
    symbol:           row.symbol,
    direction:        row.direction,
    entry:            Number(row.entry),
    stopLoss:         Number(row.stop_loss),
    tp1:              Number(row.tp1),
    tp2:              Number(row.tp2),
    tp3:              Number(row.tp3),
    leverage:         Number(row.leverage),
    riskPct:          Number(row.risk_pct),
    orderType:        row.order_type,
    mode:             row.mode,
    timestamp:        row.timestamp,
    timezone:         row.timezone,
    score:            Number(row.score ?? 0),
    confidence:       Number(row.confidence ?? 0),
    bestSetup:        row.best_setup ?? '',
    netRR:            Number(row.net_rr ?? 0),
    qty:              Number(row.qty ?? 0),
    positionNotional: Number(row.position_notional ?? 0),
    marginUsed:       Number(row.margin_used ?? 0),
    status:           row.status,
    exitPrice:        row.exit_price   != null ? Number(row.exit_price)   : undefined,
    pnlDollars:       row.pnl_dollars  != null ? Number(row.pnl_dollars)  : undefined,
    orderId:          row.order_id ?? undefined,
    notes:            (row.notes as string) ?? '',
    highestPrice:     row.highest_price != null ? Number(row.highest_price) : undefined,
    lowestPrice:      row.lowest_price  != null ? Number(row.lowest_price)  : undefined,
    hourlyCandles:    row.hourly_candles ?? [],
    fullAnalysis:     row.full_analysis ?? {},
    tp1Hit:           row.tp1_hit === true,
    tp2Hit:           row.tp2_hit === true,
    tp3Hit:           row.tp3_hit === true,
    createdAt:        row.created_at,
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const syncKey = searchParams.get('syncKey');
  if (!syncKey) return NextResponse.json({ error: 'syncKey required' }, { status: 400 });

  try {
    const rows = await supabaseFetch(
      `/crypto_trades?sync_key=eq.${encodeURIComponent(syncKey)}&order=created_at.desc&limit=200`
    ) as TradeRow[];
    return NextResponse.json({ ok: true, trades: (rows ?? []).map(fromDb) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { trade: TradeRow; syncKey: string };
  const { trade, syncKey } = body;
  if (!syncKey || !trade) return NextResponse.json({ error: 'syncKey and trade required' }, { status: 400 });

  try {
    await supabaseFetch('/crypto_trades', {
      method:  'POST',
      body:    JSON.stringify(toDb(trade, syncKey)),
      headers: { Prefer: 'resolution=merge-duplicates' },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
