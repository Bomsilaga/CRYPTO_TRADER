/**
 * cron/scan/route.ts — Automated Background Scan
 *
 * OPPOSER FIX (Strike 5): Vercel timeout — cron scans all pairs but times out
 * ─────────────────────────────────────────────────────────────────────────────
 * Original: scanned unlimited pairs in batches of 6 — total runtime 200+ seconds
 * Vercel free tier: 10s timeout. Pro: 300s. Neither works for 100+ pairs.
 *
 * Fix strategy:
 * 1. Hard cap: scan TOP 30 pairs only (most liquid = best signal quality anyway)
 * 2. Batch size reduced to 3 (safer concurrency for rate limits)
 * 3. Per-batch time budget: abort if total elapsed > 8 seconds
 * 4. Pairs sorted by volume — highest liquidity first, so best pairs scanned first
 *
 * Why 30 pairs: At 6 TF × 3 pairs per batch, 10 batches × ~700ms = ~7 seconds.
 * This fits within Vercel free tier with 2 seconds margin.
 *
 * CANNOT FULLY FIX: The fundamental architectural tension between serverless
 * functions (short-lived, stateless, time-limited) and full-market scanning
 * (long-running, stateful, sequential) means a truly comprehensive scan
 * requires either: (a) Vercel Pro/Enterprise, (b) a persistent server
 * (Railway/Fly.io), or (c) splitting the scan across multiple cron invocations.
 * Option (c) is noted as the recommended future architecture.
 */

import { NextRequest, NextResponse } from 'next/server';
import webpush from 'web-push';
import { fetchAllTickers, fetchKlines } from '@/lib/bybit';
import { runEngine } from '@/lib/signalEngine';
import { getAllSubscriptions } from '@/lib/subscriptions';
import { setLastScan } from '@/lib/scanStore';

const MIN_VOLUME  = 5_000_000; // raised from 1M — better liquidity = tighter spreads
const ALERT_SCORE = 80;
const BATCH       = 3;
const MAX_PAIRS   = 30;        // hard cap to stay within Vercel free tier 10s limit
const TIME_BUDGET_MS = 8_500;  // abort scan if approaching timeout

// BTC excluded by default — too volatile for rules-based stop placement
const DEFAULT_BLACKLIST = new Set(['BTCUSDT']);

export async function GET(_req: NextRequest) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_EMAIL ?? 'admin@4scans.app'),
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '',
    process.env.VAPID_PRIVATE_KEY ?? '',
  );
  const timestamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' });
  const start = Date.now();
  const alerts: { symbol: string; score: number; direction: string; tier: string }[] = [];
  let scannedCount = 0;
  let timedOut = false;

  try {
    const allTickers = await fetchAllTickers();

    // Take top MAX_PAIRS by volume, excluding blacklist
    const candidates = allTickers
      .filter(t => t.volume24h >= MIN_VOLUME && !DEFAULT_BLACKLIST.has(t.symbol))
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, MAX_PAIRS);

    for (let i = 0; i < candidates.length; i += BATCH) {
      // Time budget guard — abort if we're approaching the function timeout
      if (Date.now() - start > TIME_BUDGET_MS) {
        timedOut = true;
        break;
      }

      const batch = candidates.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(async (t) => {
          try {
            const [c1m, c5m, c15m, c1h, c4h, c1d] = await Promise.all([
              fetchKlines(t.symbol, '1',   80),
              fetchKlines(t.symbol, '5',   100),
              fetchKlines(t.symbol, '15',  100),
              fetchKlines(t.symbol, '60',  200),
              fetchKlines(t.symbol, '240', 100),
              fetchKlines(t.symbol, 'D',   100),
            ]);
            const candleMap = { '1m': c1m, '5m': c5m, '15m': c15m, '1h': c1h, '4h': c4h, '1d': c1d };
            const eng = runEngine(t.symbol, t.price, candleMap, timestamp);
            scannedCount++;

            if (eng.totalScore >= ALERT_SCORE && eng.direction !== 'NEUTRAL') {
              const tier = eng.totalScore >= 85 ? 'A+' : eng.totalScore >= 72 ? 'A' : 'B';
              alerts.push({ symbol: t.symbol, score: eng.totalScore, direction: eng.direction, tier });
            }
          } catch { /* skip failed symbols silently */ }
        })
      );
    }

    // Send push notifications
    if (alerts.length > 0) {
      const subs = await getAllSubscriptions();
      const emoji = (tier: string) => tier === 'A+' ? '🔥' : tier === 'A' ? '⭐' : '✅';

      for (const alert of alerts) {
        const payload = JSON.stringify({
          title: `${emoji(alert.tier)} ${alert.symbol} — ${alert.direction} [${alert.tier}]`,
          body:  `Score ${alert.score}/100 · Elite signal detected · Tap to analyse`,
          icon:  '/icon-192.png',
          badge: '/badge-72.png',
          data:  { symbol: alert.symbol, url: `/?symbol=${alert.symbol}` },
        });

        await Promise.allSettled(
          subs.map(sub => webpush.sendNotification(sub, payload).catch(() => {}))
        );
      }
    }

    const elapsed = Date.now() - start;

    // Cache result so the UI can display the last autoscan
    setLastScan({ timestamp, scanned: scannedCount, elapsed, alerts, timedOut });

    return NextResponse.json({
      ok: true,
      scanned: scannedCount,
      attempted: candidates.length,
      timedOut,
      timedOutNote: timedOut
        ? `Scan aborted at ${scannedCount}/${candidates.length} pairs — time budget (${TIME_BUDGET_MS}ms) reached.`
        : null,
      alerts: alerts.length,
      elapsed,
      signals: alerts,
      timestamp,
    });

  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
