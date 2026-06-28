import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { symbol, price, direction, totalScore, confidence, alignmentScore, alignmentQuality,
            bestSetup, masterSignal, deep } = body;

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
    }

    const prompt = `You are a professional ICT (Inner Circle Trader) and Wyckoff methodology expert.
Analyse this signal and provide a clear, actionable deep explanation for a trader with $2,000 capital.

SIGNAL DATA:
Symbol: ${symbol} PERP
Current price: $${price}
Direction: ${direction}
Score: ${totalScore}/100 | Confidence: ${confidence}% | Setup: ${bestSetup}
Alignment: ${alignmentScore}% across 6 timeframes (${alignmentQuality})

TRADE LEVELS:
Entry: $${masterSignal.entry}
Stop Loss: $${masterSignal.stopLoss} (${(((masterSignal.entry - masterSignal.stopLoss) / masterSignal.entry) * 100).toFixed(2)}% from entry)
TP1 (50% position): $${masterSignal.tp1}
TP2 (25% position): $${masterSignal.tp2}
TP3 (25% position): $${masterSignal.tp3}
Net R:R: ${masterSignal.netRR}x
Engine leverage: ${masterSignal.leverage}x (rule: cap at 5x regardless of recommendation)

STRUCTURE CONFIRMATION:
BOS (Break of Structure): ${deep.hasBOS ? 'YES' : 'NO'}
Order Block: ${deep.hasOB ? 'YES (verified)' : 'NO'}
Fair Value Gap: ${deep.hasFVG ? 'YES' : 'NO'}
CHoCH (Change of Character): ${deep.hasChoCH ? 'YES' : 'NO'}
Liquidity Sweep: ${deep.hasSweep ? 'YES' : 'NO'}
MACD: ${deep.macdBull ? 'Bullish' : deep.macdBear ? 'Bearish' : 'Neutral'}
VWAP: Price ${deep.vwapAbove ? 'ABOVE' : 'BELOW'} VWAP
Volume ratio: ${deep.volRatio.toFixed(2)}x average
RSI: ${deep.rsi.toFixed(1)}${deep.rsi > 70 ? ' (OVERBOUGHT)' : deep.rsi < 30 ? ' (OVERSOLD)' : ''}
Wyckoff phase: ${deep.wyckoffPhase}

Write your response in these exact sections (keep each section focused and concise):

**WHY THIS SETUP**
2-3 sentences on the key confluence factors that make this valid (or risky if weak).

**ENTRY TIMING**
When exactly to enter — wait for confirmation? Current price vs entry price context.

**RISK BREAKDOWN**
Specific dollar amounts for a $2,000 account at 3x and 5x leverage. What does losing this trade cost?

**WHAT TO WATCH**
2-3 specific price levels or conditions that would invalidate this trade before entry.

**VERDICT**
One clear sentence: Enter now / Wait for pullback / Skip this one — and why.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = (message.content[0] as { type: string; text: string }).text;
    return NextResponse.json({ explanation: text });

  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
