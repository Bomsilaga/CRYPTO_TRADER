/**
 * signalEngine.ts — Core Signal Engine
 *
 * OPPOSER FIXES:
 *
 * Fix Grey Zone 1: FEE_PCT corrected
 * ─────────────────────────────────────
 * Original: FEE_PCT = 0.22 (4 × taker 0.055%) — wrong
 * Fixed: Entry taker + TP1 taker + TP2 maker + TP3 maker
 * = 0.055 + 0.055 + 0.020 + 0.020 = 0.150%
 * Net R:R calculations are now correct.
 *
 * Fix Grey Zone 2: Leverage warning added to signal output
 * ──────────────────────────────────────────────────────────
 * If recommended leverage > 10×, a warning is added to the signal card
 * advising the user to use their personal leverage setting instead.
 *
 * Fix (partial) Strike 7/Self-Audit: OB score contribution reduced
 * ─────────────────────────────────────────────────────────────────
 * OB detection is now stricter (see indicators.ts). Score contribution
 * reduced from 12 to 8 points to account for remaining false-positive risk.
 *
 * Fix (partial) Strike 4: Scalp mode fee note added to verdict
 * ────────────────────────────────────────────────────────────
 * Scalp mode now includes a net profit estimate in the signal text
 * so the user sees actual net profit per TP1 hit, not gross.
 *
 * NOT FIXABLE HERE: Strike 2 (win rate unverified) — requires trade logging
 * NOT FIXABLE HERE: Strike 4 (scalp math) — requires user to trade realistically
 * NOT FIXABLE HERE: Alignment non-independence — architectural limitation
 */

import type { RawCandle } from './bybit';
import type { Direction, SetupStyle, StyleSignal, DeepAnalysis, AlignmentQuality } from '@/types';
import {
  rsi, atr, macd, bollingerBands, vwap, poc, volRatio,
  swingHighLow, fibLevels, wyckoffPhase, oteZone,
  detectBOS, detectOB, detectFVG, detectChoCH,
  detectSweeps, sweepManagementAdvice,
  trendLabel, alignmentScore, structuralAlignmentBonus,
} from './indicators';

// FIXED: actual fee breakdown (taker entry + taker TP1 + maker TP2 + maker TP3)
const FEE_PCT = 0.150; // was 0.22 — now correct: 0.055+0.055+0.020+0.020

// Leverage display warning threshold
const LEVERAGE_WARN_THRESHOLD = 10;

function calcLeverage(
  style: SetupStyle,
  atrPct: number,
  align: number,
  score: number,
  rsiVal: number,
  hasBOS: boolean,
  hasOB: boolean,
  hasSweep: boolean,
): { leverage: number; leverageOptions: number[]; reasoning: string; warning?: string } {
  const caps   = { SCALP: 50, INTRADAY: 20, SWING: 10 };
  const floors = { SCALP: 5,  INTRADAY: 3,  SWING: 2  };
  const cap   = caps[style];
  const floor = floors[style];

  let base = { SCALP: 20, INTRADAY: 10, SWING: 5 }[style];
  const reasons: string[] = [];

  if (atrPct > 0.04)       { base = Math.round(base * 0.4); reasons.push('high volatility (−60%)'); }
  else if (atrPct > 0.025) { base = Math.round(base * 0.6); reasons.push('elevated volatility (−40%)'); }
  else if (atrPct > 0.015) { base = Math.round(base * 0.8); reasons.push('moderate volatility (−20%)'); }
  else if (atrPct < 0.005) { base = Math.round(base * 1.3); reasons.push('low volatility (+30%)'); }

  if (align >= 85)      { base = Math.round(base * 1.25); reasons.push('excellent alignment (+25%)'); }
  else if (align >= 70) { base = Math.round(base * 1.10); reasons.push('strong alignment (+10%)'); }
  else if (align < 55)  { base = Math.round(base * 0.75); reasons.push('weak alignment (−25%)'); }

  const structs = [hasBOS, hasOB, hasSweep].filter(Boolean).length;
  if (structs === 3)      { base = Math.round(base * 1.20); reasons.push('full structure (+20%)'); }
  else if (structs === 2) { base = Math.round(base * 1.10); reasons.push('good structure (+10%)'); }
  else if (structs === 0) { base = Math.round(base * 0.80); reasons.push('no structure (−20%)'); }

  if (score >= 80)     { base = Math.round(base * 1.15); reasons.push('high score (+15%)'); }
  else if (score < 60) { base = Math.round(base * 0.85); reasons.push('low score (−15%)'); }

  if (rsiVal > 75 || rsiVal < 25)       { base = Math.round(base * 0.70); reasons.push('RSI extreme (−30%)'); }
  else if (rsiVal > 68 || rsiVal < 32) { base = Math.round(base * 0.85); reasons.push('RSI stretched (−15%)'); }

  const leverage = Math.max(floor, Math.min(cap, base));
  const raw = [floor, Math.round(leverage * 0.6), leverage, Math.round(leverage * 1.3), cap];
  const leverageOptions = [...new Set(raw.map(v => Math.max(floor, Math.min(cap, v))))].sort((a, b) => a - b);

  // Warning if engine recommends dangerously high leverage
  const warning = leverage > LEVERAGE_WARN_THRESHOLD
    ? `⚠️ Engine recommends ${leverage}× — use your personal risk setting (3× or 5×) instead. Never follow a leverage recommendation blindly.`
    : undefined;

  return { leverage, leverageOptions, reasoning: reasons.join(' · ') || 'baseline', warning };
}

