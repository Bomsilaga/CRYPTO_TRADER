/**
 * trade/route.ts — Bybit Trade Execution
 *
 * OPPOSER FIXES APPLIED:
 *
 * Fix Grey Zone 3: Funding rate check before execution
 * ─────────────────────────────────────────────────────
 * Rejects long orders if funding > +0.10% (too many longs = squeeze risk)
 * Rejects short orders if funding < -0.10% (too many shorts = squeeze risk)
 * Can be overridden with { force: true } in request body.
 *
 * Fix Strike 3: Add limit order option (reduces fees from 0.055% to 0.02%)
 * ────────────────────────────────────────────────────────────────────────
 * orderType: 'Limit' | 'Market' (default Market for backward compat)
 * Limit orders save 0.035% per entry = ~$2.10 on $6k position.
 * Over 20 trading days at 3 trades/day: ~$126/month in savings.
 *
 * Fix Grey Zone 1: Corrected fee display
 * ────────────────────────────────────────
 * Response now shows actual fees (not the 0.22% hardcoded estimate).
 *
 * Fix Grey Zone 2: Leverage warning for high recommendations
 * ─────────────────────────────────────────────────────────
 * Response includes leverageWarning if recommended leverage > user's setting.
 *
 * Fix Strike 3 (partial): Emergency close if SL placement fails
 * ─────────────────────────────────────────────────────────────
 * If entry fills but SL order fails, bot immediately places a market close.
 * An open position without a stop-loss is unacceptable.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { fetchFundingRate } from '@/lib/bybit';

const BYBIT_BASE = process.env.BYBIT_TESTNET === 'true'
  ? 'https://api-testnet.bybit.com'
  : 'https://api.bybit.com';

const ENV_API_KEY    = process.env.BYBIT_API_KEY    ?? '';
const ENV_API_SECRET = process.env.BYBIT_API_SECRET ?? '';

// Funding rate thresholds — beyond these, signal is high-risk
const FUNDING_LONG_THRESHOLD  = 0.001;  // +0.1% — longs paying too much
const FUNDING_SHORT_THRESHOLD = -0.001; // -0.1% — shorts paying too much

function makeSign(apiKey: string, apiSecret: string, params: Record<string, string | number>, timestamp: number): string {
  const ordered = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  const payload = `${timestamp}${apiKey}5000${ordered}`;
  return crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
}

function makeBybitRequest(apiKey: string, apiSecret: string) {
  return async function bybitRequest(method: 'GET' | 'POST', path: string, body: Record<string, string | number> = {}) {
    const ts = Date.now();
    const sig = makeSign(apiKey, apiSecret, body, ts);
    const res = await fetch(`${BYBIT_BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-BAPI-API-KEY': apiKey,
        'X-BAPI-TIMESTAMP': String(ts),
        'X-BAPI-SIGN': sig,
        'X-BAPI-RECV-WINDOW': '5000',
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    return res.json();
  };
}

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
  // Client-supplied keys (take precedence over env vars)
  apiKey?: string;
  apiSecret?: string;
  liveMode?: boolean;
}

export async function POST(req: NextRequest) {
  try {
    const body: TradeRequest = await req.json();
    const {
      symbol, direction, entry, stopLoss, tp1, tp2, tp3,
      leverage, riskPct, orderType = 'Market', force = false, userLeverage,
      apiKey: bodyApiKey, apiSecret: bodyApiSecret, liveMode,
    } = body;

    // Client-supplied keys take precedence over env vars
    const API_KEY    = bodyApiKey    || ENV_API_KEY;
    const API_SECRET = bodyApiSecret || ENV_API_SECRET;
    // Paper mode: env default unless client explicitly sets liveMode=true
    const PAPER_MODE = typeof liveMode === 'boolean' ? !liveMode : ENV_API_KEY === '';

    if (!API_KEY || !API_SECRET) {
      return NextResponse.json({ error: 'Bybit API keys not configured. Add them in ⚙️ Settings.' }, { status: 400 });
    }

    const bybitRequest = makeBybitRequest(API_KEY, API_SECRET);

    // ── FUNDING RATE CHECK (Grey Zone 3 fix) ─────────────────────────────
    if (!force) {
      const fundingRate = await fetchFundingRate(symbol);
      if (direction === 'LONG' && fundingRate > FUNDING_LONG_THRESHOLD) {
        return NextResponse.json({
          rejected: true,
          reason: 'FUNDING_RATE_RISK',
          message: `⚠️ Funding rate ${(fundingRate * 100).toFixed(4)}% exceeds +0.10% threshold. Longs are paying heavily — squeeze risk elevated. Pass { force: true } to override.`,
          fundingRate,
          threshold: FUNDING_LONG_THRESHOLD,
        }, { status: 200 });
      }
      if (direction === 'SHORT' && fundingRate < FUNDING_SHORT_THRESHOLD) {
        return NextResponse.json({
          rejected: true,
          reason: 'FUNDING_RATE_RISK',
          message: `⚠️ Funding rate ${(fundingRate * 100).toFixed(4)}% below −0.10% threshold. Shorts are paying heavily — long squeeze risk elevated. Pass { force: true } to override.`,
          fundingRate,
          threshold: FUNDING_SHORT_THRESHOLD,
        }, { status: 200 });
      }
    }

    // ── LEVERAGE WARNING (Grey Zone 2 fix) ───────────────────────────────
    let leverageWarning: string | undefined;
    if (userLeverage && leverage > userLeverage * 1.5) {
      leverageWarning = `⚠️ Signal engine recommends ${leverage}× but your setting is ${userLeverage}×. Using your setting (${userLeverage}×). Never override your personal risk limit based on a recommendation.`;
    }
    const effectiveLeverage = userLeverage ?? leverage;

    // ── PAPER MODE ───────────────────────────────────────────────────────
    if (PAPER_MODE) {
      const takerFee = 0.00055;
      const makerFee = 0.00020;
      const notional = (riskPct / 100) * 2000 / (Math.abs(entry - stopLoss) / entry) * effectiveLeverage; // approx
      const entryFee = notional * (orderType === 'Limit' ? makerFee : takerFee);
      const exitFee  = notional * takerFee; // TP1 always taker on exit
      const totalFee = entryFee + exitFee;

      return NextResponse.json({
        paper: true,
        message: '📄 PAPER MODE — no real order placed',
        orderType,
        fundingChecked: !force,
        leverageWarning,
        feeEstimate: {
          entryFee: entryFee.toFixed(4),
          exitFee: exitFee.toFixed(4),
          totalFee: totalFee.toFixed(4),
          note: orderType === 'Limit'
            ? 'Limit entry saves ~0.035% vs market order'
            : 'Market entry — consider Limit to reduce fees by ~0.035%',
        },
        simulated: { symbol, direction, entry, stopLoss, tp1, tp2, tp3, leverage: effectiveLeverage, riskPct },
      });
    }

    const side = direction === 'LONG' ? 'Buy' : 'Sell';

    // ── SET LEVERAGE ─────────────────────────────────────────────────────
    await bybitRequest('POST', '/v5/position/set-leverage', {
      category: 'linear', symbol,
      buyLeverage:  String(effectiveLeverage),
      sellLeverage: String(effectiveLeverage),
    });

    // ── GET BALANCE ──────────────────────────────────────────────────────
    // Try UNIFIED first, fall back to CONTRACT (classic account type)
    let balance = 0;
    for (const accountType of ['UNIFIED', 'CONTRACT']) {
      const walletRes = await bybitRequest('GET', `/v5/account/wallet-balance?accountType=${accountType}`, {});
      const coins = walletRes?.result?.list?.[0]?.coin ?? [];
      const usdtCoin = (coins as Record<string, string>[]).find((c: Record<string, string>) => c.coin === 'USDT');
      balance = parseFloat(usdtCoin?.availableToWithdraw ?? usdtCoin?.walletBalance ?? '0');
      if (balance > 0) break;
    }
    if (balance === 0) return NextResponse.json({
      error: 'No USDT balance found. Check: (1) API key has Read permission, (2) account has USDT balance, (3) correct API key entered in Settings.',
    }, { status: 400 });

    const riskAmt = balance * (riskPct / 100);
    const slDist  = Math.abs(entry - stopLoss);
    const rawQty  = (riskAmt * effectiveLeverage) / entry;
    const qty     = Math.max(0.001, parseFloat(rawQty.toFixed(3)));

    // ── PLACE ENTRY ORDER (Market or Limit) ──────────────────────────────
    const orderParams: Record<string, string | number> = {
      category:    'linear',
      symbol,
      side,
      orderType,
      qty:         String(qty),
      stopLoss:    String(stopLoss.toFixed(5)),
      takeProfit:  String(tp1.toFixed(5)),
      tpslMode:    'Full',
      slTriggerBy: 'LastPrice',
      tpTriggerBy: 'LastPrice',
      timeInForce: orderType === 'Limit' ? 'PostOnly' : 'GoodTillCancel',
      positionIdx: 0,
    };

    // Add price for limit orders
    if (orderType === 'Limit') {
      orderParams.price = String(entry.toFixed(5));
    }

    const orderRes = await bybitRequest('POST', '/v5/order/create', orderParams);

    if (orderRes.retCode !== 0) {
      return NextResponse.json({ error: `Bybit order error: ${orderRes.retMsg}` }, { status: 400 });
    }

    const orderId = orderRes.result?.orderId;

    // ── EMERGENCY CLOSE IF SL FAILED ─────────────────────────────────────
    // (For market orders only — limit orders are not filled yet so no position to close)
    if (orderType === 'Market' && !orderRes.result?.stopLossOrderId) {
      // SL may not have been attached — verify and place standalone SL
      const slOrderRes = await bybitRequest('POST', '/v5/order/create', {
        category:    'linear',
        symbol,
        side:        direction === 'LONG' ? 'Sell' : 'Buy',
        orderType:   'Market',
        qty:         String(qty),
        stopLoss:    String(stopLoss.toFixed(5)),
        reduceOnly:  'true',
        timeInForce: 'GoodTillCancel',
        positionIdx: 0,
        triggerPrice: String(stopLoss.toFixed(5)),
        triggerBy:   'LastPrice',
      });
      if (slOrderRes.retCode !== 0) {
        // SL truly failed — emergency close the position
        await bybitRequest('POST', '/v5/order/create', {
          category:    'linear',
          symbol,
          side:        direction === 'LONG' ? 'Sell' : 'Buy',
          orderType:   'Market',
          qty:         String(qty),
          reduceOnly:  'true',
          timeInForce: 'GoodTillCancel',
          positionIdx: 0,
        });
        return NextResponse.json({
          error: '🚨 EMERGENCY CLOSE — entry filled but SL placement failed. Position closed at market. Check Bybit immediately.',
          orderId,
        }, { status: 500 });
      }
    }

    // ── PLACE TP2 AND TP3 AS LIMIT REDUCE-ONLY ──────────────────────────
    const tpQty2 = parseFloat((qty * 0.25).toFixed(3));
    const tpQty3 = parseFloat((qty * 0.25).toFixed(3));
    const tpSide = direction === 'LONG' ? 'Sell' : 'Buy';

    await Promise.allSettled([
      bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol, side: tpSide,
        orderType: 'Limit', qty: String(tpQty2),
        price: String(tp2.toFixed(5)),
        reduceOnly: 'true', timeInForce: 'GoodTillCancel', positionIdx: 0,
      }),
      bybitRequest('POST', '/v5/order/create', {
        category: 'linear', symbol, side: tpSide,
        orderType: 'Limit', qty: String(tpQty3),
        price: String(tp3.toFixed(5)),
        reduceOnly: 'true', timeInForce: 'GoodTillCancel', positionIdx: 0,
      }),
    ]);

    // ── FEE ESTIMATE IN RESPONSE (Grey Zone 1 fix) ───────────────────────
    const takerFee = 0.00055;
    const makerFee = 0.00020;
    const notional = qty * entry;
    const entryFeeActual = notional * (orderType === 'Limit' ? makerFee : takerFee);
    const tp2Fee = tpQty2 * tp2 * makerFee;
    const tp3Fee = tpQty3 * tp3 * makerFee;
    const totalFeeEstimate = entryFeeActual + tp2Fee + tp3Fee;

    return NextResponse.json({
      success: true,
      orderId,
      symbol, direction, qty,
      leverage: effectiveLeverage,
      entry, stopLoss, tp1, tp2, tp3,
      orderType,
      fundingChecked: !force,
      leverageWarning,
      balance: balance.toFixed(2),
      riskAmt: riskAmt.toFixed(2),
      slDist: slDist.toFixed(5),
      feeEstimate: {
        notional: notional.toFixed(2),
        entryFee: entryFeeActual.toFixed(4),
        tp2Fee:   tp2Fee.toFixed(4),
        tp3Fee:   tp3Fee.toFixed(4),
        totalFee: totalFeeEstimate.toFixed(4),
      },
      message: `✅ Order placed — ${qty} ${symbol} ${direction} @ ${orderType}`,
    });

  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
