import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

type Provider = 'claude' | 'openai' | 'deepseek';

const MAKER = 0.0002, TAKER = 0.00055, MMR = 0.005;

const SYSTEM = `You are the head trader of a proprietary crypto futures desk. Two decades in leveraged markets — you have blown up an account once in your twenties and built an eight-figure track record since by never letting it happen again. You now mentor one trader who is going full-time on a small account, and you are speaking to them directly.

Your voice: calm, surgical, plain English. No hype, no hedging, no "it depends". You name the trade or you kill it. You think in R-multiples and dollars, never in percentages alone. You treat capital preservation as the only edge that compounds. You are allergic to fake precision — if the data does not support a claim, you say so.

Non-negotiable rules you enforce on your trader:
1. Risk per trade is fixed by the stop. Leverage only changes margin. Never size up because a setup "feels" strong.
2. No trade without 1h and 4h agreement unless the setup is a confirmed liquidity-sweep reversal with displacement.
3. NEUTRAL bias = NO TRADE. Standing aside is a position.
4. A setup with fewer than 3 confluences firing is a watchlist item, not a trade.
5. If BTC is trending hard against the trade, the alt trade is at best half size.
6. Never widen a stop. Never add to a loser. Always take TP1 (50%) and move the stop to breakeven.
7. After the daily loss limit is hit, the terminal is closed for the day. No exceptions.
8. If historical edge data is missing, say "unproven" — never invent win rates.

You will be given the engine's read plus the trader's actual account numbers. Use THOSE dollar figures. Write like a desk note, not an essay. Every section short. Bold the verdict.`;

