/**
 * ai-explain/route.ts — AI verdict over STRUCTURED evidence.
 * The server computes every number (historicalEvidence, riskModel, executionContext).
 * The model interprets; it is instructed never to invent probabilities.
 */
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { computeRiskModel, type RiskModel } from '@/lib/risk/riskModel';
import type { HistoricalEvidence, EvidenceBlock } from '@/lib/history/evidence';
import { loadLimits } from '@/lib/risk/limits';

type Provider = 'claude' | 'openai' | 'deepseek';

const SYSTEM = `You are the head trader of a proprietary crypto futures desk, mentoring one trader who is going full-time on a small account. Two decades in leveraged markets. Calm, surgical, plain English. You think in R-multiples first and dollars second.

Rules you never break:
1. You do NOT calculate or invent probabilities, win rates, expectancies or dollar figures. Every number you use must appear verbatim in the STRUCTURED EVIDENCE you are given. If a number is missing, say "not available".
2. Sample sizes and confidence intervals travel with every rate you quote. "INSUFFICIENT" or "VERY LOW EVIDENCE" samples cannot justify a trade.
3. NEUTRAL bias = NO TRADE. You never manufacture a direction.
4. The server's noTradeReasons are binding. If any exist, the verdict is NO TRADE unless the evidence you cite explicitly overrides them (it rarely will).
5. Hard risk limits are enforced by the server; you do not negotiate them.
6. No certainty language. Never: guaranteed, almost certain, easy, moon, massive opportunity, can't lose, free money.
7. Out-of-sample evidence outranks in-sample. Closest-match evidence outranks pair-wide evidence only when its sample is at least LOW EVIDENCE.
8. If the trader's realised journal diverges from the model, say so; never blend the two.
9. BTC context is measured per pair (correlation, share of days moving against BTC, LONG/SHORT results when BTC opposes). It changes size only when the pair's own history supports it; it is never the sole reason for NO TRADE on a loosely coupled pair.
10. Be concise. A desk note, not an essay.`;

