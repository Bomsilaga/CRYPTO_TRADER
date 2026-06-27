import { NextRequest, NextResponse } from 'next/server';
import type { PushSubscription } from 'web-push';
import { addSubscription, removeSubscription } from '@/lib/subscriptions';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { subscription: PushSubscription };
    if (!body.subscription?.endpoint) {
      return NextResponse.json({ error: 'Invalid subscription object' }, { status: 400 });
    }
    await addSubscription(body.subscription);
    return NextResponse.json({ ok: true, message: 'Subscribed to push notifications' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json() as { endpoint: string };
    if (!body.endpoint) {
      return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
    }
    await removeSubscription(body.endpoint);
    return NextResponse.json({ ok: true, message: 'Unsubscribed from push notifications' });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
