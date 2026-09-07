/**
 * scripts/history-build.ts — download exchange history and replay it for one or more pairs.
 *
 *   npm run history:build -- EIGENUSDT ETHUSDT
 *   HISTORY_STORE=file npm run history:build -- SOLUSDT      # local JSON cache instead of Supabase
 *   BYBIT_PROXY_URL=https://your-proxy npm run history:build -- BTCUSDT
 *
 * Requires SUPABASE_SERVICE_ROLE_KEY for Supabase writes (or HISTORY_STORE=file).
 */
import { buildPair } from '../src/lib/history/pipeline';
import { getHistoryStore } from '../src/lib/history/store';
import { fmtR, pct } from '../src/lib/history/stats';

async function main() {
  const symbols = process.argv.slice(2).map(s => s.toUpperCase()).filter(Boolean);
  if (!symbols.length) { console.error('usage: npm run history:build -- SYMBOL [SYMBOL...]'); process.exit(1); }
  const store = getHistoryStore('write');
  for (const symbol of symbols) {
    console.log(`\n=== ${symbol} ===`);
    const r = await buildPair(symbol, { store, log: m => console.log('  ' + m) });
    for (const s of r.sync) console.log(`  ${s.timeframe.padEnd(4)} fetched ${String(s.fetched).padStart(6)}  stored ${String(s.count).padStart(7)}  ${s.firstTime ? new Date(s.firstTime).toISOString().slice(0, 10) : '-'} → ${s.lastTime ? new Date(s.lastTime).toISOString().slice(0, 10) : '-'}`);
    console.log(`  funding points +${r.funding}`);
    if (r.backtest) {
      const run = await store.getBacktest(symbol, { withTrades: false });
      console.log(`  replay: ${r.backtest.decisions} decisions · ${r.backtest.neutral} neutral · ${r.backtest.trades} trades`);
      if (run) for (const d of ['LONG', 'SHORT'] as const) {
        const s = run.stats[d], oos = run.stats.walkForward[d].outOfSample;
        console.log(`  ${d.padEnd(5)} n=${s.n} [${s.quality}] TP1 ${pct(s.tp1.rate)} TP2 ${pct(s.tp2.rate)} TP3 ${pct(s.tp3.rate)} stop-first ${pct(s.stopFirst.rate)} exp ${fmtR(s.expectancyR)} PF ${s.profitFactor.toFixed(2)} | OOS n=${oos.n} exp ${fmtR(oos.expectancyR)} PF ${oos.profitFactor.toFixed(2)} | decay ${run.stats.decay[d].status}`);
      }
    }
    for (const n of r.notes) console.log('  note: ' + n);
    console.log(`  ${(r.elapsedMs / 1000).toFixed(1)}s ${r.complete ? 'complete' : 'INCOMPLETE — run again'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
