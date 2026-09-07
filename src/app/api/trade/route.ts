/**
 * trade/route.ts — Bybit Trade Execution
 *
 * Risk model
 * ──────────
 * qty = riskAmount / |entry − stopLoss|
 * Leverage never changes how much you lose at the stop — it only changes
 * how much margin is locked. Risk is defined by the stop, full stop.
 *
 * Execution model
 * ───────────────
 * 1. Entry (Market or PostOnly Limit) with a FULL-size stop attached.
 * 2. Staged, reduce-only limit exits: TP1 50% · TP2 25% · TP3 25%.
 * 3. After a market fill, the live position is read back and the stop is
 *    verified. Missing stop → re-attach via trading-stop → still missing →
 *    emergency market close. A naked position is never left open.
 * 4. Every exchange call is checked; partial failures are reported, never
 *    swallowed.
 * 5. Prices/qty are rounded to the instrument's tickSize / qtyStep.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { fetchFundingRate } from '@/lib/bybit';

const BYBIT_BASE = process.env.BYBIT_TESTNET === 'true'
  ? 'https://api-testnet.bybit.com'
  : 'https://api.bybit.com';

const ENV_API_KEY    = process.env.BYBIT_API_KEY    ?? '';
const ENV_API_SECRET = process.env.BYBIT_API_SECRET ?? '';

const FUNDING_LONG_THRESHOLD  =  0.001;
const FUNDING_SHORT_THRESHOLD = -0.001;
const MAKER_FEE = 0.00020;
const TAKER_FEE = 0.00055;
const MARGIN_BUFFER = 0.90;          // never commit more than 90% of free balance as margin
const TP_SPLIT = [0.5, 0.25, 0.25] as const;

type BybitResp = { retCode: number; retMsg: string; result?: Record<string, unknown> };

function makeSign(apiKey: string, apiSecret: string, params: Record<string, string | number>, timestamp: number, method: 'GET' | 'POST'): string {
  const payloadBody = method === 'GET'
    ? Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&')
    : JSON.stringify(params);
  const payload = `${timestamp}${apiKey}5000${payloadBody}`;
  return crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
}

function makeBybitRequest(apiKey: string, apiSecret: string) {
  return async function bybitRequest(method: 'GET' | 'POST', path: string, params: Record<string, string | number> = {}): Promise<BybitResp> {
    const ts = Date.now();
    const sig = makeSign(apiKey, apiSecret, params, ts, method);
    const qs = method === 'GET' && Object.keys(params).length
      ? '?' + Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(String(params[k]))}`).join('&')
      : '';
    const res = await fetch(`${BYBIT_BASE}${path}${qs}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': String(ts),
        'X-BAPI-SIGN': sig,
        'X-BAPI-RECV-WINDOW': '5000',
      },
      body: method === 'POST' ? JSON.stringify(params) : undefined,
      cache: 'no-store',
    });
    const text = await res.text();
    if (!text) throw new Error(`Bybit returned empty response (HTTP ${res.status}) — possible rate limit or invalid credentials`);
    try { return JSON.parse(text) as BybitResp; } catch { throw new Error(`Bybit bad JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  };
}

interface Instrument { tickSize: number; qtyStep: number; minQty: number; maxQty: number; maxLeverage: number }

async function fetchInstrument(symbol: string): Promise<Instrument> {
  const res = await fetch(`${BYBIT_BASE}/v5/market/instruments-info?category=linear&symbol=${symbol}`, { cache: 'no-store' });
  const json = await res.json() as { result?: { list?: Array<{ priceFilter: { tickSize: string }; lotSizeFilter: { qtyStep: string; minOrderQty: string; maxOrderQty: string }; leverageFilter: { maxLeverage: string } }> } };
  const inst = json.result?.list?.[0];
  if (!inst) throw new Error(`Instrument ${symbol} not found on Bybit linear`);
  return {
    tickSize:    parseFloat(inst.priceFilter.tickSize),
    qtyStep:     parseFloat(inst.lotSizeFilter.qtyStep),
    minQty:      parseFloat(inst.lotSizeFilter.minOrderQty),
    maxQty:      parseFloat(inst.lotSizeFilter.maxOrderQty),
    maxLeverage: parseFloat(inst.leverageFilter.maxLeverage),
  };
}

const decimalsOf = (step: number) => {
  const s = step.toString();
  if (s.includes('e-')) return parseInt(s.split('e-')[1], 10);
  return s.includes('.') ? s.split('.')[1].length : 0;
};
const roundToStep = (v: number, step: number, mode: 'floor' | 'round' = 'round') => {
  const d = decimalsOf(step);
  const n = mode === 'floor' ? Math.floor(v / step + 1e-9) : Math.round(v / step);
  return parseFloat((n * step).toFixed(d));
};
const fmtStep = (v: number, step: number) => v.toFixed(decimalsOf(step));

export interface TradeRequest {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  leverage: number;
  riskPct: number;
  style: string;
  orderType?: 'Market' | 'Limit';
  force?: boolean;
  userLeverage?: number;
  accountSize?: number;
  marginUsdt?: number;
  apiKey?: string;
  apiSecret?: string;
  liveMode?: boolean;
}

function sizePosition(opts: {
  balance: number; riskPct: number; entry: number; stopLoss: number; leverage: number;
  marginOverride?: number; inst: Instrument;
}) {
  const { balance, riskPct, entry, stopLoss, leverage, marginOverride, inst } = opts;
  const slDist = Math.abs(entry - stopLoss);
  if (slDist <= 0) throw new Error('Stop loss equals entry — cannot size position');
  const warnings: string[] = [];

  let riskAmt = balance * (riskPct / 100);
  let rawQty = marginOverride && marginOverride > 0
    ? (marginOverride * leverage) / entry
    : riskAmt / slDist;

  const maxMargin = balance * MARGIN_BUFFER;
  const marginNeeded = (rawQty * entry) / leverage;
  if (marginNeeded > maxMargin) {
    rawQty = (maxMargin * leverage) / entry;
    warnings.push(`Margin-capped: risk-based size needed $${marginNeeded.toFixed(0)} margin at ${leverage}× but only $${maxMargin.toFixed(0)} is available. Size reduced — effective risk is now $${(rawQty * slDist).toFixed(2)}.`);
  }

  let qty = roundToStep(rawQty, inst.qtyStep, 'floor');
  if (qty > inst.maxQty) { qty = inst.maxQty; warnings.push(`Qty capped to exchange max ${inst.maxQty}`); }
  if (qty < inst.minQty) throw new Error(`Position too small: ${qty} < min ${inst.minQty}. Widen risk % or the stop is too tight for this account size.`);

  riskAmt = qty * slDist;
  const notional = qty * entry;
  const margin = notional / leverage;

  const tpQtys = TP_SPLIT.map(f => roundToStep(qty * f, inst.qtyStep, 'floor'));
  const allocated = tpQtys.reduce((a, b) => a + b, 0);
  tpQtys[0] = roundToStep(tpQtys[0] + (qty - allocated), inst.qtyStep, 'round');
  for (let i = 0; i < tpQtys.length; i++) {
    if (tpQtys[i] < inst.minQty) {
      warnings.push(`TP${i + 1} slice (${tpQtys[i]}) is below min qty ${inst.minQty} — merged into TP1.`);
      tpQtys[0] = roundToStep(tpQtys[0] + tpQtys[i], inst.qtyStep, 'round');
      tpQtys[i] = 0;
    }
  }

  return { qty, riskAmt, notional, margin, slDist, tpQtys, warnings };
}

export async function POST(req: NextRequest) {
  try {
    const body: TradeRequest = await req.json();
    const {
      symbol, direction, entry, stopLoss, tp1, tp2, tp3,
      leverage, riskPct, orderType = 'Market', force = false, userLeverage,
      accountSize, marginUsdt,
      apiKey: bodyApiKey, apiSecret: bodyApiSecret, liveMode,
    } = body;

    if (!symbol || !direction || !(entry > 0) || !(stopLoss > 0) || !(riskPct > 0)) {
      return NextResponse.json({ error: 'Invalid trade request — missing symbol/direction/entry/stop/risk' }, { status: 400 });
    }
    if ((direction === 'LONG' && stopLoss >= entry) || (direction === 'SHORT' && stopLoss <= entry)) {
      return NextResponse.json({ error: `Stop ${stopLoss} is on the wrong side of entry ${entry} for a ${direction}` }, { status: 400 });
    }

    const API_KEY    = bodyApiKey    || ENV_API_KEY;
    const API_SECRET = bodyApiSecret || ENV_API_SECRET;
    const PAPER_MODE = typeof liveMode === 'boolean' ? !liveMode : ENV_API_KEY === '';

    // ── FUNDING RATE CHECK ───────────────────────────────────────────────
    if (!force) {
      const fundingRate = await fetchFundingRate(symbol);
      if (direction === 'LONG' && fundingRate > FUNDING_LONG_THRESHOLD) {
        return NextResponse.json({
          rejected: true, reason: 'FUNDING_RATE_RISK', fundingRate, threshold: FUNDING_LONG_THRESHOLD,
          message: `⚠️ Funding ${(fundingRate * 100).toFixed(4)}% > +0.10%. Longs are crowded and paying — squeeze risk. Force to override.`,
        });
      }
      if (direction === 'SHORT' && fundingRate < FUNDING_SHORT_THRESHOLD) {
        return NextResponse.json({
          rejected: true, reason: 'FUNDING_RATE_RISK', fundingRate, threshold: FUNDING_SHORT_THRESHOLD,
          message: `⚠️ Funding ${(fundingRate * 100).toFixed(4)}% < −0.10%. Shorts are crowded and paying — squeeze risk. Force to override.`,
        });
      }
    }

    // ── LEVERAGE ─────────────────────────────────────────────────────────
    let leverageWarning: string | undefined;
    if (userLeverage && leverage > userLeverage * 1.5) {
      leverageWarning = `Engine suggests ${leverage}× but your cap is ${userLeverage}×. Using ${userLeverage}×. Leverage only changes margin, never risk.`;
    }
    const effectiveLeverage = Math.max(1, userLeverage ?? leverage);

    const inst = await fetchInstrument(symbol);
    if (effectiveLeverage > inst.maxLeverage) {
      return NextResponse.json({ error: `${symbol} max leverage is ${inst.maxLeverage}× — you asked for ${effectiveLeverage}×` }, { status: 400 });
    }

    // Liquidation-before-stop guard (MMR ≈ 0.5%)
    const slDistPct = Math.abs(entry - stopLoss) / entry;
    const liqDistPct = Math.max(0, 1 / effectiveLeverage - 0.005);
    if (liqDistPct <= slDistPct) {
      const maxSafe = Math.floor(1 / (slDistPct + 0.005));
      return NextResponse.json({
        rejected: true, reason: 'LIQUIDATION_BEFORE_STOP',
        message: `🚨 At ${effectiveLeverage}× you would be liquidated (${(liqDistPct * 100).toFixed(2)}% away) before your stop (${(slDistPct * 100).toFixed(2)}% away). Max safe leverage for this stop is ${maxSafe}×.`,
      });
    }

    const pEntry = roundToStep(entry, inst.tickSize);
    const pSL    = roundToStep(stopLoss, inst.tickSize);
    const pTPs   = [tp1, tp2, tp3].map(p => roundToStep(p, inst.tickSize));

    // ── PAPER MODE ───────────────────────────────────────────────────────
    if (PAPER_MODE) {
      const balance = accountSize && accountSize > 0 ? accountSize : 2000;
      const s = sizePosition({ balance, riskPct, entry: pEntry, stopLoss: pSL, leverage: effectiveLeverage, marginOverride: marginUsdt, inst });
      const entryFee = s.notional * (orderType === 'Limit' ? MAKER_FEE : TAKER_FEE);
      const exitFee  = s.tpQtys.reduce((a, q, i) => a + q * pTPs[i] * MAKER_FEE, 0);
      const stagedGross = s.tpQtys.reduce((a, q, i) => a + q * Math.abs(pTPs[i] - pEntry), 0);
      return NextResponse.json({
        paper: true,
        message: '📄 PAPER — simulated fill, staged exits recorded',
        orderType,
        fundingChecked: !force,
        leverageWarning,
        warnings: s.warnings,
        qty: s.qty,
        balance: balance.toFixed(2),
        riskAmt: s.riskAmt.toFixed(2),
        notional: s.notional.toFixed(2),
        margin: s.margin.toFixed(2),
        plan: { entry: pEntry, stopLoss: pSL, tp1: pTPs[0], tp2: pTPs[1], tp3: pTPs[2], tpQtys: s.tpQtys, split: '50/25/25' },
        feeEstimate: {
          entryFee: entryFee.toFixed(4),
          exitFee:  exitFee.toFixed(4),
          totalFee: (entryFee + exitFee).toFixed(4),
          note: orderType === 'Limit' ? 'Limit entry saves ~0.035% vs market' : 'Market entry — consider Limit to cut fees ~0.035%',
        },
        netIfAllTargets: (stagedGross - entryFee - exitFee).toFixed(2),
        netIfStopped: (-(s.riskAmt + entryFee + s.notional * TAKER_FEE)).toFixed(2),
        simulated: { symbol, direction, entry: pEntry, stopLoss: pSL, tp1: pTPs[0], tp2: pTPs[1], tp3: pTPs[2], leverage: effectiveLeverage, riskPct },
      });
    }

    if (!API_KEY || !API_SECRET) {
      return NextResponse.json({ error: 'Bybit API keys not configured. Add them in Settings.' }, { status: 400 });
    }
    const bybitRequest = makeBybitRequest(API_KEY, API_SECRET);
    const side   = direction === 'LONG' ? 'Buy' : 'Sell';
    const tpSide = direction === 'LONG' ? 'Sell' : 'Buy';

    // ── SET LEVERAGE (110043 = already set, not an error) ────────────────
    const levRes = await bybitRequest('POST', '/v5/position/set-leverage', {
      category: 'linear', symbol, buyLeverage: String(effectiveLeverage), sellLeverage: String(effectiveLeverage),
    });
    if (levRes.retCode !== 0 && levRes.retCode !== 110043) {
      return NextResponse.json({ error: `Set leverage failed: ${levRes.retMsg}` }, { status: 400 });
    }

    // ── BALANCE ──────────────────────────────────────────────────────────
    let balance = 0;
    for (const accountType of ['UNIFIED', 'CONTRACT']) {
      const walletRes = await bybitRequest('GET', '/v5/account/wallet-balance', { accountType });
      const list = (walletRes.result as { list?: Array<{ coin?: Array<Record<string, string>> }> } | undefined)?.list ?? [];
      const usdt = list[0]?.coin?.find(c => c.coin === 'USDT');
      balance = parseFloat(usdt?.availableToWithdraw || usdt?.walletBalance || '0');
      if (balance > 0) break;
    }
    if (balance <= 0) {
      return NextResponse.json({ error: 'No USDT balance found. Check API key permissions and account funding.' }, { status: 400 });
    }

    const s = sizePosition({ balance, riskPct, entry: pEntry, stopLoss: pSL, leverage: effectiveLeverage, marginOverride: marginUsdt, inst });

    // ── ENTRY WITH FULL-SIZE STOP ATTACHED ──────────────────────────────
    const orderParams: Record<string, string | number> = {
      category: 'linear', symbol, side, orderType,
      qty: fmtStep(s.qty, inst.qtyStep),
      stopLoss: fmtStep(pSL, inst.tickSize),
      tpslMode: 'Full',
      slTriggerBy: 'LastPrice',
      slOrderType: 'Market',
      timeInForce: orderType === 'Limit' ? 'PostOnly' : 'IOC',
      positionIdx: 0,
    };
    if (orderType === 'Limit') orderParams.price = fmtStep(pEntry, inst.tickSize);

    const orderRes = await bybitRequest('POST', '/v5/order/create', orderParams);
    if (orderRes.retCode !== 0) {
      return NextResponse.json({ error: `Entry rejected by Bybit: ${orderRes.retMsg}` }, { status: 400 });
    }
    const orderId = String((orderRes.result as { orderId?: string } | undefined)?.orderId ?? '');

    // ── VERIFY POSITION + STOP (market fills only) ───────────────────────
    let filledQty = s.qty;
    let slVerified = orderType === 'Limit' ? 'pending-fill' : 'unverified';
    if (orderType === 'Market') {
      let pos: Record<string, string> | undefined;
      for (let attempt = 0; attempt < 4 && !pos; attempt++) {
        if (attempt) await new Promise(r => setTimeout(r, 400));
        const posRes = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol });
        const list = (posRes.result as { list?: Array<Record<string, string>> } | undefined)?.list ?? [];
        const found = list.find(p => parseFloat(p.size || '0') > 0);
        if (found) pos = found;
      }
      if (!pos) {
        return NextResponse.json({ error: `Order ${orderId} accepted but no position visible after 1.6s. Check Bybit — do not re-submit blindly.`, orderId }, { status: 500 });
      }
      filledQty = parseFloat(pos.size);
      const hasSL = pos.stopLoss && pos.stopLoss !== '' && parseFloat(pos.stopLoss) > 0;
      if (hasSL) {
        slVerified = 'verified';
      } else {
        const tsRes = await bybitRequest('POST', '/v5/position/trading-stop', {
          category: 'linear', symbol, positionIdx: 0, tpslMode: 'Full',
          stopLoss: fmtStep(pSL, inst.tickSize), slTriggerBy: 'LastPrice',
        });
        if (tsRes.retCode === 0) {
          slVerified = 're-attached';
        } else {
          const closeRes = await bybitRequest('POST', '/v5/order/create', {
            category: 'linear', symbol, side: tpSide, orderType: 'Market',
            qty: fmtStep(filledQty, inst.qtyStep), reduceOnly: 'true', timeInForce: 'IOC', positionIdx: 0,
          });
          return NextResponse.json({
            error: `🚨 EMERGENCY CLOSE — filled ${filledQty} but stop could not be attached (${tsRes.retMsg}). ${closeRes.retCode === 0 ? 'Position flattened at market.' : `FLATTEN FAILED: ${closeRes.retMsg} — CLOSE MANUALLY NOW.`}`,
            orderId,
          }, { status: 500 });
        }
      }
    }

    // ── STAGED REDUCE-ONLY EXITS ─────────────────────────────────────────
    const tpQtys = filledQty === s.qty ? s.tpQtys : (() => {
      const q = TP_SPLIT.map(f => roundToStep(filledQty * f, inst.qtyStep, 'floor'));
      q[0] = roundToStep(q[0] + (filledQty - q.reduce((a, b) => a + b, 0)), inst.qtyStep, 'round');
      return q;
    })();

    const tpResults = await Promise.allSettled(
      tpQtys.map((q, i) => q > 0
        ? bybitRequest('POST', '/v5/order/create', {
            category: 'linear', symbol, side: tpSide, orderType: 'Limit',
            qty: fmtStep(q, inst.qtyStep), price: fmtStep(pTPs[i], inst.tickSize),
            reduceOnly: 'true', timeInForce: 'GTC', positionIdx: 0,
            orderLinkId: `4s-tp${i + 1}-${Date.now()}`,
          })
        : Promise.resolve<BybitResp>({ retCode: 0, retMsg: 'skipped (zero qty)' }))
    );
    const tpStatus = tpResults.map((r, i) => {
      if (r.status === 'rejected') return { tp: `TP${i + 1}`, ok: false, msg: String(r.reason) };
      return { tp: `TP${i + 1}`, ok: r.value.retCode === 0, msg: r.value.retMsg, qty: tpQtys[i], price: pTPs[i] };
    });
    const failedTPs = tpStatus.filter(t => !t.ok);
    const warnings = [...s.warnings];
    if (failedTPs.length) {
      warnings.push(orderType === 'Limit'
        ? `Entry is resting (PostOnly). ${failedTPs.map(t => t.tp).join('/')} could not be placed until fill — re-place them once filled. Stop is attached to the entry order.`
        : `⚠ ${failedTPs.map(t => `${t.tp}: ${t.msg}`).join(' · ')} — position IS protected by the stop, but these targets must be placed manually.`);
    }

    const entryFee = s.notional * (orderType === 'Limit' ? MAKER_FEE : TAKER_FEE);
    const exitFee  = tpQtys.reduce((a, q, i) => a + q * pTPs[i] * MAKER_FEE, 0);

    return NextResponse.json({
      success: true,
      orderId,
      symbol, direction, qty: filledQty,
      leverage: effectiveLeverage,
      entry: pEntry, stopLoss: pSL, tp1: pTPs[0], tp2: pTPs[1], tp3: pTPs[2],
      orderType,
      fundingChecked: !force,
      leverageWarning,
      warnings,
      slVerified,
      tpStatus,
      balance: balance.toFixed(2),
      riskAmt: s.riskAmt.toFixed(2),
      notional: s.notional.toFixed(2),
      margin: s.margin.toFixed(2),
      slDist: s.slDist.toFixed(decimalsOf(inst.tickSize)),
      feeEstimate: {
        notional: s.notional.toFixed(2),
        entryFee: entryFee.toFixed(4),
        exitFee:  exitFee.toFixed(4),
        totalFee: (entryFee + exitFee).toFixed(4),
      },
      message: `✅ ${orderType} ${direction} ${filledQty} ${symbol} · stop ${slVerified} · exits ${tpStatus.filter(t => t.ok).length}/${tpStatus.length} placed`,
    });

  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
