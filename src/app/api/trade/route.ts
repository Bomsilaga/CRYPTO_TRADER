/**
 * trade/route.ts — execution endpoint.
 *
 * Security model (Phase 1):
 *  - LIVE requires TRADING_MODE=live on the server AND a valid TRADE_AUTH_TOKEN
 *    AND liveMode:true in the request AND a durable KV. Otherwise PAPER.
 *  - Server Bybit keys are never returned. Client-supplied keys are accepted
 *    only on an authenticated request.
 *  - Idempotency: every request carries a tradeId; a replay returns the stored result.
 *  - Hard risk limits are enforced here and cannot be bypassed by `force`
 *    (which only skips the SOFT funding-rate warning).
 *  - Market fills are reconciled against the real position (avg price, size,
 *    exchange liquidation price); the stop is verified by re-reading the position.
 *  - Limit entries enter a state machine driven by /api/trade/manage.
 */
import { NextRequest, NextResponse } from 'next/server';
import { fetchFundingRate } from '@/lib/bybit';
import { authorizeExecution } from '@/lib/auth';
import { getKV } from '@/lib/kv';
import { computeRiskModel } from '@/lib/risk/riskModel';
import { checkHardLimits, dayKey, loadLimits } from '@/lib/risk/limits';
import { fetchInstrument, fmtStep, makeBybitClient, roundToStep, type Instrument } from '@/lib/bybitPrivate';
import { log, placeStagedTPs, readPosition, reconcileFill, splitQty, verifyStop, type TradeRecord } from '@/lib/execution';

export const maxDuration = 60;

const ENV_API_KEY = process.env.BYBIT_API_KEY ?? '';
const ENV_API_SECRET = process.env.BYBIT_API_SECRET ?? '';
const FUNDING_LONG_THRESHOLD = 0.001, FUNDING_SHORT_THRESHOLD = -0.001;
const MARGIN_BUFFER = 0.9;

export interface TradeRequest {
  tradeId?: string;
  symbol: string; direction: 'LONG' | 'SHORT';
  entry: number; stopLoss: number; tp1: number; tp2: number; tp3: number;
  leverage: number; riskPct: number; style?: string;
  orderType?: 'Market' | 'Limit'; force?: boolean; userLeverage?: number;
  accountSize?: number; marginUsdt?: number;
  apiKey?: string; apiSecret?: string; liveMode?: boolean;
}

function sizeToExchange(qtyRaw: number, inst: Instrument, entry: number, leverage: number, available: number) {
  const warnings: string[] = [];
  let qty = qtyRaw;
  const maxMargin = available * MARGIN_BUFFER;
  if ((qty * entry) / leverage > maxMargin) { qty = (maxMargin * leverage) / entry; warnings.push(`Margin-capped to ${(maxMargin).toFixed(0)} available margin — size reduced.`); }
  qty = roundToStep(qty, inst.qtyStep, 'floor');
  if (qty > inst.maxQty) { qty = inst.maxQty; warnings.push(`Qty capped to exchange max ${inst.maxQty}.`); }
  if (qty < inst.minQty) throw new Error(`Position too small: ${qty} < min ${inst.minQty}. Stop too tight for this account size.`);
  return { qty, warnings };
}

