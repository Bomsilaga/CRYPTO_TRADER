import { NextResponse } from 'next/server';
import { fetchAllTickers, fetchKlines } from '@/lib/bybit';
import {
  detectBOS, detectChoCH, detectSweeps, volRatio as calcVolRatio, rsi as calcRsi, bollingerBands,
  atr as calcAtr, swingHighLow,
  type SweepEvent,
} from '@/lib/indicators';
import type { RawCandle } from '@/lib/bybit';

export interface RadarSetup {
  setupType:   string;                      // 'OTE_RETRACEMENT' | 'BOS_PULLBACK' | 'BREAKOUT' | 'CONTINUATION'
  confidence:  'HIGH' | 'MEDIUM' | 'LOW';
  entryLow:    number;                      // lower bound of entry zone
  entryHigh:   number;                      // upper bound of entry zone
  entryPrice:  number;                      // ideal limit order price (midpoint)
  stopLoss:    number;
  tp1:         number;
  tp2:         number;
  tp3:         number;
  rrRatio:     number;                      // R:R to TP2
  entryLogic:  string;                      // why this level
  timing:      string;                      // what confirmation to wait for
  atr4h:       number;                      // 4H ATR for reference
  entryStatus: 'WAIT' | 'NOW' | 'MISSED';  // price vs entry zone
}

export interface RadarSignal {
  symbol:    string;
  price:     number;
  change24h: number;
  volume24h: number;
  direction: 'LONG' | 'SHORT';
  signals:   string[];
  reason:    string;
  score:     number;
  setup:     RadarSetup;
}

/* ── Mini signal engine ────────────────────────────────────────── */

function f(v: number): number { return +v.toPrecision(6); }