function buildPrompt(body: Record<string, unknown>): string {
  const b = body as {
    symbol: string; price: number; direction: string; totalScore: number;
    confidence: number; alignmentScore: number; alignmentQuality: string; bestSetup: string;
    masterSignal: { entry: number; stopLoss: number; tp1: number; tp2: number; tp3: number; leverage: number; netRR: number };
    deep: { hasBOS: boolean; hasOB: boolean; hasFVG: boolean; hasChoCH: boolean; hasSweep: boolean;
            macdBull: boolean; macdBear: boolean; vwapAbove: boolean; volRatio: number; rsi: number; wyckoffPhase: string; amdBias?: string };
    trendMap?: Record<string, string>;
    avgMoves?: { daily: number; h8: number; h4: number };
    account?: { accountSize?: number; riskPct?: number; leverage?: number; orderType?: string; dailyLossLimit?: number; dailyTarget?: number; maxTrades?: number; openTrades?: number };
    edge?: { samples: number; tp1Rate?: number; tp2Rate?: number; tp3Rate?: number; expectancy?: number };
    btcDirection?: string; btcScore?: number; btcConfidence?: number;
    btcDeep?: { rsi: number; wyckoffPhase: string; macdBull: boolean; macdBear: boolean; vwapAbove: boolean; volRatio: number };
  };
  const { symbol, direction, totalScore, confidence, alignmentScore, alignmentQuality, bestSetup, masterSignal: ms, deep, trendMap, avgMoves, edge, btcDirection, btcScore, btcDeep } = b;
  const acct = {
    size: b.account?.accountSize ?? 2000,
    riskPct: b.account?.riskPct ?? 1,
    lev: b.account?.leverage ?? ms.leverage ?? 3,
    orderType: b.account?.orderType ?? 'Limit',
    dailyLoss: b.account?.dailyLossLimit ?? 80,
    dailyTarget: b.account?.dailyTarget ?? 100,
    maxTrades: b.account?.maxTrades ?? 5,
    open: b.account?.openTrades ?? 0,
  };

  const f = (v: number) => v < 1 ? v.toFixed(6) : v < 100 ? v.toFixed(4) : v.toFixed(2);
  const $ = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
  const isNeutral = direction === 'NEUTRAL';
  const isLong = direction === 'LONG';
  const entry = ms.entry;
  const slDist = Math.abs(entry - ms.stopLoss);
  const slPct = slDist / entry;
  const riskAmt = acct.size * acct.riskPct / 100;
  const qty = slDist > 0 ? riskAmt / slDist : 0;
  const notional = qty * entry;
  const margin = (lev: number) => notional / lev;
  const entryFee = notional * (acct.orderType === 'Limit' ? MAKER : TAKER);
  const net = (p: number, frac = 1) => (qty * frac * Math.abs(p - entry) * (((isLong && p > entry) || (!isLong && p < entry)) ? 1 : -1)) - entryFee * frac - qty * frac * p * TAKER;
  const staged = net(ms.tp1, 0.5) + net(ms.tp2, 0.25) + net(ms.tp3, 0.25);
  const liqDist = Math.max(0, 1 / acct.lev - MMR);
  const liqPrice = isLong ? entry * (1 - liqDist) : entry * (1 + liqDist);
  const maxSafeLev = Math.floor(1 / (slPct + MMR));
  const r = (p: number) => (Math.abs(p - entry) / slDist).toFixed(2);

  const conf = [
    deep.hasBOS && 'BOS', deep.hasChoCH && 'CHoCH', deep.hasOB && 'Order Block', deep.hasFVG && 'FVG', deep.hasSweep && 'Liquidity sweep',
    (isLong ? deep.macdBull : deep.macdBear) && 'MACD aligned',
    (deep.vwapAbove === isLong && !isNeutral) && 'VWAP side',
    deep.volRatio >= 1.5 && `Volume ${deep.volRatio.toFixed(1)}×`,
  ].filter(Boolean) as string[];

  const tf = trendMap ? Object.entries(trendMap).map(([k, v]) => `${k}=${v}`).join(' | ') : 'n/a';

  const edgeLine = edge && edge.samples >= 5 && edge.tp1Rate !== undefined
    ? `Trader's own journal (${edge.samples} closed): TP1 ${edge.tp1Rate}% · TP2 ${edge.tp2Rate}% · TP3 ${edge.tp3Rate}% · expectancy ${$(edge.expectancy ?? 0)}/trade`
    : `Trader's own journal: only ${edge?.samples ?? 0} closed trades — edge is UNPROVEN. Say so.`;

  const btcSection = btcDirection && btcDeep ? `
BTC TAPE: ${btcDirection} (score ${btcScore}) · RSI ${btcDeep.rsi.toFixed(0)} · ${btcDeep.wyckoffPhase} · MACD ${btcDeep.macdBull ? 'bull' : btcDeep.macdBear ? 'bear' : 'flat'} · ${btcDeep.vwapAbove ? 'above' : 'below'} VWAP · vol ${btcDeep.volRatio.toFixed(1)}×
BTC vs this trade: ${!btcDirection || btcDirection === 'NEUTRAL' || btcDirection === direction ? 'aligned / not opposing' : '⚠ OPPOSING — alt trade is fighting the index'}` : '\nBTC TAPE: unavailable';

  return `DESK CARD — ${symbol} PERP @ $${f(entry)}

ENGINE READ
Bias: ${isNeutral ? 'NEUTRAL → NO TRADE by rule' : direction} · Setup Quality ${totalScore}/100 · Confidence ${confidence}% · Style ${bestSetup}
Timeframes: ${tf}
Alignment: ${alignmentScore}% (${alignmentQuality})
Confluences firing (${conf.length}/8): ${conf.length ? conf.join(', ') : 'none'}
RSI ${deep.rsi.toFixed(1)} · Wyckoff ${deep.wyckoffPhase} · AMD ${deep.amdBias ?? 'n/a'}
${avgMoves ? `Typical range: 4h ±${avgMoves.h4.toFixed(2)}% · 8h ±${avgMoves.h8.toFixed(2)}% · day ±${avgMoves.daily.toFixed(2)}%` : ''}

LEVELS (${isNeutral ? 'display only — no trade' : direction})
Entry $${f(entry)} · Stop $${f(ms.stopLoss)} (${(slPct * 100).toFixed(2)}% · 1R)
TP1 $${f(ms.tp1)} (${r(ms.tp1)}R · 50%) · TP2 $${f(ms.tp2)} (${r(ms.tp2)}R · 25%) · TP3 $${f(ms.tp3)} (${r(ms.tp3)}R · 25%) · Net R:R ${ms.netRR}×

TRADER'S ACCOUNT (use these exact numbers)
Capital ${$(acct.size)} · Risk ${acct.riskPct}% = ${$(riskAmt)} per trade · Daily loss limit ${$(acct.dailyLoss)} · Daily target ${$(acct.dailyTarget)} · Max ${acct.maxTrades} trades/day · Open now: ${acct.open}
Position: ${qty.toFixed(4)} ${symbol.replace('USDT', '')} = ${$(notional)} notional
Margin: ${$(margin(acct.lev))} @${acct.lev}× (your setting) · ${$(margin(3))} @3× · ${$(margin(5))} @5×
Liquidation @${acct.lev}×: $${f(liqPrice)} (${(liqDist * 100).toFixed(1)}% away) · max safe leverage for this stop: ${maxSafeLev}×
After fees (${acct.orderType} in, taker out): stop = ${$(net(ms.stopLoss))} · TP1 full = ${$(net(ms.tp1))} · TP2 full = ${$(net(ms.tp2))} · TP3 full = ${$(net(ms.tp3))}
Staged 50/25/25 to all targets = ${$(staged)} (${slDist > 0 ? (staged / riskAmt).toFixed(2) : '0'}R net)
${edgeLine}
${btcSection}

Write the desk note in exactly these sections:

**DESK READ** — 3 lines max. What the tape is actually doing on this pair and why the engine leans the way it does.

**THE TRADE** — ${isNeutral ? 'State NO TRADE and the single condition that would change that.' : `${direction} or NO TRADE. If trade: trigger candle to wait for, exact entry zone, stop, and why the stop is where it is.`}

**SIZING — IN DOLLARS** — Restate risk ${$(riskAmt)}, notional, margin at ${acct.lev}×, and net dollars at stop / TP1 / TP2 / staged plan. If the engine leverage differs from ${acct.lev}×, say which to use and why.

**MANAGEMENT** — What to do at TP1 (stop to BE), at TP2, and the runner. Time stop: if TP1 isn't hit within the typical 8h range, what then.

**WHAT KILLS IT** — 3 exact price levels or candle closes that invalidate the idea before the stop.

**BTC TAPE** — one paragraph, how BTC changes size or timing here.

**EDGE CHECK** — Is this trader's own track record good enough to run this at full size? Use the journal numbers; if unproven, say paper or quarter size.

**VERDICT** — One bold line: EXECUTE / CONDITIONAL / WATCHLIST / NO TRADE, direction, size (full / half / quarter / paper), and the one thing that matters most.`;
}

