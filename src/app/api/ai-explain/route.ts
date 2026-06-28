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

  const slPct = (Math.abs(masterSignal.entry - masterSignal.stopLoss) / masterSignal.entry * 100).toFixed(2);

  const btcAligned = !btcDirection || btcDirection === 'NEUTRAL' || btcDirection === direction;
  const btcSection = btcDirection && btcDeep ? `
BTC TREND CONTEXT (macro filter):
BTC Direction: ${btcDirection} | Score: ${btcScore}/100 | Confidence: ${btcConfidence}%
BTC RSI: ${btcDeep.rsi.toFixed(1)}${btcDeep.rsi > 70 ? ' (OVERBOUGHT)' : btcDeep.rsi < 30 ? ' (OVERSOLD)' : ''} | BTC Wyckoff: ${btcDeep.wyckoffPhase}
BTC MACD: ${btcDeep.macdBull ? 'Bullish' : btcDeep.macdBear ? 'Bearish' : 'Neutral'} | BTC VWAP: price ${btcDeep.vwapAbove ? 'ABOVE' : 'BELOW'} | BTC Vol: ${btcDeep.volRatio.toFixed(2)}× avg
BTC Alignment: ${btcAligned ? '✓ ALIGNED — macro supports this trade' : '⚠ DIVERGING — BTC trending opposite, increased risk'}` : '';

  return `You are a professional ICT (Inner Circle Trader) and Wyckoff methodology expert. Analyse this signal and give a clear, actionable deep explanation for a trader with $2,000 capital.

SIGNAL:
Symbol: ${symbol} PERP | Price: $${price} | Direction: ${direction}
Score: ${totalScore}/100 | Confidence: ${confidence}% | Setup: ${bestSetup}
Alignment: ${alignmentScore}% across 6 timeframes (${alignmentQuality})

TRADE LEVELS:
Entry: $${masterSignal.entry} | SL: $${masterSignal.stopLoss} (${slPct}% away)
TP1 50%: $${masterSignal.tp1} | TP2 25%: $${masterSignal.tp2} | TP3 25%: $${masterSignal.tp3}
Net R:R: ${masterSignal.netRR}× | Engine leverage rec: ${masterSignal.leverage}× (cap at 5× regardless)

STRUCTURE:
BOS: ${deep.hasBOS ? 'YES' : 'NO'} | OB: ${deep.hasOB ? 'YES' : 'NO'} | FVG: ${deep.hasFVG ? 'YES' : 'NO'}
CHoCH: ${deep.hasChoCH ? 'YES' : 'NO'} | Sweep: ${deep.hasSweep ? 'YES' : 'NO'}
MACD: ${deep.macdBull ? 'Bullish' : deep.macdBear ? 'Bearish' : 'Neutral'}
VWAP: price ${deep.vwapAbove ? 'ABOVE' : 'BELOW'} | Volume: ${deep.volRatio.toFixed(2)}× avg
RSI: ${deep.rsi.toFixed(1)}${deep.rsi > 70 ? ' (OVERBOUGHT)' : deep.rsi < 30 ? ' (OVERSOLD)' : ''}
Wyckoff: ${deep.wyckoffPhase}
${btcSection}
Respond in these exact sections (be concise and specific, not generic):

**WHY THIS SETUP**
Key confluence factors that make this valid — or risks if weak.

**ENTRY TIMING**
Exactly when to enter. Current price vs entry context. Any required confirmation.

**RISK BREAKDOWN**
Dollar figures for $2,000 account at 3× and 5×. What does losing cost?

**BTC CONTEXT**
${btcDirection ? `How BTC's ${btcDirection} trend (score ${btcScore}) and ${btcAligned ? 'alignment' : 'divergence'} affects this trade. Specific divergences to note.` : 'BTC data unavailable — assess without macro filter.'}

**WHAT TO WATCH**
2–3 specific price levels or conditions that would invalidate before entry.

**VERDICT**
One clear sentence: Enter now / Wait for pullback / Skip — and exactly why.`;
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
