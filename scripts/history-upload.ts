/**
 * scripts/history-upload.ts — push a file-store history (data/history) into Supabase.
 *   HISTORY_WRITE_TOKEN=… npm run history:upload -- EIGENUSDT [--candles]
 * Without --candles only the backtest run + trades + funding + sync state are uploaded (what the live scan needs).
 */
import { FileHistoryStore, SupabaseHistoryStore } from '../src/lib/history/store';
import type { Timeframe } from '../src/lib/history/types';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://mrhekpgvfcwfnzmipjis.supabase.co';
const ANON = process.env.SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1yaGVrcGd2ZmN3Zm56bWlwamlzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxMzQxMTQsImV4cCI6MjA5NTcxMDExNH0.mopznBoOZAhTeir31cJXlqnUPhIO9tk9eD4W5m1j_w4';

async function main() {
  const args = process.argv.slice(2);
  const withCandles = args.includes('--candles');
  const symbols = args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());
  const token = process.env.HISTORY_WRITE_TOKEN, service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!token && !service) { console.error('HISTORY_WRITE_TOKEN or SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }
  const src = new FileHistoryStore();
  const dst = service ? new SupabaseHistoryStore(SUPABASE_URL, service) : new SupabaseHistoryStore(SUPABASE_URL, ANON, { writeToken: token });
  for (const symbol of symbols) {
    const run = await src.getBacktest(symbol);
    if (!run) { console.log(`${symbol}: no local backtest`); continue; }
    console.log(`${symbol}: uploading run (${run.trades.length} trades)…`);
    await dst.saveBacktest(run);
    const funding = await src.getFunding(symbol);
    if (funding.length) { await dst.upsertFunding(symbol, funding); console.log(`  funding ${funding.length}`); }
    for (const tf of ['1m', '5m', '15m', '1h', '4h', '1d'] as Timeframe[]) {
      const st = await src.getSyncState(symbol, tf);
      if (!st) continue;
      if (withCandles) { const c = await src.getCandles(symbol, tf); await dst.upsertCandles(symbol, tf, c); console.log(`  ${tf} candles ${c.length}`); }
      await dst.setSyncState(st);
    }
    console.log(`  done`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