export async function POST(req: NextRequest) {
  const kv = getKV();
  let tradeId = '';
  try {
    const body: TradeRequest = await req.json();
    const { symbol, direction, entry, stopLoss, tp1, tp2, tp3, leverage, riskPct, orderType = 'Market', force = false, userLeverage, accountSize, marginUsdt } = body;
    tradeId = String(body.tradeId ?? '').trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(tradeId)) return NextResponse.json({ error: 'tradeId (8–64 chars) is required for idempotent execution' }, { status: 400 });
    if (!symbol || !direction || !(entry > 0) || !(stopLoss > 0) || !(riskPct > 0)) return NextResponse.json({ error: 'Invalid trade request' }, { status: 400 });
    if ((direction === 'LONG' && stopLoss >= entry) || (direction === 'SHORT' && stopLoss <= entry)) return NextResponse.json({ error: 'Stop is on the wrong side of entry' }, { status: 400 });

    // ── Idempotency ───────────────────────────────────────────────────────
    const prior = await kv.get<{ status: 'pending' | 'done'; result?: unknown }>(`trade:${tradeId}`);
    if (prior) return NextResponse.json({ ...(prior.result as object ?? {}), idempotent: true, status: prior.status });
    const claimed = await kv.claim(`trade:${tradeId}`, { status: 'pending', at: Date.now() }, 7 * 86_400);
    if (!claimed) return NextResponse.json({ idempotent: true, status: 'pending', message: 'This trade is already being processed.' });
    const finish = async (result: object, status = 200) => { await kv.set(`trade:${tradeId}`, { status: 'done', result }, 7 * 86_400); return NextResponse.json(result, { status }); };

    // ── Authorization + trading mode (server decides) ─────────────────────
    const auth = authorizeExecution(req.headers, body, process.env, kv.durable);
    const limits = loadLimits();
    const effectiveLeverage = Math.max(1, userLeverage ?? leverage);
    const inst = await fetchInstrument(symbol);
    const pEntry = roundToStep(entry, inst.tickSize), pSL = roundToStep(stopLoss, inst.tickSize);
    const pTP = [tp1, tp2, tp3].map(p => roundToStep(p, inst.tickSize));

    // ── PAPER ─────────────────────────────────────────────────────────────
    if (auth.mode === 'paper') {
      const capital = accountSize && accountSize > 0 ? accountSize : 2000;
      const rm = computeRiskModel({ capital, riskPct, entry: pEntry, stopLoss: pSL, tp1: pTP[0], tp2: pTP[1], tp3: pTP[2], direction, leverage: effectiveLeverage, orderType, marginOverride: marginUsdt });
      const { qty, warnings } = sizeToExchange(rm.qty, inst, pEntry, effectiveLeverage, capital);
      const day = dayKey();
      const tradesToday = Number((await kv.get<number>(`paper:${day}:count`)) ?? 0);
      const hard = checkHardLimits({
        equity: capital, riskPct, riskUsd: qty * Math.abs(pEntry - pSL), leverage: effectiveLeverage, notional: qty * pEntry,
        openPositions: 0, openRiskUsd: 0, dailyRealizedPnlUsd: Number((await kv.get<number>(`paper:${day}:pnl`)) ?? 0), tradesToday,
        stopDistancePct: rm.stopDistancePct, liqDistancePct: rm.liquidation.distancePct / 100, symbol, openSymbols: [],
      }, limits);
      if (!hard.ok) return finish({ rejected: true, hard: true, reason: 'HARD_RISK_LIMIT', rejections: hard.rejections, warnings: hard.warnings, mode: 'paper', liveRefusedBecause: auth.reasons });
      await kv.incr(`paper:${day}:count`, 1, 2 * 86_400);
      return finish({
        paper: true, mode: 'paper', liveRefusedBecause: auth.reasons.length ? auth.reasons : undefined,
        message: '📄 PAPER — simulated fill, staged exits recorded', orderType, fundingChecked: !force,
        warnings: [...warnings, ...hard.warnings, ...rm.warnings], qty, balance: capital.toFixed(2),
        riskAmt: (qty * Math.abs(pEntry - pSL)).toFixed(2), notional: (qty * pEntry).toFixed(2), margin: ((qty * pEntry) / effectiveLeverage).toFixed(2),
        plan: { entry: pEntry, stopLoss: pSL, tp1: pTP[0], tp2: pTP[1], tp3: pTP[2], tpQtys: splitQty(qty, inst), split: '50/25/25' },
        riskModel: rm, netIfAllTargets: rm.net.staged.toFixed(2), netIfStopped: rm.net.stop.toFixed(2),
        simulated: { symbol, direction, entry: pEntry, stopLoss: pSL, tp1: pTP[0], tp2: pTP[1], tp3: pTP[2], leverage: effectiveLeverage, riskPct },
      });
    }

    // ── LIVE ──────────────────────────────────────────────────────────────
    const API_KEY = (auth.authenticated && body.apiKey) || ENV_API_KEY;
    const API_SECRET = (auth.authenticated && body.apiSecret) || ENV_API_SECRET;
    if (!API_KEY || !API_SECRET) return finish({ error: 'No Bybit credentials available for live execution.' }, 400);
    const client = makeBybitClient(API_KEY, API_SECRET);
    if (effectiveLeverage > inst.maxLeverage) return finish({ error: `${symbol} max leverage is ${inst.maxLeverage}×` }, 400);

    const [{ equity, available }, positions, closed] = await Promise.all([
      client.walletBalance(), client.positions(), client.closedPnlSince(new Date(`${dayKey()}T00:00:00Z`).getTime()),
    ]);
    if (available <= 0) return finish({ error: 'No available USDT balance.' }, 400);
    const rm = computeRiskModel({ capital: equity, riskPct, entry: pEntry, stopLoss: pSL, tp1: pTP[0], tp2: pTP[1], tp3: pTP[2], direction, leverage: effectiveLeverage, orderType, marginOverride: marginUsdt });
    const { qty, warnings } = sizeToExchange(rm.qty, inst, pEntry, effectiveLeverage, available);
    const riskUsd = qty * Math.abs(pEntry - pSL);
    const day = dayKey();
    const tradesToday = Math.max(closed.count, Number((await kv.get<number>(`live:${day}:count`)) ?? 0));
    const openRiskUsd = positions.reduce((a, p) => a + (p.stopLoss ? p.size * Math.abs(p.avgPrice - p.stopLoss) : p.size * p.avgPrice * 0.02), 0);
    const hard = checkHardLimits({
      equity, riskPct, riskUsd, leverage: effectiveLeverage, notional: qty * pEntry,
      openPositions: positions.length, openRiskUsd, dailyRealizedPnlUsd: closed.pnl, tradesToday,
      stopDistancePct: rm.stopDistancePct, liqDistancePct: rm.liquidation.distancePct / 100, symbol, openSymbols: positions.map(p => p.symbol),
    }, limits);
    if (!hard.ok) return finish({ rejected: true, hard: true, reason: 'HARD_RISK_LIMIT', rejections: hard.rejections, warnings: hard.warnings, mode: 'live' });

    // SOFT check — the only thing `force` can bypass
    if (!force) {
      const fr = await fetchFundingRate(symbol);
      if ((direction === 'LONG' && fr > FUNDING_LONG_THRESHOLD) || (direction === 'SHORT' && fr < FUNDING_SHORT_THRESHOLD)) {
        // soft rejection: stored briefly; the client re-submits with a NEW tradeId when forcing
        const soft = { rejected: true, soft: true, reason: 'FUNDING_RATE_RISK', fundingRate: fr, message: `Funding ${(fr * 100).toFixed(4)}% is crowded against this ${direction}. Re-submit with force (new tradeId) to accept.` };
        await kv.set(`trade:${tradeId}`, { status: 'done', result: soft }, 120);
        return NextResponse.json(soft);
      }
    }

    await client.setLeverage(symbol, effectiveLeverage);
    const rec: TradeRecord = {
      tradeId, symbol, direction, orderType, state: 'ENTRY_PENDING',
      intended: { entry: pEntry, stopLoss: pSL, tp1: pTP[0], tp2: pTP[1], tp3: pTP[2], qty, riskUsd, leverage: effectiveLeverage },
      events: [], inst, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const side = direction === 'LONG' ? 'Buy' : 'Sell';
    const order = await client.createOrder({
      symbol, side, orderType, qty: fmtStep(qty, inst.qtyStep),
      stopLoss: fmtStep(pSL, inst.tickSize), tpslMode: 'Full', slTriggerBy: 'MarkPrice', slOrderType: 'Market',
      timeInForce: orderType === 'Limit' ? 'PostOnly' : 'IOC', orderLinkId: `4s-${tradeId}-entry`,
      ...(orderType === 'Limit' ? { price: fmtStep(pEntry, inst.tickSize) } : {}),
    });
    if (order.retCode !== 0) return finish({ error: `Entry rejected by Bybit: ${order.retMsg}` }, 400);
    rec.orderId = order.result?.orderId;
    log(rec, `entry ${orderType} accepted: ${rec.orderId}`);
    await kv.incr(`live:${day}:count`, 1, 2 * 86_400);

    if (orderType === 'Limit') {
      rec.slVerified = 'pending-fill';
      await kv.set(`traderec:${tradeId}`, rec, 30 * 86_400);
      return finish({ success: true, mode: 'live', state: rec.state, manage: true, tradeId, orderId: rec.orderId, symbol, direction, qty, leverage: effectiveLeverage,
        entry: pEntry, stopLoss: pSL, tp1: pTP[0], tp2: pTP[1], tp3: pTP[2], orderType, warnings: [...warnings, ...hard.warnings], slVerified: rec.slVerified,
        riskModel: rm, message: `Limit entry resting (PostOnly). Stop attached to the order. Targets attach on fill via /api/trade/manage.` });
    }

    // Market: reconcile → verify stop → staged TPs
    const pos = await readPosition(client, symbol, 4, 400);
    if (!pos) { await kv.set(`traderec:${tradeId}`, rec, 30 * 86_400); return finish({ error: `Order ${rec.orderId} accepted but no position visible after 1.6s. Check Bybit before re-submitting.`, tradeId, orderId: rec.orderId }, 500); }
    rec.state = 'PROTECTION_PENDING';
    const filledQty = await reconcileFill(client, rec, pos);
    if ((rec.state as string) === 'EMERGENCY_CLOSED') { await kv.set(`traderec:${tradeId}`, rec, 30 * 86_400); return finish({ error: '🚨 EMERGENCY CLOSE — fill slippage pushed true risk far beyond target. Position flattened.', tradeId, events: rec.events }, 500); }
    rec.slVerified = await verifyStop(client, rec, pSL);
    if (rec.slVerified === 'failed') { await kv.set(`traderec:${tradeId}`, rec, 30 * 86_400); return finish({ error: '🚨 EMERGENCY CLOSE — stop could not be verified on the position. Flattened. Check Bybit now.', tradeId, events: rec.events }, 500); }
    rec.state = 'SL_CONFIRMED';
    const tpsOk = await placeStagedTPs(client, rec, filledQty);
    rec.state = tpsOk ? 'MANAGED' : 'TPS_CONFIRMED';
    await kv.set(`traderec:${tradeId}`, rec, 30 * 86_400);
    const a = rec.actual!;
    return finish({
      success: true, mode: 'live', state: rec.state, tradeId, orderId: rec.orderId, symbol, direction, qty: a.qty, leverage: effectiveLeverage,
      entry: a.avgPrice, intendedEntry: pEntry, stopLoss: pSL, tp1: pTP[0], tp2: pTP[1], tp3: pTP[2], orderType,
      warnings: [...warnings, ...hard.warnings, ...(tpsOk ? [] : ['Some targets failed to place — position is stop-protected; place the missing targets manually.'])],
      slVerified: rec.slVerified, tpStatus: rec.tpOrders,
      actual: a, liquidation: { price: a.liqPrice, distancePct: a.liqDistancePct, stopToLiqPct: a.stopToLiqPct, basis: 'exchange' },
      balance: equity.toFixed(2), riskAmt: a.riskUsd.toFixed(2), notional: (a.qty * a.avgPrice).toFixed(2), margin: ((a.qty * a.avgPrice) / effectiveLeverage).toFixed(2),
      riskModel: rm, events: rec.events,
      message: `✅ ${direction} ${a.qty} ${symbol} @ ${a.avgPrice} · stop ${rec.slVerified} · ${rec.tpOrders?.filter(t => t.ok).length}/${rec.tpOrders?.length} targets`,
    });
  } catch (err) {
    console.error(err);
    if (tradeId) await kv.set(`trade:${tradeId}`, { status: 'done', result: { error: String(err) } }, 3600).catch(() => {});
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
