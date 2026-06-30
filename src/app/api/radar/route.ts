import { NextResponse } from 'next/server';
import { fetchAllTickers, fetchKlines } from '@/lib/bybit';
import {
  detectBOS, detectChoCH, detectSweeps, volRatio as calcVolRatio, rsi as calcRsi, bollingerBands,
} from '@/lib/indicators';

export interface RadarSignal {
  symbol:    string;
  price:     number;
  change24h: number;
  volume24h: number;
  direction: 'LONG' | 'SHORT';
  signals:   string[];   // e.g. ['SWEEP', 'CHOCH', 'BOS', 'VOL_SPIKE', 'RSI_BOUNCE', 'BB_SQUEEZE']
  reason:    string;     // human-readable summary
  score:     number;     // 0-100 signal strength
}

const BATCH        = 5;
const MAX_PAIRS    = 50;
const TIME_BUDGET  = 22_000; // 22s — well under Vercel pro/hobby 60s limit
const MIN_VOLUME   = 500_000; // lower than cron to catch small-cap movers like AIGENSYN

export async function GET() {
  const start = Date.now();

  try {
    // ── Phase 1: All tickers — one API call ──────────────────────────
    const allTickers = await fetchAllTickers();

    // Score initial interestingness purely from ticker data
    const interesting = allTickers
      .filter(t => t.volume24h >= MIN_VOLUME)
      .map(t => {
        const absChange = Math.abs(t.change24h);
        // coins with unusual movement OR very high volume
        const tickerScore =
          (absChange > 10 ? 40 : absChange > 5 ? 25 : absChange > 2 ? 10 : 0) +
          (t.volume24h > 50_000_000 ? 10 : t.volume24h > 10_000_000 ? 5 : 0);
        return { ...t, tickerScore };
      })
      .sort((a, b) => b.tickerScore - a.tickerScore || b.volume24h - a.volume24h)
      .slice(0, MAX_PAIRS);

    // ── Phase 2: Fetch 4h + 1h klines for candidates ─────────────────
    const results: RadarSignal[] = [];

    for (let i = 0; i < interesting.length; i += BATCH) {
      if (Date.now() - start > TIME_BUDGET) break;

      const batch = interesting.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(async t => {
          try {
            const [h4, h1] = await Promise.all([
              fetchKlines(t.symbol, '240', 80),
              fetchKlines(t.symbol, '60',  60),
            ]);

            if (h4.length < 20 || h1.length < 20) return;

            // ── Signal detection ────────────────────────────────────
            const hasBOS    = detectBOS(h4);
            const hasChoCH  = detectChoCH(h4);
            const sweeps    = detectSweeps(h4);
            const hasSweep  = sweeps.length > 0;
            const vr        = calcVolRatio(h4);
            const volSpike  = vr >= 1.8;
            const h4Closes  = h4.map(c => c.close);
            const rsiVal    = calcRsi(h4Closes);
            const bb        = bollingerBands(h4Closes);

            // RSI bounce: was oversold territory, now recovering
            const rsiOversold  = rsiVal >= 32 && rsiVal <= 52;
            // RSI bearish: was overbought, now dropping
            const rsiOverbought = rsiVal >= 50 && rsiVal <= 72;
            // BB squeeze releasing
            const bbSqueeze = bb.width < 0.04; // tight bands

            // 1h BOS for extra confluence
            const boS1h    = detectBOS(h1);
            const choCH1h  = detectChoCH(h1);
            const sweeps1h = detectSweeps(h1);
            const h1Sweep  = sweeps1h.length > 0;

            // ── Direction bias ──────────────────────────────────────
            const longSignals  = (hasBOS ? 1 : 0) + (hasChoCH ? 1 : 0) + (hasSweep ? 1 : 0) + (t.change24h > 0 ? 1 : 0);
            const shortSignals = (t.change24h < 0 ? 1 : 0);
            const direction: 'LONG' | 'SHORT' = longSignals >= shortSignals ? 'LONG' : 'SHORT';

            // ── Signal tags ─────────────────────────────────────────
            const signals: string[] = [];
            if (hasSweep || h1Sweep)  signals.push('SWEEP');
            if (hasChoCH || choCH1h)  signals.push('CHOCH');
            if (hasBOS || boS1h)      signals.push('BOS');
            if (volSpike)             signals.push('VOL_SPIKE');
            if (rsiOversold && direction === 'LONG')   signals.push('RSI_BOUNCE');
            if (rsiOverbought && direction === 'SHORT') signals.push('RSI_TOP');
            if (bbSqueeze)            signals.push('BB_SQUEEZE');
            if (Math.abs(t.change24h) > 8) signals.push('MOMENTUM');

            // Must have at least 2 signals to be worth reporting
            if (signals.length < 2) return;

            // ── Score ───────────────────────────────────────────────
            let score = 0;
            if (hasSweep)   score += 20;
            if (h1Sweep)    score += 10;
            if (hasChoCH)   score += 20;
            if (choCH1h)    score += 12;
            if (hasBOS)     score += 15;
            if (boS1h)      score += 10;
            if (volSpike)   score += 15;
            if (signals.includes('RSI_BOUNCE') || signals.includes('RSI_TOP')) score += 10;
            if (bbSqueeze)  score += 8;
            if (signals.includes('MOMENTUM')) score += 8;
            // Bonus: sweep + choch combo = the ICT pump setup
            if ((hasSweep || h1Sweep) && (hasChoCH || choCH1h)) score += 10;
            score = Math.min(100, score);

            // ── Reason text ─────────────────────────────────────────
            const parts: string[] = [];
            if ((hasSweep || h1Sweep) && (hasChoCH || choCH1h)) {
              parts.push('Swept liq + CHoCH → classic reversal setup');
            } else if (hasSweep || h1Sweep) {
              parts.push('Liquidity sweep occurred');
            }
            if (hasChoCH || choCH1h) parts.push('Change of Character detected');
            if (hasBOS || boS1h)     parts.push('Break of Structure confirmed');
            if (volSpike)            parts.push(`Vol spike ${vr.toFixed(1)}× avg`);
            if (signals.includes('RSI_BOUNCE')) parts.push(`RSI ${rsiVal.toFixed(0)} recovering from oversold`);
            if (signals.includes('RSI_TOP'))    parts.push(`RSI ${rsiVal.toFixed(0)} pulling back from overbought`);
            if (bbSqueeze)           parts.push('BB squeeze — volatility expansion incoming');

            results.push({
              symbol:    t.symbol,
              price:     t.price,
              change24h: t.change24h,
              volume24h: t.volume24h,
              direction,
              signals,
              reason: parts.join(' · '),
              score,
            });
          } catch { /* skip */ }
        })
      );
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return NextResponse.json({
      ok:      true,
      count:   results.length,
      scanned: Math.min(interesting.length, MAX_PAIRS),
      elapsed: Date.now() - start,
      signals: results,
    });

  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
