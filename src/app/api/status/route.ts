import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    bybit:    !!(process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET),
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    openai:    !!process.env.OPENAI_API_KEY,
    deepseek:  !!process.env.DEEPSEEK_API_KEY,
    testnet:   process.env.BYBIT_TESTNET === 'true',
  });
}
