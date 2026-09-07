import { NextResponse } from 'next/server';
import { getHistoryStore } from '@/lib/history/store';
export async function GET() {
  try { return NextResponse.json({ ok: true, runs: await getHistoryStore('read').listBacktests() }); }
  catch (err) { return NextResponse.json({ ok: false, error: String(err) }, { status: 500 }); }
}
