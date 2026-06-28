import { NextResponse } from 'next/server';
import { getLastScan } from '@/lib/scanStore';

export async function GET() {
  const scan = getLastScan();
  if (!scan) return NextResponse.json({ ok: false, message: 'No scan run yet — cron fires every 15 min' });
  return NextResponse.json({ ok: true, ...scan });
}