function buildSetup(
  direction: 'LONG' | 'SHORT',
  signals:   string[],
  sweeps:    SweepEvent[],
  h4:        RawCandle[],
  currentPrice: number,
): RadarSetup {
  const atr4h   = calcAtr(h4.slice(-20));
  const swings  = swingHighLow(h4, 25);
  const prevSw  = swingHighLow(h4.slice(0, -10), 20);

  const hasSweep   = signals.includes('SWEEP');
  const hasChoCH   = signals.includes('CHOCH');
  const hasBOS     = signals.includes('BOS');
  const hasBBSq    = signals.includes('BB_SQUEEZE');

  let entryLow: number, entryHigh: number, entryPrice: number;
  let stopLoss: number;
  let tp1: number, tp2: number, tp3: number;
  let setupType: string;
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  let entryLogic: string, timing: string;

  if (hasSweep && hasChoCH) {
    // ── OTE Retracement (highest confidence — ICT sweep + CHoCH) ────
    setupType  = 'OTE_RETRACEMENT';
    confidence = 'HIGH';

    const bestSweep = sweeps.find(s => s.direction === direction) ?? sweeps[0];
    const sweptLevel = bestSweep?.sweptLevel ?? (direction === 'LONG' ? swings.low : swings.high);

    if (direction === 'LONG') {
      // SSL swept → price bounced up → wait for OTE pullback (61.8–78.6% retrace)
      const range   = currentPrice - sweptLevel;
      entryHigh     = f(currentPrice - range * 0.618);
      entryLow      = f(currentPrice - range * 0.786);
      entryPrice    = f(currentPrice - range * 0.705);  // OTE midpoint
      stopLoss      = f(sweptLevel - atr4h * 0.3);
      const slDist  = entryPrice - stopLoss;
      tp1           = f(Math.min(swings.high, entryPrice + slDist * 1.5));
      tp2           = f(entryPrice + slDist * 2.5);
      tp3           = f(entryPrice + slDist * 4.0);
      entryLogic    = `SSL swept @ $${f(sweptLevel)} + CHoCH bullish. Price must retrace 61.8–78.6% of the recovery move before the continuation up.`;
      timing        = 'Limit buy inside OTE zone · Confirm with 15m bullish engulfing/pin bar · SL just below swept low';
    } else {
      // BSL swept → price dropped → wait for OTE rally (61.8–78.6% retrace up)
      const range   = sweptLevel - currentPrice;
      entryLow      = f(currentPrice + range * 0.618);
      entryHigh     = f(currentPrice + range * 0.786);
      entryPrice    = f(currentPrice + range * 0.705);
      stopLoss      = f(sweptLevel + atr4h * 0.3);
      const slDist  = stopLoss - entryPrice;
      tp1           = f(Math.max(swings.low, entryPrice - slDist * 1.5));
      tp2           = f(entryPrice - slDist * 2.5);
      tp3           = f(entryPrice - slDist * 4.0);
      entryLogic    = `BSL swept @ $${f(sweptLevel)} + CHoCH bearish. Price must retrace 61.8–78.6% of the drop before continuation down.`;
      timing        = 'Limit sell inside OTE zone · Confirm with 15m bearish engulfing · SL just above swept high';
    }

  } else if (hasBOS) {
    // ── BOS pullback to broken structure ─────────────────────────
    setupType  = 'BOS_PULLBACK';
    confidence = 'MEDIUM';

    if (direction === 'LONG') {
      const bosLevel = prevSw.high;  // broken above
      const bosMove  = currentPrice - bosLevel;
      entryLow      = f(bosLevel - atr4h * 0.1);         // slight below the boss level
      entryHigh     = f(bosLevel + bosMove * 0.382);      // 38.2% into new range
      entryPrice    = f(bosLevel + bosMove * 0.2);
      stopLoss      = f(bosLevel - atr4h * 0.5);
      const slDist  = entryPrice - stopLoss;
      tp1           = f(Math.min(swings.high, entryPrice + slDist * 1.5));
      tp2           = f(entryPrice + slDist * 2.5);
      tp3           = f(entryPrice + slDist * 4.0);
      entryLogic    = `BOS above $${f(bosLevel)} (prev swing high). Wait for price to pull back and retest that level as support before entering LONG.`;
      timing        = 'Limit buy at BOS level retest · Look for 1H candle rejection from the zone';
    } else {
      const bosLevel = prevSw.low;   // broken below
      const bosMove  = bosLevel - currentPrice;
      entryHigh     = f(bosLevel + atr4h * 0.1);
      entryLow      = f(bosLevel - bosMove * 0.382);
      entryPrice    = f(bosLevel - bosMove * 0.2);
      stopLoss      = f(bosLevel + atr4h * 0.5);
      const slDist  = stopLoss - entryPrice;
      tp1           = f(Math.max(swings.low, entryPrice - slDist * 1.5));
      tp2           = f(entryPrice - slDist * 2.5);
      tp3           = f(entryPrice - slDist * 4.0);
      entryLogic    = `BOS below $${f(bosLevel)} (prev swing low). Wait for price to rally back and retest that level as resistance before entering SHORT.`;
      timing        = 'Limit sell at BOS level retest · Look for 1H bearish rejection candle';
    }

  } else if (hasBBSq) {
    // ── BB Squeeze breakout ───────────────────────────────────────
    setupType  = 'BREAKOUT';
    confidence = 'LOW';

    const slDist  = atr4h * 1.2;
    entryPrice    = f(currentPrice);
    entryLow      = f(currentPrice * 0.999);
    entryHigh     = f(currentPrice * 1.001);
    stopLoss      = f(direction === 'LONG' ? currentPrice - slDist : currentPrice + slDist);
    const risk    = Math.abs(entryPrice - stopLoss);
    tp1           = f(direction === 'LONG' ? entryPrice + risk      : entryPrice - risk);
    tp2           = f(direction === 'LONG' ? entryPrice + risk * 2  : entryPrice - risk * 2);
    tp3           = f(direction === 'LONG' ? entryPrice + risk * 3  : entryPrice - risk * 3);
    entryLogic    = 'BB squeeze with narrow bands — volatility expansion imminent. Enter on the breakout candle close.';
    timing        = 'Wait for H4 candle to CLOSE decisively outside BB bands, then enter · SL 1.2 ATR on opposite side';

  } else {
    // ── Momentum / RSI continuation ──────────────────────────────
    setupType  = 'CONTINUATION';
    confidence = 'LOW';

    const last  = h4[h4.length - 1];
    const prev  = h4[h4.length - 2];
    const slDist = atr4h * 1.2;

    if (direction === 'LONG') {
      const moveSize = last.close - prev.close;
      entryPrice  = f(last.close - moveSize * 0.5);   // 50% pullback of last H4
      entryLow    = f(last.close - moveSize * 0.618);
      entryHigh   = f(last.close - moveSize * 0.382);
      stopLoss    = f(Math.min(last.low, prev.low) - atr4h * 0.3);
    } else {
      const moveSize = prev.close - last.close;
      entryPrice  = f(last.close + moveSize * 0.5);
      entryHigh   = f(last.close + moveSize * 0.618);
      entryLow    = f(last.close + moveSize * 0.382);
      stopLoss    = f(Math.max(last.high, prev.high) + atr4h * 0.3);
    }
    const risk  = Math.abs(entryPrice - stopLoss);
    tp1         = f(direction === 'LONG' ? entryPrice + risk      : entryPrice - risk);
    tp2         = f(direction === 'LONG' ? entryPrice + risk * 2  : entryPrice - risk * 2);
    tp3         = f(direction === 'LONG' ? entryPrice + risk * 3.5: entryPrice - risk * 3.5);
    entryLogic  = `Momentum ${direction}. Wait for a 50% pullback of the last H4 candle before entering — don't chase.`;
    timing      = 'Limit order at 50% retrace level · Reject if price blows through without slowing';
  }

  const risk    = Math.abs(entryPrice - stopLoss);
  const reward2 = Math.abs(tp2 - entryPrice);
  const rrRatio = risk > 0 ? +((reward2 / risk).toFixed(1)) : 0;

  // Is price already in the entry zone, waiting to get there, or past it?
  let entryStatus: 'WAIT' | 'NOW' | 'MISSED';
  if (direction === 'LONG') {
    if (currentPrice > entryHigh)                             entryStatus = 'WAIT';   // hasn't pulled back yet
    else if (currentPrice >= entryLow && currentPrice <= entryHigh) entryStatus = 'NOW';  // in zone!
    else                                                      entryStatus = 'MISSED'; // overshot below
  } else {
    if (currentPrice < entryLow)                              entryStatus = 'WAIT';   // hasn't rallied yet
    else if (currentPrice >= entryLow && currentPrice <= entryHigh) entryStatus = 'NOW';
    else                                                      entryStatus = 'MISSED';
  }

  return {
    setupType, confidence, entryLow, entryHigh, entryPrice,
    stopLoss, tp1, tp2, tp3, rrRatio, entryLogic, timing,
    atr4h: +atr4h.toPrecision(4),
    entryStatus,
  };
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

            const setup = buildSetup(direction, signals, sweeps, h4, t.price);

            results.push({
              symbol:    t.symbol,
              price:     t.price,
              change24h: t.change24h,
              volume24h: t.volume24h,
              direction,
              signals,
              reason: parts.join(' · '),
              score,
              setup,
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
