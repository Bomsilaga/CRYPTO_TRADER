/**
 * cron/scan/route.ts — background scan (Vercel cron, every 15 min).
 *
 * For the most liquid perpetuals it runs the full engine (structural entries),
 * attaches the pair's independent historical evidence when a replay exists,
 * and pushes ONLY setups that pass the viability gates to Telegram (and web
 * push). Gates are deterministic and server-side:
 *   - bias LONG/SHORT (never NEUTRAL), Setup Quality ≥ ALERT_SCORE
 *   - structural entry (no ATR fallback), TP2 ≥ 2R
 *   - historical evidence present: pair-wide n ≥ 20, pair-wide expectancy > 0,
 *     out-of-sample expectancy > 0 and PF ≥ 1.1, no server no-trade reasons,
 *     recent edge not NEGATIVE
 *   - liquidation buffer safe at 3×
 * De-duplicated per symbol/direction/entry-zone for 4 h via KV.
 * Auth: Authorization: Bearer $CRON_SECRET (Phase 25).
 */
import { NextRequest, NextResponse } from 'next/server';
import webpush from 'web-push';
import { fetchAllTickers, fetchKlines, fetchFundingRate } from '@/lib/bybit';
import { runEngine } from '@/lib/signalEngine';
import { getAllSubscriptions } from '@/lib/subscriptions';
import { setLastScan } from '@/lib/scanStore';
import { authorizeCron } from '@/lib/auth';
import { getKV } from '@/lib/kv';
import { getHistoryStore } from '@/lib/history/store';
import { buildEvidence, type HistoricalEvidence } from '@/lib/history/evidence';
import { computeFeatures } from '@/lib/history/features';
import type { CandleMap } from '@/lib/history/types';
import { computeRiskModel } from '@/lib/risk/riskModel';
import { formatAlert, sendTelegram, telegramConfig, type AlertCard } from '@/lib/telegram';
import { assessViability } from '@/lib/alerts';

export const maxDuration = 300;

const MIN_VOLUME = 5_000_000;
const ALERT_SCORE = Number(process.env.ALERT_SCORE ?? 70);
const BATCH = 3;
const MAX_PAIRS = Number(process.env.SCAN_MAX_PAIRS ?? 40);
const TIME_BUDGET_MS = 240_000;
const DEDUPE_SECONDS = 4 * 3600;
const DEFAULT_BLACKLIST = new Set<string>([]);
const ALERT_CAPITAL = Number(process.env.ALERT_CAPITAL ?? 5000);
const ALERT_RISK_PCT = Number(process.env.ALERT_RISK_PCT ?? 1);
const REQUIRE_HISTORY = process.env.ALERT_REQUIRE_HISTORY !== 'false';