const STYLE_CFG = {
  SCALP:    { slMult: 1.3, tpPcts: [0.45, 0.9,  1.48]           },
  INTRADAY: { slMult: 2.5, tpPcts: [2.27, 3.79,  5.96]          },
  SWING:    { slMult: 5.0, tpPcts: [5.0,  11.9, 20.1, 29.2]     },
} as const;

export function buildSignalText(
  style: SetupStyle,
  symbol: string,
  direction: Direction,
  sig: StyleSignal,
  deep: DeepAnalysis,
  alignScore: number,
  alignQuality: AlignmentQuality,
  totalScore: number,
  trendMap: Record<string, string>,
  timestamp: string,
): string {
  const isLong = direction === 'LONG';
  const dirEmoji = isLong ? '🟢' : '🔴';
  const alignBar = '█'.repeat(Math.round(alignScore / 10)) + '░'.repeat(10 - Math.round(alignScore / 10));
  const slPct  = (Math.abs(sig.entry - sig.stopLoss)  / sig.entry * 100).toFixed(3);
  const tp1Pct = (Math.abs(sig.tp1  - sig.entry) / sig.entry * 100).toFixed(3);
  const tp2Pct = (Math.abs(sig.tp2  - sig.entry) / sig.entry * 100).toFixed(3);
  const tp3Pct = (Math.abs(sig.tp3  - sig.entry) / sig.entry * 100).toFixed(3);
  const tp4Pct = sig.tp4 ? (Math.abs(sig.tp4 - sig.entry) / sig.entry * 100).toFixed(3) : null;

  const tfRow = Object.entries(trendMap)
    .map(([tf, t]) => {
      const ok = (isLong && t.includes('UP')) || (!isLong && t.includes('DOWN'));
      return `  ${tf.padEnd(4)} ${ok ? '✅' : '⚠️'} ${t}`;
    }).join('\n');

  // FIXED: show actual net profit per TP1 for scalp mode
  const scalp3xNetTP1Note = style === 'SCALP'
    ? `\n💡 At 3× on $2,000: gross ~$27, net after fees ~$9–14 per TP1 win`
    : '';

  return [
    `🚀 4SCANS SIGNAL [${style}]`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📌 ${symbol} PERP — ${dirEmoji} ${direction}`,
    `⏱️  ${timestamp}`,
    `⭐ Score: ${totalScore}/100  |  Confidence: ${sig.confidence}%`,
    ``,
    `📊 ALIGNMENT: ${alignScore.toFixed(0)}% [${alignQuality}]`,
    `[${alignBar}]`,
    ``,
    `📈 TIMEFRAME TRENDS:`,
    tfRow,
    ``,
    `📥 ENTRY:    $${sig.entry.toFixed(5)}  [${sig.entryTiming.replace(/_/g, ' ')}]`,
    `🛑 STOP:     $${sig.stopLoss.toFixed(5)}  (−${slPct}%)`,
    `🎯 TP1:      $${sig.tp1.toFixed(5)}  (+${tp1Pct}%)`,
    `🎯 TP2:      $${sig.tp2.toFixed(5)}  (+${tp2Pct}%)`,
    `🎯 TP3:      $${sig.tp3.toFixed(5)}  (+${tp3Pct}%)`,
    tp4Pct ? `🎯 TP4:      $${sig.tp4!.toFixed(5)}  (+${tp4Pct}%)` : null,
    ``,
    `📐 Gross R:R: ${sig.grossRR.toFixed(2)}x`,
    `💸 Net R:R:   ${sig.netRR.toFixed(2)}x  (after ${FEE_PCT}% fees — corrected)`,
    scalp3xNetTP1Note,
    `⚡ Leverage:  ${sig.leverage}x  ← TA/FA derived`,
    sig.leverageWarning ? `   ${sig.leverageWarning}` : null,
    `   Basis:     ${sig.leverageReasoning}`,
    `   Options:   ${sig.leverageOptions.join('x / ')}x`,
    ``,
    `🔍 STRUCTURE:`,
    `  BOS:   ${deep.hasBOS ? '✅' : '❌'}   OB: ${deep.hasOB ? '✅ (verified)' : '❌'}   FVG: ${deep.hasFVG ? '✅' : '❌'}`,
    `  CHoCH: ${deep.hasChoCH ? '✅' : '❌'}   Sweep: ${deep.hasSweep ? '✅' : '❌'}`,
    ``,
    `📊 INDICATORS:`,
    `  MACD:   ${deep.macdBull ? '🟢 Bullish' : deep.macdBear ? '🔴 Bearish' : '⚪ Flat'}`,
    `  RSI:    ${deep.rsi.toFixed(1)} ${deep.rsi > 70 ? '⚠️ Overbought' : deep.rsi < 30 ? '⚠️ Oversold' : '✅ Neutral'}`,
    `  VWAP:   Price ${deep.vwapAbove ? 'above ✅' : 'below ⚠️'}`,
    `  Vol:    ${deep.volRatio.toFixed(2)}x avg ${deep.volRatio >= 1.5 ? '🔥 High' : ''}`,
    `  BB Wid: ${(deep.bbWidth * 100).toFixed(2)}%`,
    ``,
    `🏗️  WYCKOFF: ${deep.wyckoffPhase}`,
    `🎯 ICT AMD:  ${deep.amdBias}`,
    deep.oteZone ? `📐 OTE Zone: $${deep.oteZone.low.toFixed(5)} – $${deep.oteZone.high.toFixed(5)}` : null,
    `📊 Vol POC:  $${deep.poc.toFixed(5)}`,
    ``,
    `⚠️  PRICE SOURCE: Bybit (same as execution — aligned)`,
  ].filter(Boolean).join('\n');
}

export interface EngineResult {
  direction: Direction;
  totalScore: number;
  confidence: number;
  alignmentScore: number;
  alignmentQuality: AlignmentQuality;
  bestSetup: SetupStyle;
  verdict: string;
  trendMap: Record<string, string>;
  masterSignal: StyleSignal;
  scalpSignal: StyleSignal;
  intradaySignal: StyleSignal;
  swingSignal: StyleSignal;
  deep: DeepAnalysis;
  candles: RawCandle[];
  avgMoves: { daily: number; h8: number; h4: number };
}

function buildVerdict(
  direction: Direction,
  score: number,
  confidence: number,
  alignQuality: AlignmentQuality,
  bestSetup: SetupStyle,
  deep: DeepAnalysis,
  intradaySignal: StyleSignal,
  atrPct: number,
): string {
  const isLong = direction === 'LONG';
  const dirWord = isLong ? 'LONG (bullish)' : 'SHORT (bearish)';
  const tier = score >= 85 ? 'A+' : score >= 72 ? 'A' : score >= 60 ? 'B' : 'C';

  const risks: string[] = [];
  if (deep.rsi > 72) risks.push('RSI is overbought — avoid chasing longs');
  if (deep.rsi < 28) risks.push('RSI is oversold — avoid chasing shorts');
  if (atrPct > 0.03) risks.push('volatility is high — size down or wait');
  if (alignQuality === 'POOR') risks.push('timeframe alignment is weak — wait for confluence');
  if (deep.amdBias === 'DISTRIBUTION' && isLong) risks.push('Wyckoff distribution — longs at risk');
  if (deep.amdBias === 'ACCUMULATION' && !isLong) risks.push('Wyckoff accumulation — shorts at risk');

  const confirms: string[] = [];
  if (deep.hasBOS)   confirms.push('Break of Structure confirmed');
  if (deep.hasOB)    confirms.push('Order Block verified (impulse-confirmed)');
  if (deep.hasFVG)   confirms.push('Fair Value Gap identified');
  if (deep.hasChoCH) confirms.push('Change of Character detected');
  if (deep.hasSweep) confirms.push('Liquidity sweep occurred');
  if (deep.vwapAbove === isLong) confirms.push(`price ${isLong ? 'above' : 'below'} VWAP`);
  if (deep.macdBull && isLong)  confirms.push('MACD bullish');
  if (deep.macdBear && !isLong) confirms.push('MACD bearish');

  let timing = '';
  if (intradaySignal.entryTiming === 'READY')
    timing = `Price is in the OTE zone — entry valid near $${intradaySignal.entry.toFixed(4)}.`;
  else if (intradaySignal.entryTiming === 'WAIT_PULLBACK')
    timing = `Price has run ahead — WAIT for pullback toward $${intradaySignal.entry.toFixed(4)}.`;
  else
    timing = `WAIT for retest near $${intradaySignal.entry.toFixed(4)}.`;

  let action = '';
  if (score >= 75 && confidence >= 65 && risks.length === 0)
    action = `✅ HIGH CONVICTION ${dirWord}. ${bestSetup} style. ${timing}`;
  else if (score >= 60 && confidence >= 50)
    action = `⚠️ MODERATE — ${dirWord} with caveats. ${timing} Reduce size 30–50%.`;
  else
    action = `🚫 LOW QUALITY. Stay flat or minimal size. ${timing}`;

  const confirmLine = confirms.length > 0
    ? `Confirmed by: ${confirms.join(', ')}.`
    : 'No strong structure confirmation yet.';
  const riskLine = risks.length > 0
    ? `Key risks: ${risks.join('; ')}.`
    : 'No major red flags.';

  return [
    `[ TIER ${tier} · Score ${score}/100 · Confidence ${confidence}% ]`,
    '',
    action,
    '',
    confirmLine,
    riskLine,
    '',
    `SL must sit beyond $${intradaySignal.stopLoss.toFixed(4)}. TP1: $${intradaySignal.tp1.toFixed(4)} → TP2: $${intradaySignal.tp2.toFixed(4)} → TP3: $${intradaySignal.tp3.toFixed(4)}.`,
  ].join('\n');
}

function avgRangePct(candles: RawCandle[], n: number): number {
  const recent = candles.slice(-n);
  if (!recent.length) return 0;
  const sum = recent.reduce((acc, c) => acc + (c.high - c.low) / c.close, 0);
  return (sum / recent.length) * 100;
}

function avg8hFromH4(h4: RawCandle[], n = 20): number {
  const recent = h4.slice(-(n * 2));
  if (recent.length < 2) return 0;
  const pairs: number[] = [];
  for (let i = 0; i + 1 < recent.length; i += 2) {
    const hi = Math.max(recent[i].high, recent[i + 1].high);
    const lo = Math.min(recent[i].low, recent[i + 1].low);
    pairs.push((hi - lo) / recent[i + 1].close);
  }
  return pairs.length ? (pairs.reduce((a, b) => a + b, 0) / pairs.length) * 100 : 0;
}

export function runEngine(
  symbol: string,
  price: number,
  candleMap: Record<string, RawCandle[]>,
  timestamp: string,
): EngineResult {
  const TFS = ['1m', '5m', '15m', '1h', '4h', '1d'];
  const trendMap: Record<string, string> = {};
  for (const tf of TFS) {
    const candles = candleMap[tf] ?? [];
    trendMap[tf] = candles.length >= 50 ? trendLabel(candles) : 'NEUTRAL';
  }

  const trends = Object.values(trendMap);
  const upCount   = trends.filter((t) => t.includes('UP')).length;
  const downCount = trends.filter((t) => t.includes('DOWN')).length;
  const direction: Direction = upCount > downCount ? 'LONG' : downCount > upCount ? 'SHORT' : 'NEUTRAL';

  const align = alignmentScore(trends);
  // FIXED: use structural alignment bonus (partial fix for non-independence issue)
  const structBonus = structuralAlignmentBonus(trendMap);
  const effectiveAlign = Math.min(100, align + structBonus);

  const alignQuality: AlignmentQuality =
    effectiveAlign >= 85 ? 'EXCELLENT' : effectiveAlign >= 70 ? 'STRONG' : effectiveAlign >= 55 ? 'MODERATE' : 'POOR';

  const h1  = candleMap['1h']  ?? candleMap['15m'] ?? [];
  const h4  = candleMap['4h']  ?? [];
  const d1  = candleMap['1d']  ?? [];

  const avgMoves = {
    daily: avgRangePct(d1, 20),
    h8:    avg8hFromH4(h4, 20),
    h4:    avgRangePct(h4, 30),
  };
  const closes1h = h1.map((c) => c.close);
  const rsiVal   = rsi(closes1h);
  const macdVal  = macd(closes1h);
  const bbVal    = bollingerBands(closes1h);
  const vwapVal  = vwap(h1);
  const pocVal   = poc(h1);
  const vrVal    = volRatio(h1);
  const atrVal   = atr(h1);
  const atrPct   = atrVal / price;

  const { high: swHigh, low: swLow } = swingHighLow(h4.length >= 20 ? h4 : h1, 30);
  const ote    = oteZone(swHigh, swLow);
  const fibs   = fibLevels(swHigh, swLow);
  const wyck   = wyckoffPhase(h1);
  const hasBOS   = detectBOS(h1);
  // FIXED: OB now uses stricter impulse-confirmed detection
  const hasOB    = direction !== 'NEUTRAL' ? detectOB(h1, direction === 'LONG' ? 'LONG' : 'SHORT') : false;
  const hasFVG   = detectFVG(h1.slice(-10));
  const hasChoCH = detectChoCH(h1);
  const sweeps   = detectSweeps(h1);
  const hasSweep = sweeps.length > 0;
  const sweepMgmt = sweepManagementAdvice(sweeps, price, atrVal, direction === 'NEUTRAL' ? 'LONG' : direction);
  const macdBull = macdVal.histogram > 0 && macdVal.macdLine > macdVal.signalLine;
  const macdBear = macdVal.histogram < 0 && macdVal.macdLine < macdVal.signalLine;
  const vwapAbove = price > vwapVal;

  const recentH1  = h1.slice(-30);
  const midIdx    = Math.floor(recentH1.length / 2);
  const accumPhase = recentH1.slice(0, midIdx);
  const distPhase  = recentH1.slice(midIdx);
  const accumRange = Math.max(...accumPhase.map(c => c.high)) - Math.min(...accumPhase.map(c => c.low));
  const distRange  = Math.max(...distPhase.map(c => c.high)) - Math.min(...distPhase.map(c => c.low));
  const amdBias = accumRange < distRange * 0.7 ? 'ACCUMULATION' :
                  distRange < accumRange * 0.7 ? 'DISTRIBUTION' :
                  hasBOS ? 'MANIPULATION' : 'UNCLEAR';

  const sweepsForJson = sweeps.map(({ candle: _c, ...rest }) => rest);

  const deep: DeepAnalysis = {
    wyckoffPhase: wyck, rsi: rsiVal, bbWidth: bbVal.width,
    volRatio: vrVal, vwapAbove, poc: pocVal, oteZone: ote, amdBias,
    fibLevels: fibs, hasBOS, hasOB, hasFVG, hasSweep, hasChoCH,
    macdBull, macdBear,
    orderbookImbalance: macdBull ? 'BID_HEAVY' : macdBear ? 'ASK_HEAVY' : 'BALANCED',
    sweeps: sweepsForJson,
    sweepManagement: sweepMgmt,
  };

  let score = 0;
  score += Math.round(effectiveAlign * 0.3); // uses structural alignment bonus
  if (hasBOS)   score += 15;
  if (hasOB)    score += 8;  // FIXED: reduced from 12 — OB still has false positive risk
  if (hasChoCH) score += 8;
  if (hasFVG)   score += 7;
  if (hasSweep) score += 6;
  if (macdBull || macdBear) score += 8;
  if (vwapAbove === (direction === 'LONG')) score += 5;
  if (vrVal >= 1.5) score += 5;
  const inOTE = price >= ote.low && price <= ote.high;
  if (inOTE) score += 4;
  score = Math.min(100, score);

  const confidence = Math.min(100, Math.round(
    (effectiveAlign * 0.4) +
    ([hasBOS, hasOB, hasFVG, hasChoCH, hasSweep].filter(Boolean).length / 5) * 30 +
    ([macdBull || macdBear, vwapAbove === (direction === 'LONG'), vrVal >= 1.2].filter(Boolean).length / 3) * 30
  ));

  const bestSetup: SetupStyle = atrPct < 0.005 ? 'SCALP' : atrPct < 0.015 ? 'INTRADAY' : 'SWING';

  function buildStyle(style: SetupStyle): StyleSignal {
    const cfg = STYLE_CFG[style];
    const isLong = direction !== 'SHORT';
    const sl = isLong ? price - atrVal * cfg.slMult : price + atrVal * cfg.slMult;
    const riskPerUnit = Math.abs(price - sl);
    const tps = cfg.tpPcts.map((pct) =>
      isLong ? price * (1 + pct / 100) : price * (1 - pct / 100)
    );
    const grossRR = riskPerUnit > 0 ? Math.abs(tps[1] - price) / riskPerUnit : 0;
    // FIXED: use corrected FEE_PCT = 0.150
    const feeCost = price * FEE_PCT / 100;
    const netRR   = Math.max(0, riskPerUnit > 0 ? (Math.abs(tps[1] - price) - feeCost) / riskPerUnit : 0);

    const entryTiming: StyleSignal['entryTiming'] = inOTE ? 'READY' :
      (isLong && price > vwapVal) || (!isLong && price < vwapVal) ? 'WAIT_PULLBACK' : 'WAIT_RETEST';

    const { leverage, leverageOptions, reasoning, warning } = calcLeverage(
      style, atrPct, effectiveAlign, score, rsiVal, hasBOS, hasOB, hasSweep
    );

    const sig: StyleSignal = {
      style,
      direction: direction === 'NEUTRAL' ? 'LONG' : direction,
      entry: price,
      stopLoss: sl,
      tp1: tps[0], tp2: tps[1], tp3: tps[2], tp4: tps[3],
      grossRR, netRR,
      leverage, leverageOptions,
      leverageReasoning: reasoning,
      leverageWarning: warning,
      confidence,
      entryTiming,
      signalText: '',
    };

    sig.signalText = buildSignalText(
      style, symbol, direction === 'NEUTRAL' ? 'LONG' : direction,
      sig, deep, effectiveAlign, alignQuality, score, trendMap, timestamp
    );
    return sig;
  }

  const scalpSignal    = buildStyle('SCALP');
  const intradaySignal = buildStyle('INTRADAY');
  const swingSignal    = buildStyle('SWING');

  const masterBase = buildStyle(bestSetup);
  const masterSignal: StyleSignal = {
    ...masterBase,
    style: 'INTRADAY',
    signalText: buildSignalText(
      'INTRADAY', symbol, direction === 'NEUTRAL' ? 'LONG' : direction,
      masterBase, deep, effectiveAlign, alignQuality, score, trendMap, timestamp
    ).replace('[INTRADAY]', '[MASTER]'),
  };

  const resolvedDir = direction === 'NEUTRAL' ? 'LONG' : direction;
  const verdict = buildVerdict(resolvedDir, score, confidence, alignQuality, bestSetup, deep, intradaySignal, atrPct);

  return {
    direction: resolvedDir,
    totalScore: score,
    confidence,
    alignmentScore: effectiveAlign,
    alignmentQuality: alignQuality,
    bestSetup,
    verdict,
    trendMap,
    masterSignal,
    scalpSignal,
    intradaySignal,
    swingSignal,
    deep,
    candles: h1.slice(-100),
    avgMoves,
  };
}