const pctCI = (r: { rate: number; hits: number; n: number; ci95: [number, number] }) => `${(r.rate * 100).toFixed(1)}% (${r.hits}/${r.n}; 95% CI ${(r.ci95[0] * 100).toFixed(1)}–${(r.ci95[1] * 100).toFixed(1)}%)`;
const R = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`;
const $ = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;

function blockText(title: string, b?: EvidenceBlock): string {
  if (!b) return `${title}: not available`;
  return [
    `${title} — n=${b.n} [${b.quality}]`,
    `  TP1 before stop ${pctCI(b.tp1)} · TP2 ${pctCI(b.tp2)} · TP3 ${pctCI(b.tp3)} · stop-first ${pctCI(b.stopFirst)} · timeout ${(b.timeout.rate * 100).toFixed(1)}%`,
    `  expectancy ${R(b.expectancyR)} · median ${R(b.medianR)} · profit factor ${b.profitFactor.toFixed(2)} · avg win ${R(b.avgWinR)} · avg loss ${R(b.avgLossR)}`,
    `  avg MFE ${R(b.avgMfeR)} · avg MAE ${R(b.avgMaeR)} · max DD ${b.maxDrawdownR.toFixed(1)}R · max losing streak ${b.maxConsecutiveLosses} · avg hold ${b.avgHoldHours.toFixed(1)}h`,
    b.warnings.length ? `  warnings: ${b.warnings.join(' | ')}` : '',
  ].filter(Boolean).join('\n');
}

function buildPrompt(body: Record<string, unknown>): string {
  const b = body as {
    symbol: string; price: number; direction: 'LONG' | 'SHORT' | 'NEUTRAL'; totalScore: number; confidence: number; alignmentScore: number; alignmentQuality: string; bestSetup: string;
    masterSignal: { entry: number; stopLoss: number; tp1: number; tp2: number; tp3: number; leverage: number; netRR: number; entryTiming?: string };
    deep: { hasBOS: boolean; hasOB: boolean; hasFVG: boolean; hasChoCH: boolean; hasSweep: boolean; macdBull: boolean; macdBear: boolean; vwapAbove: boolean; volRatio: number; rsi: number; wyckoffPhase: string; amdBias?: string };
    trendMap?: Record<string, string>; fundingRate?: number | null; avgMoves?: { daily: number; h8: number; h4: number };
    features?: Record<string, unknown> | null;
    historicalEvidence?: HistoricalEvidence | null;
    account?: { accountSize?: number; riskPct?: number; leverage?: number; orderType?: 'Limit' | 'Market'; dailyLossLimit?: number; dailyTarget?: number; maxTrades?: number; openTrades?: number };
    realized?: { n: number; expectancyR: number; tp1Rate: number } | null;
    btcDirection?: string; btcScore?: number;
  };
  const acct = { size: b.account?.accountSize ?? 2000, riskPct: b.account?.riskPct ?? 1, lev: b.account?.leverage ?? b.masterSignal.leverage ?? 3, orderType: b.account?.orderType ?? 'Limit', open: b.account?.openTrades ?? 0 };
  const limits = loadLimits();
  const isNeutral = b.direction === 'NEUTRAL';
  const dir: 'LONG' | 'SHORT' = b.direction === 'NEUTRAL' ? 'LONG' : b.direction;
  let rm: RiskModel | null = null;
  try { rm = computeRiskModel({ capital: acct.size, riskPct: acct.riskPct, entry: b.masterSignal.entry, stopLoss: b.masterSignal.stopLoss, tp1: b.masterSignal.tp1, tp2: b.masterSignal.tp2, tp3: b.masterSignal.tp3, direction: dir, leverage: acct.lev, orderType: acct.orderType, fundingRate8h: b.fundingRate ?? null, expectedHoldHours: 8 }); } catch { rm = null; }
  const ev = b.historicalEvidence;
  const f = (v: number) => v < 1 ? v.toFixed(6) : v < 100 ? v.toFixed(4) : v.toFixed(2);
  const tf = b.trendMap ? Object.entries(b.trendMap).map(([k, v]) => `${k}=${v}`).join(' | ') : 'n/a';
  const conf = [b.deep.hasBOS && 'BOS', b.deep.hasChoCH && 'CHoCH', b.deep.hasOB && 'OB', b.deep.hasFVG && 'FVG', b.deep.hasSweep && 'sweep', (dir === 'LONG' ? b.deep.macdBull : b.deep.macdBear) && 'MACD aligned', (b.deep.vwapAbove === (dir === 'LONG')) && 'VWAP side', b.deep.volRatio >= 1.5 && `vol ${b.deep.volRatio.toFixed(1)}×`].filter(Boolean).join(', ') || 'none';

  const evidenceText = !ev ? 'HISTORICAL EVIDENCE: not available (no replay for this pair).'
    : !ev.available ? `HISTORICAL EVIDENCE: not available — ${ev.reason}`
    : [
      `HISTORICAL EVIDENCE (independent exchange-data replay, ${ev.executionProfile} execution, net of fees/slippage/funding; built ${ev.builtAt?.slice(0, 10)}; ${ev.decisions} hourly decisions, ${ev.neutralDecisions} neutral)`,
      `Sample quality scale: ${ev.sampleQualityScale}`,
      blockText('A. PAIR-WIDE', ev.pairWide),
      blockText(`B. CURRENT REGIME ${ev.regime?.regimeKey ?? ''} (${((ev.regime?.regimeShareOfPair ?? 0) * 100).toFixed(0)}% of pair setups${ev.regime?.rare ? ', RARE' : ''})`, ev.regime),
      blockText(`C. CLOSEST MATCHES (k=${ev.similarSetups?.k ?? 0}, avg distance ${ev.similarSetups?.avgDistance.toFixed(2) ?? 'n/a'})`, ev.similarSetups),
      blockText(`D. OUT-OF-SAMPLE (${ev.outOfSample?.method ?? ''}; ${ev.outOfSample?.folds ?? 0} folds, ${ev.outOfSample?.foldsPositive ?? 0} positive; in-sample ${R(ev.outOfSample?.inSampleExpectancyR ?? 0)} n=${ev.outOfSample?.inSampleN ?? 0}; degradation ${R(ev.outOfSample?.degradationR ?? 0)})`, ev.outOfSample),
      `E. BTC CONTEXT TEST: ${ev.btcSplit?.note ?? 'n/a'} — BTC is currently ${ev.btcSplit?.alignedNow ?? 'UNKNOWN'} relative to this trade.`,
      `   BTC COUPLING (measured): ${ev.btcRelation ? `${ev.btcRelation.coupling} · 4h corr all ${ev.btcRelation.corr4hAll.toFixed(2)} / 90d ${ev.btcRelation.corr4h90d.toFixed(2)} · beta ${ev.btcRelation.beta4h.toFixed(2)} · closes against BTC ${(ev.btcRelation.oppositeDayShare * 100).toFixed(0)}% of days (90d ${(ev.btcRelation.oppositeDayShare90d * 100).toFixed(0)}%) over ${ev.btcRelation.days} days` : 'not measured'}`,
      ev.source && ev.source !== 'bybit' ? `   DATA SOURCE: ${ev.source.toUpperCase()} (fallback venue; execution is on Bybit — prices track within bps but are not identical)` : '',
      `F. RECENT EDGE: ${ev.decay?.status} — ${ev.decay?.note} (last20 ${R(ev.decay?.last20ExpectancyR ?? 0)}, last50 ${R(ev.decay?.last50ExpectancyR ?? 0)} n=${ev.decay?.last50N ?? 0}, last90d ${R(ev.decay?.last90dExpectancyR ?? 0)}, long-term ${R(ev.decay?.longTermExpectancyR ?? 0)})`,
      ev.warnings.length ? `WARNINGS: ${ev.warnings.join(' | ')}` : 'WARNINGS: none',
      ev.noTradeReasons.length ? `SERVER NO-TRADE REASONS (binding): ${ev.noTradeReasons.join(' | ')}` : 'SERVER NO-TRADE REASONS: none',
    ].join('\n');

  const riskText = !rm ? 'RISK MODEL: not computable' : [
    `RISK MODEL (deterministic; ${acct.orderType} entry, taker stop, maker targets, ${rm.slippage.entry > 0 ? '5bps' : '0'} entry slippage)`,
    `Capital ${$(rm.capital)} · risk ${rm.riskPct}% = ${$(rm.riskAmount)} · stop distance ${(rm.stopDistancePct * 100).toFixed(2)}% · qty ${rm.qty.toFixed(4)} · notional ${$(rm.notional)}`,
    `Margin @${rm.leverage}× ${$(rm.margin.atLeverage)} · @2× ${$(rm.margin.x2)} · @3× ${$(rm.margin.x3)} · @5× ${$(rm.margin.x5)}`,
    `Liquidation (estimate) ${f(rm.liquidation.price)} · ${rm.liquidation.distancePct.toFixed(2)}% from entry · buffer beyond stop ${rm.liquidation.stopToLiqPct.toFixed(2)}% · ${rm.liquidation.safe ? 'SAFE' : 'TOO CLOSE'} · max safe leverage ${rm.liquidation.maxSafeLeverage}×`,
    `Fees: entry ${$(rm.fees.entry)} · stop exit ${$(rm.fees.stopExit)} · TP exits ${$(rm.fees.tp1Exit)}/${$(rm.fees.tp2Exit)}/${$(rm.fees.tp3Exit)} · slippage if stopped ${$(rm.slippage.totalIfStopped)} · funding est ${$(rm.funding.estimate)} (${rm.funding.rate8h == null ? 'n/a' : (rm.funding.rate8h * 100).toFixed(4) + '%/8h'})`,
    `NET: stop ${$(rm.net.stop)} · TP1 full ${$(rm.net.tp1Full)} · TP2 full ${$(rm.net.tp2Full)} · TP3 full ${$(rm.net.tp3Full)} · staged 50/25/25 ${$(rm.net.staged)} (${R(rm.net.stagedR)})`,
    `R multiples: TP1 ${rm.rMultiples.tp1.toFixed(2)}R · TP2 ${rm.rMultiples.tp2.toFixed(2)}R · TP3 ${rm.rMultiples.tp3.toFixed(2)}R`,
    rm.warnings.length ? `risk warnings: ${rm.warnings.join(' | ')}` : '',
  ].filter(Boolean).join('\n');

  const realizedText = b.realized && b.realized.n >= 10
    ? `TRADER'S REALISED JOURNAL (secondary, never blended): n=${b.realized.n} · expectancy ${R(b.realized.expectancyR)} · TP1 ${(b.realized.tp1Rate * 100).toFixed(0)}%`
    : `TRADER'S REALISED JOURNAL: fewer than 10 closed trades — unproven.`;

  return `PAIR: ${b.symbol} PERP @ $${f(b.price)}
ENGINE: bias ${b.direction}${isNeutral ? ' (NO TRADE by rule)' : ''} · Setup Quality ${b.totalScore}/100 (heuristic ranking, NOT a probability) · style ${b.bestSetup} · entry timing ${b.masterSignal.entryTiming ?? 'n/a'}
Timeframes: ${tf} · alignment ${b.alignmentScore}% (${b.alignmentQuality})
Confluences: ${conf} · RSI ${b.deep.rsi.toFixed(1)} · Wyckoff ${b.deep.wyckoffPhase} · AMD ${b.deep.amdBias ?? 'n/a'} · funding ${b.fundingRate == null ? 'n/a' : (b.fundingRate * 100).toFixed(4) + '%'}
${b.avgMoves ? `Typical range: 4h ±${b.avgMoves.h4.toFixed(2)}% · 8h ±${b.avgMoves.h8.toFixed(2)}% · day ±${b.avgMoves.daily.toFixed(2)}%` : ''}
LEVELS (${isNeutral ? 'display only' : dir}): entry $${f(b.masterSignal.entry)} · stop $${f(b.masterSignal.stopLoss)} · TP1 $${f(b.masterSignal.tp1)} · TP2 $${f(b.masterSignal.tp2)} · TP3 $${f(b.masterSignal.tp3)}
BTC: ${b.btcDirection ?? 'n/a'} (score ${b.btcScore ?? 'n/a'})
EXECUTION CONTEXT: hard limits — max risk ${limits.maxRiskPctPerTrade}%/trade, daily loss ${limits.maxDailyLossPct}%, max leverage ${limits.maxLeverage}×, max ${limits.maxConcurrentPositions} positions, ${limits.maxTradesPerDay} trades/day; open positions now ${acct.open}.

${evidenceText}

${riskText}

${realizedText}

Write the desk note in EXACTLY this structure (plain text headings, no markdown tables):

PAIR: ${b.symbol}
BIAS: LONG / SHORT / NO TRADE
ENTRY STATUS: ENTER / WAIT FOR PULLBACK / WAIT FOR RETEST / NO TRADE
HISTORICAL EVIDENCE:
  (quote closest-match n, TP1 with 95% CI, TP2, TP3, OOS expectancy, profit factor, max losing streak — numbers verbatim from above, or "not available")
REGIME:
  (current regime key, regime n, regime expectancy)
TRADE:
  Entry / Stop / TP1 / TP2 / TP3
ACCOUNT:
  Capital / Risk / Notional / Margin @3x / Margin @5x
NET PNL:
  Stop / TP1 / TP2 / TP3 / Staged
TRADER'S VERDICT:
  2–5 concise paragraphs. Weigh out-of-sample first, then closest matches, then regime, then pair-wide. State size: full / half / quarter / paper / none. Mention the BTC test result and recent-edge status explicitly.
INVALIDATION:
  Exact price level or candle close that kills the setup.
DO NOT TRADE IF:
  Specific, checkable conditions.`;
}

