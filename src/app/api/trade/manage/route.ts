/**
 * trade/manage/route.ts — advance a live trade's state machine (limit fills, partial fills, protection).
 * Requires the execution token. Idempotent; safe to poll.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdmin } from '@/lib/auth';
import { getKV } from '@/lib/kv';
import { makeBybitClient } from '@/lib/bybitPrivate';
import { manageTrade, type TradeRecord } from '@/lib/execution';

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!authorizeAdmin(req.headers)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const kv = getKV();
  if (!kv.durable) return NextResponse.json({ error: 'no durable KV configured' }, { status: 503 });
  const body = await req.json().catch(() => ({})) as { tradeId?: string; apiKey?: string; apiSecret?: string };
  const tradeId = String(body.tradeId ?? '');
  const rec = await kv.get<TradeRecord>(`traderec:${tradeId}`);
  if (!rec) return NextResponse.json({ error: 'unknown tradeId' }, { status: 404 });
  const key = body.apiKey || process.env.BYBIT_API_KEY, secret = body.apiSecret || process.env.BYBIT_API_SECRET;
  if (!key || !secret) return NextResponse.json({ error: 'no credentials' }, { status: 400 });
  try {
    const client = makeBybitClient(key, secret);
    const updated = await manageTrade(client, rec);
    const pos = (await client.positions(rec.symbol))[0] ?? null;
    await kv.set(`traderec:${tradeId}`, updated, 30 * 86_400);
    return NextResponse.json({ ok: true, state: updated.state, slVerified: updated.slVerified, tpOrders: updated.tpOrders, actual: updated.actual, events: updated.events.slice(-12), position: pos });
  } catch (err) {
    return NextResponse.json({ error: String(err), state: rec.state }, { status: 500 });
  }
}
