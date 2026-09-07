import webpush from "web-push";
import { getAllSubscriptions } from "@/lib/subscriptions";
import { NextRequest, NextResponse } from "next/server";
import { fetchAllTickers } from "@/lib/bybit";
import { scanPair } from "@/lib/scanner";
export const maxDuration = 60;
export async function GET(req: NextRequest) {
  if (
    !process.env.CRON_SECRET ||
    req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  )
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const start = Date.now(),
    signals = [],
    failures = [];
  const candidates = (await fetchAllTickers())
    .filter((t) => t.volume24h >= 5000000)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, 3);
  for (const t of candidates) {
    if (Date.now() - start > 45000) break;
    try {
      const r = await scanPair(t.symbol, {
        capital: 5000,
        riskPct: 1,
        leverage: 3,
        style: "INTRADAY",
      });
      if (r.action === "REVIEW TRADE")
        signals.push({
          symbol: t.symbol,
          direction: r.direction,
          expectancy: r.history.comparable.expectancy,
          n: r.history.comparable.n,
        });
    } catch (e) {
      failures.push({ symbol: t.symbol, error: String(e) });
    }
  }
  if (
    signals.length &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  ) {
    webpush.setVapidDetails(
      "mailto:" + (process.env.VAPID_EMAIL ?? "admin@4scans.app"),
      process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    const subscriptions = await getAllSubscriptions();
    for (const signal of signals) {
      const results = await Promise.allSettled(
        subscriptions.map((sub) =>
          webpush.sendNotification(
            sub,
            JSON.stringify({
              title: `${signal.symbol} — ${signal.direction}: review trade`,
              body: `Historical expectancy ${signal.expectancy?.toFixed(2)}R; ${signal.n} comparable setups.`,
              data: { symbol: signal.symbol, url: `/?symbol=${signal.symbol}` },
            }),
          ),
        ),
      );
      for (const result of results)
        if (result.status === "rejected")
          failures.push({
            symbol: signal.symbol,
            error: "Push delivery failed",
          });
    }
  }
  return NextResponse.json({
    ok: true,
    signals,
    failures,
    elapsed: Date.now() - start,
  });
}