async function callClaude(prompt: string, apiKey: string) {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1600, system: SYSTEM, messages: [{ role: 'user', content: prompt }] });
  return (msg.content[0] as { type: string; text: string }).text;
}
async function callOpenAI(prompt: string, apiKey: string) {
  const client = new OpenAI({ apiKey });
  const res = await client.chat.completions.create({ model: 'gpt-4o', max_tokens: 1600, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] });
  return res.choices[0]?.message?.content ?? '';
}
async function callDeepSeek(prompt: string, apiKey: string) {
  const client = new OpenAI({ apiKey, baseURL: 'https://api.deepseek.com' });
  const res = await client.chat.completions.create({ model: 'deepseek-chat', max_tokens: 1600, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] });
  return res.choices[0]?.message?.content ?? '';
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const provider: Provider = body.provider ?? 'claude';
    const clientKey: string | undefined = body.clientApiKey;
    const envKeyMap: Record<Provider, string | undefined> = { claude: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY };
    const resolvedKey = clientKey || envKeyMap[provider];
    if (!resolvedKey) {
      const envVarName = provider === 'claude' ? 'ANTHROPIC_API_KEY' : provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY';
      return NextResponse.json({ error: `No API key for ${provider}. Paste your ${envVarName} in Settings → AI Analysis Provider.` }, { status: 400 });
    }
    const prompt = buildPrompt(body);
    let explanation = '';
    if (provider === 'claude') explanation = await callClaude(prompt, resolvedKey);
    if (provider === 'openai') explanation = await callOpenAI(prompt, resolvedKey);
    if (provider === 'deepseek') explanation = await callDeepSeek(prompt, resolvedKey);
    return NextResponse.json({ explanation, provider });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
