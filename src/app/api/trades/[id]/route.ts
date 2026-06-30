import { NextRequest, NextResponse } from 'next/server';
import { supabaseFetch } from '@/lib/supabase';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json() as Record<string, unknown>;

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ('notes'         in body) patch.notes           = body.notes;
  if ('status'        in body) patch.status          = body.status;
  if ('exitPrice'     in body) patch.exit_price      = body.exitPrice;
  if ('pnlDollars'    in body) patch.pnl_dollars     = body.pnlDollars;
  if ('highestPrice'  in body) patch.highest_price   = body.highestPrice;
  if ('lowestPrice'   in body) patch.lowest_price    = body.lowestPrice;
  if ('hourlyCandles' in body) patch.hourly_candles  = body.hourlyCandles;

  try {
    await supabaseFetch(`/crypto_trades?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body:   JSON.stringify(patch),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await supabaseFetch(`/crypto_trades?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
