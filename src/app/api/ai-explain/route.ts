import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

type Provider = 'claude' | 'openai' | 'deepseek';

function buildPrompt(body: Record<string, unknown>): string {
  const { symbol, price, direction, totalScore, confidence, alignmentScore, alignmentQuality,
          bestSetup, masterSignal, deep,
          btcDirection, btcScore, btcConfidence, btcDeep } = body as {
    symbol: string; price: number; direction: string; totalScore: number;
    confidence: number; alignmentScore: number; alignmentQuality: string; bestSetup: string;
    masterSignal: { entry: number; stopLoss: number; tp1: number; tp2: number; tp3: number; leverage: number; netRR: number };
    deep: { hasBOS: boolean; hasOB: boolean; hasFVG: boolean; hasChoCH: boolean; hasSweep: boolean;
            macdBull: boolean; macdBear: boolean; vwapAbove: boolean; volRatio: number; rsi: number; wyckoffPhase: string };
    btcDirection?: string; btcScore?: number; btcConfidence?: number;
    btcDeep?: { rsi: number; wyckoffPhase: string; macdBull: boolean; macdBear: boolean; vwapAbove: boolean; volRatio: number };
  };

  const entry = masterSignal.entry;
  const f = (v: number) => v < 1 ? v.toFixed(6) : v < 100 ? v.toFixed(4) : v.toFixed(2);
  const slDist = Math.abs(entry - masterSignal.stopLoss);
  const tp1Dist = Math.abs(masterSignal.tp1 - entry);
  const tp2Dist = Math.abs(masterSignal.tp2 - entry);
  const tp3Dist = Math.abs(masterSignal.tp3 - entry);
  const slPct = (slDist / entry * 100).toFixed(2);

  // Compute both-direction levels (symmetric around entry — same ATR-based distances)
  const longLevels = { sl: f(entry - slDist), tp1: f(entry + tp1Dist), tp2: f(entry + tp2Dist), tp3: f(entry + tp3Dist) };
  const shortLevels = { sl: f(entry + slDist), tp1: f(entry - tp1Dist), tp2: f(entry - tp2Dist), tp3: f(entry - tp3Dist) };

  const btcAligned = !btcDirection || btcDirection === 'NEUTRAL' || btcDirection === direction;
  const btcSection = btcDirection && btcDeep ? `
BTC TREND CONTEXT (macro filter):
BTC Direction: ${btcDirection} | Score: ${btcScore}/100 | Confidence: ${btcConfidence}%
BTC RSI: ${btcDeep.rsi.toFixed(1)}${btcDeep.rsi > 70 ? ' (OVERBOUGHT)' : btcDeep.rsi < 30 ? ' (OVERSOLD)' : ''} | BTC Wyckoff: ${btcDeep.wyckoffPhase}
BTC MACD: ${btcDeep.macdBull ? 'Bullish' : btcDeep.macdBear ? 'Bearish' : 'Neutral'} | BTC VWAP: price ${btcDeep.vwapAbove ? 'ABOVE' : 'BELOW'} | BTC Vol: ${btcDeep.volRatio.toFixed(2)}× avg
BTC Alignment: ${btcAligned ? '✓ ALIGNED — macro supports this trade' : '⚠ DIVERGING — BTC trending opposite, increased risk'}` : '';

  return `You are a professional ICT (Inner Circle Trader) and Wyckoff methodology expert. Analyse this signal for BOTH LONG and SHORT directions and give actionable guidance for a trader with $2,000 capital.

SYMBOL: ${symbol} PERP | Current Price: $${f(entry)}
Engine Bias: ${direction} (Score: ${totalScore}/100 · Confidence: ${confidence}% · Setup: ${bestSetup})
Alignment: ${alignmentScore}% across 6 timeframes (${alignmentQuality})

LONG SIGNAL LEVELS:
Entry: $${f(entry)} | SL: $${longLevels.sl} (−${slPct}%) | Net R:R: ${masterSignal.netRR}×
TP1 50%: $${longLevels.tp1} | TP2 25%: $${longLevels.tp2} | TP3 25%: $${longLevels.tp3}

SHORT SIGNAL LEVELS:
Entry: $${f(entry)} | SL: $${shortLevels.sl} (+${slPct}%) | Net R:R: ${masterSignal.netRR}×
TP1 50%: $${shortLevels.tp1} | TP2 25%: $${shortLevels.tp2} | TP3 25%: $${shortLevels.tp3}

STRUCTURE (supports or opposes each direction):
BOS: ${deep.hasBOS ? 'YES' : 'NO'} | OB: ${deep.hasOB ? 'YES' : 'NO'} | FVG: ${deep.hasFVG ? 'YES' : 'NO'}
CHoCH: ${deep.hasChoCH ? 'YES' : 'NO'} | Sweep: ${deep.hasSweep ? 'YES' : 'NO'}
MACD: ${deep.macdBull ? 'Bullish ✓LONG' : deep.macdBear ? 'Bearish ✓SHORT' : 'Neutral'}
VWAP: price ${deep.vwapAbove ? 'ABOVE (favours LONG)' : 'BELOW (favours SHORT)'}
Volume: ${deep.volRatio.toFixed(2)}× avg | RSI: ${deep.rsi.toFixed(1)}${deep.rsi > 70 ? ' (OVERBOUGHT — caution LONG)' : deep.rsi < 30 ? ' (OVERSOLD — caution SHORT)' : ''}
Wyckoff: ${deep.wyckoffPhase}
${btcSection}
Respond in these exact sections (concise, specific):

**LONG ANALYSIS**
Why LONG works or doesn't — which structure confluences support it, what's missing.

**SHORT ANALYSIS**
Why SHORT works or doesn't — which structure confluences support it, what's missing.

**DIRECTION VERDICT**
Which direction has stronger confluence RIGHT NOW and exactly why. One paragraph.

**ENTRY TIMING**
For the stronger direction: exact trigger to wait for before entering. Current price context.

**RISK BREAKDOWN**
Dollar figures for $2,000 account at 3× and 5×. What does losing 1R cost?

**BTC CONTEXT**
${btcDirection ? `BTC is ${btcDirection} (score ${btcScore}). How this affects both LONG and SHORT on this coin specifically.` : 'BTC data unavailable.'}

**WHAT INVALIDATES THE TRADE**
2–3 specific price levels or candle closes that would cancel the setup entirely.

**VERDICT**
One sentence: which direction, enter now or wait, and the single most important condition.`;
}

async function callClaude(prompt: string, apiKey: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return (msg.content[0] as { type: string; text: string }).text;
}

async function callOpenAI(prompt: string, apiKey: string): Promise<string> {
  const client = new OpenAI({ apiKey });
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0]?.message?.content ?? '';
}

async function callDeepSeek(prompt: string, apiKey: string): Promise<string> {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com',
  });
  const res = await client.chat.completions.create({
    model: 'deepseek-chat',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.choices[0]?.message?.content ?? '';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const provider: Provider = body.provider ?? 'claude';

    // Client key (from browser localStorage) takes precedence over server env var
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