async function callClaude(prompt: string, apiKey: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1400,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });
  return (msg.content[0] as { type: string; text: string }).text;
}

async function callOpenAI(prompt: string, apiKey: string): Promise<string> {
  const client = new OpenAI({ apiKey });
  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1400,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
  });
  return res.choices[0]?.message?.content ?? '';
}

async function callDeepSeek(prompt: string, apiKey: string): Promise<string> {
  const client = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' });
  const res = await client.chat.completions.create({
    model: 'deepseek-chat',
    max_tokens: 1400,
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
  });
  return res.choices[0]?.message?.content ?? '';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const provider: Provider = body.provider ?? 'claude';

    const clientKey: string | undefined = body.clientApiKey;
    const envKeyMap: Record<Provider, string | undefined> = {
      claude:   process.env.ANTHROPIC_API_KEY,
      openai:   process.env.OPENAI_API_KEY,
      deepseek: process.env.DEEPSEEK_API_KEY,
    };
    const resolvedKey = clientKey || envKeyMap[provider];

    if (!resolvedKey) {
      const envVarName = provider === 'claude' ? 'ANTHROPIC_API_KEY' : provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY';
      return NextResponse.json({
        error: `No API key for ${provider}. Paste your ${envVarName} in Settings → AI Analysis Provider.`,
      }, { status: 400 });
    }

    const prompt = buildPrompt(body);

    let explanation = '';
    if (provider === 'claude')   explanation = await callClaude(prompt, resolvedKey);
    if (provider === 'openai')   explanation = await callOpenAI(prompt, resolvedKey);
    if (provider === 'deepseek') explanation = await callDeepSeek(prompt, resolvedKey);

    return NextResponse.json({ explanation, provider });

  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