export async function GET(req: NextRequest) {
  if (!authorizeCron(req.headers)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const pushReady = !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  if (pushReady) webpush.setVapidDetails('mailto:' + (process.env.VAPID_EMAIL ?? 'admin@4scans.app'), process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '', process.env.VAPID_PRIVATE_KEY ?? '');
  const tg = telegramConfig();
  const kv = getKV();
  const store = getHistoryStore('read');
  const appUrl = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  const timestamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' });
  const start = Date.now();
  const alerts: { symbol: string; score: number; direction: string; tier: string; entry: number; entryMode: string; entryStatus: string; viable: boolean; failed: string[]; sent?: boolean }[] = [];
  let scannedCount = 0, timedOut = false, sentCount = 0;
  const errors: string[] = [];

  try {
    const allTickers = await fetchAllTickers();
    const historyRuns = await store.listBacktests().catch(() => [] as { symbol: string }[]);
    const withHistory = new Set(historyRuns.map(r => r.symbol));
    // pairs with history first (they can pass the gates), then the rest by volume
    const candidates = allTickers
      .filter(t => t.volume24h >= MIN_VOLUME && !DEFAULT_BLACKLIST.has(t.symbol))
      .sort((a, b) => (withHistory.has(b.symbol) ? 1 : 0) - (withHistory.has(a.symbol) ? 1 : 0) || b.volume24h - a.volume24h)
      .slice(0, MAX_PAIRS);

    let btcMap: CandleMap | null = null;
    try { const [b1, b4] = await Promise.all([fetchKlines('BTCUSDT', '60', 200), fetchKlines('BTCUSDT', '240', 100)]); btcMap = { '1h': b1, '4h': b4 }; } catch { btcMap = null; }

    for (let i = 0; i < candidates.length; i += BATCH) {
      if (Date.now() - start > TIME_BUDGET_MS) { timedOut = true; break; }
      const batch = candidates.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async (t) => {
        try {
          const [c1m, c5m, c15m, c1h, c4h, c1d] = await Promise.all([
            fetchKlines(t.symbol, '1', 80), fetchKlines(t.symbol, '5', 100), fetchKlines(t.symbol, '15', 100),
            fetchKlines(t.symbol, '60', 200), fetchKlines(t.symbol, '240', 100), fetchKlines(t.symbol, 'D', 100),
          ]);
          const candleMap = { '1m': c1m, '5m': c5m, '15m': c15m, '1h': c1h, '4h': c4h, '1d': c1d };
          const eng = runEngine(t.symbol, t.price, candleMap, timestamp);
          scannedCount++;
          if (eng.direction === 'NEUTRAL' || eng.totalScore < ALERT_SCORE) return;
          const ms = eng.masterSignal;
          const tier = eng.totalScore >= 85 ? 'A+' : eng.totalScore >= 72 ? 'A' : 'B';

          // evidence (only when a replay exists — cheap check via the cached list)
          let evidence: HistoricalEvidence | null = null;
          if (withHistory.has(t.symbol)) {
            const features = computeFeatures({ symbol: t.symbol, time: Date.now(), direction: eng.direction, engine: eng, candleMap: candleMap as CandleMap, btcCandleMap: btcMap ?? undefined, change24hPct: t.change24h });
            const run = await store.getBacktest(t.symbol).catch(() => null);
            evidence = buildEvidence({ run, symbol: t.symbol, direction: eng.direction, current: features });
          }
          const risk = Math.abs(ms.entry - ms.stopLoss);
          const rTp2 = risk > 0 ? Math.abs(ms.tp2 - ms.entry) / risk : 0;
          const liqSafe = (1 / 3 - 0.005) > (risk / ms.entry) * 1.5;
          const v = assessViability({ direction: eng.direction, score: eng.totalScore, structural: ms.structural, rTp2, liqSafe, evidence, requireHistory: REQUIRE_HISTORY, alertScore: ALERT_SCORE });
          const rec: (typeof alerts)[number] = { symbol: t.symbol, score: eng.totalScore, direction: eng.direction, tier, entry: ms.entry, entryMode: ms.entryMode, entryStatus: ms.entryStatus, viable: v.viable, failed: v.failed };
          alerts.push(rec);
          if (!v.viable) return;

          // de-dupe: same symbol/direction/entry zone within 4h
          const zoneKey = Math.round(ms.entry / (Math.abs(ms.entry - ms.stopLoss) || 1) * 2);
          const dedupeKey = `tg:${t.symbol}:${eng.direction}:${zoneKey}`;
          const fresh = await kv.claim(dedupeKey, { at: Date.now() }, DEDUPE_SECONDS);
          if (!fresh) return;

          let riskBlock: AlertCard['risk'] = null;
          try {
            const rm = computeRiskModel({ capital: ALERT_CAPITAL, riskPct: ALERT_RISK_PCT, entry: ms.entry, stopLoss: ms.stopLoss, tp1: ms.tp1, tp2: ms.tp2, tp3: ms.tp3, direction: eng.direction, leverage: 3, orderType: ms.entryMode === 'MARKET' ? 'Market' : 'Limit', fundingRate8h: await fetchFundingRate(t.symbol).catch(() => null) });
            riskBlock = { capital: rm.capital, riskUsd: rm.riskAmount, notional: rm.notional, margin3x: rm.margin.x3, margin5x: rm.margin.x5, netStop: rm.net.stop, netTp1: rm.net.tp1Full, netTp2: rm.net.tp2Full, netStaged: rm.net.staged };
          } catch { riskBlock = null; }
          const card: AlertCard = {
            symbol: t.symbol, direction: eng.direction, price: t.price, score: eng.totalScore, style: eng.bestSetup,
            entry: ms.entry, entryMode: ms.entryMode, entryStatus: ms.entryStatus, entryBasis: ms.entryBasis, entryKinds: ms.entryKinds, entryTfs: ms.entryTfs, confirmation: ms.confirmation,
            stop: ms.stopLoss, stopBasis: ms.stopBasis, tp1: ms.tp1, tp2: ms.tp2, tp3: ms.tp3,
            rTp1: Math.abs(ms.tp1 - ms.entry) / risk, rTp2, rTp3: Math.abs(ms.tp3 - ms.entry) / risk, targetBasis: ms.targetBasis,
            leverage: Math.min(ms.leverage, 5),
            evidence: evidence?.available && evidence.pairWide ? {
              pairN: evidence.pairWide.n, pairQuality: evidence.pairWide.quality, pairTp1: evidence.pairWide.tp1.rate, pairExp: evidence.pairWide.expectancyR,
              oosN: evidence.outOfSample?.n ?? 0, oosExp: evidence.outOfSample?.expectancyR ?? 0, oosPf: evidence.outOfSample?.profitFactor ?? 0,
              similarN: evidence.similarSetups?.n, similarExp: evidence.similarSetups?.expectancyR, similarTp1: evidence.similarSetups?.tp1.rate,
              source: evidence.source, decay: evidence.decay?.status, btcCoupling: evidence.btcRelation?.coupling, btcAgainstPct: evidence.btcRelation?.oppositeDayShare90d,
            } : null,
            risk: riskBlock, reasonsPassed: v.passed, appUrl,
          };
          const text = formatAlert(card);
          if (tg) { const r = await sendTelegram(text, tg); if (r.ok) { sentCount++; rec.sent = true; } else errors.push(`${t.symbol}: telegram ${r.error}`); }
          if (pushReady) {
            const subs = await getAllSubscriptions().catch(() => []);
            const payload = JSON.stringify({ title: `${tier === 'A+' ? '🔥' : '⭐'} ${t.symbol} ${eng.direction} · ${ms.entryMode} ${ms.entryStatus.replace(/_/g, ' ')} @ ${ms.entry}`, body: `Score ${eng.totalScore} · ${v.passed.slice(0, 3).join(' · ')}`, icon: '/icon-192.png', badge: '/badge-72.png', data: { symbol: t.symbol, url: `/?symbol=${t.symbol}` } });
            await Promise.allSettled(subs.map(sub => webpush.sendNotification(sub, payload).catch(() => {})));
          }
        } catch (e) { errors.push(`${t.symbol}: ${String(e).slice(0, 120)}`); }
      }));
    }

    const elapsed = Date.now() - start;
    const viable = alerts.filter(a => a.viable);
    setLastScan({ timestamp, scanned: scannedCount, elapsed, alerts: viable.map(a => ({ symbol: a.symbol, score: a.score, direction: a.direction, tier: a.tier })), timedOut });
    return NextResponse.json({ ok: true, scanned: scannedCount, attempted: candidates.length, timedOut, elapsed, timestamp, telegram: tg ? 'configured' : 'not configured', sent: sentCount, candidates: alerts, errors: errors.slice(0, 10) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
