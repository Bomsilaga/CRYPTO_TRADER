/**
 * bybitPrivate.ts — authenticated Bybit V5 client (server only).
 * V5 signing: sign = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + payload)
 * where payload is the JSON body for POST and the query string for GET.
 */
import crypto from 'crypto';

const BASE = () => process.env.BYBIT_TESTNET === 'true' ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
export type BybitResp<T = Record<string, unknown>> = { retCode: number; retMsg: string; result?: T };
export type Params = Record<string, string | number>;

export interface Instrument { tickSize: number; qtyStep: number; minQty: number; maxQty: number; maxLeverage: number }
export interface PositionInfo { size: number; avgPrice: number; stopLoss: number | null; liqPrice: number | null; side: 'Buy' | 'Sell' | 'None'; leverage: number; unrealisedPnl: number; markPrice: number | null; symbol: string }
export interface OrderInfo { orderId: string; orderStatus: string; cumExecQty: number; avgPrice: number; qty: number; cumExecFee: number; orderLinkId: string }

export const decimalsOf = (step: number) => { const s = step.toString(); if (s.includes('e-')) return parseInt(s.split('e-')[1], 10); return s.includes('.') ? s.split('.')[1].length : 0; };
export const roundToStep = (v: number, step: number, mode: 'floor' | 'round' = 'round') => { const d = decimalsOf(step); const n = mode === 'floor' ? Math.floor(v / step + 1e-9) : Math.round(v / step); return parseFloat((n * step).toFixed(d)); };
export const fmtStep = (v: number, step: number) => v.toFixed(decimalsOf(step));

export type FetchLike = typeof fetch;

export function makeBybitClient(apiKey: string, apiSecret: string, fetchImpl: FetchLike = fetch) {
  async function request<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, params: Params = {}): Promise<BybitResp<T>> {
    const ts = Date.now();
    const qs = Object.keys(params).sort().map(k => `${k}=${encodeURIComponent(String(params[k]))}`).join('&');
    const payload = method === 'GET' ? qs : JSON.stringify(params);
    const sign = crypto.createHmac('sha256', apiSecret).update(`${ts}${apiKey}5000${payload}`).digest('hex');
    const res = await fetchImpl(`${BASE()}${path}${method === 'GET' && qs ? `?${qs}` : ''}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': apiKey, 'X-BAPI-TIMESTAMP': String(ts), 'X-BAPI-SIGN': sign, 'X-BAPI-RECV-WINDOW': '5000' },
      body: method === 'POST' ? payload : undefined,
      cache: 'no-store',
    });
    const text = await res.text();
    if (!text) throw new Error(`Bybit empty response (HTTP ${res.status})`);
    try { return JSON.parse(text) as BybitResp<T>; } catch { throw new Error(`Bybit bad JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
  }

  return {
    request,
    async setLeverage(symbol: string, lev: number) {
      const r = await request('POST', '/v5/position/set-leverage', { category: 'linear', symbol, buyLeverage: String(lev), sellLeverage: String(lev) });
      if (r.retCode !== 0 && r.retCode !== 110043) throw new Error(`set-leverage: ${r.retMsg}`);
    },
    async walletBalance(): Promise<{ equity: number; available: number }> {
      for (const accountType of ['UNIFIED', 'CONTRACT']) {
        const r = await request<{ list?: { totalEquity?: string; coin?: Record<string, string>[] }[] }>('GET', '/v5/account/wallet-balance', { accountType });
        const acct = r.result?.list?.[0];
        const usdt = acct?.coin?.find(c => c.coin === 'USDT');
        const available = parseFloat(usdt?.availableToWithdraw || usdt?.walletBalance || '0');
        const equity = parseFloat(acct?.totalEquity || usdt?.equity || usdt?.walletBalance || '0') || available;
        if (available > 0 || equity > 0) return { equity, available };
      }
      return { equity: 0, available: 0 };
    },
    async positions(symbol?: string): Promise<PositionInfo[]> {
      const r = await request<{ list?: Record<string, string>[] }>('GET', '/v5/position/list', symbol ? { category: 'linear', symbol } : { category: 'linear', settleCoin: 'USDT' });
      return (r.result?.list ?? []).filter(p => parseFloat(p.size || '0') > 0).map(p => ({
        symbol: p.symbol, size: parseFloat(p.size), avgPrice: parseFloat(p.avgPrice), side: (p.side as PositionInfo['side']) ?? 'None',
        stopLoss: p.stopLoss && parseFloat(p.stopLoss) > 0 ? parseFloat(p.stopLoss) : null,
        liqPrice: p.liqPrice && parseFloat(p.liqPrice) > 0 ? parseFloat(p.liqPrice) : null,
        leverage: parseFloat(p.leverage || '0'), unrealisedPnl: parseFloat(p.unrealisedPnl || '0'),
        markPrice: p.markPrice ? parseFloat(p.markPrice) : null,
      }));
    },
    async createOrder(params: Params) { return request<{ orderId?: string; orderLinkId?: string }>('POST', '/v5/order/create', { category: 'linear', positionIdx: 0, ...params }); },
    async cancelOrder(symbol: string, orderId: string) { return request('POST', '/v5/order/cancel', { category: 'linear', symbol, orderId }); },
    async openOrders(symbol: string): Promise<OrderInfo[]> {
      const r = await request<{ list?: Record<string, string>[] }>('GET', '/v5/order/realtime', { category: 'linear', symbol });
      return (r.result?.list ?? []).map(o => ({ orderId: o.orderId, orderStatus: o.orderStatus, cumExecQty: parseFloat(o.cumExecQty || '0'), avgPrice: parseFloat(o.avgPrice || '0'), qty: parseFloat(o.qty || '0'), cumExecFee: parseFloat(o.cumExecFee || '0'), orderLinkId: o.orderLinkId ?? '' }));
    },
    async getOrder(symbol: string, orderId: string): Promise<OrderInfo | null> {
      for (const path of ['/v5/order/realtime', '/v5/order/history']) {
        const r = await request<{ list?: Record<string, string>[] }>('GET', path, { category: 'linear', symbol, orderId });
        const o = r.result?.list?.[0];
        if (o) return { orderId: o.orderId, orderStatus: o.orderStatus, cumExecQty: parseFloat(o.cumExecQty || '0'), avgPrice: parseFloat(o.avgPrice || '0'), qty: parseFloat(o.qty || '0'), cumExecFee: parseFloat(o.cumExecFee || '0'), orderLinkId: o.orderLinkId ?? '' };
      }
      return null;
    },
    async tradingStop(symbol: string, stopLoss: string, triggerBy: 'MarkPrice' | 'LastPrice' = 'MarkPrice') {
      return request('POST', '/v5/position/trading-stop', { category: 'linear', symbol, positionIdx: 0, tpslMode: 'Full', stopLoss, slTriggerBy: triggerBy });
    },
    async closedPnlSince(startTime: number): Promise<{ count: number; pnl: number }> {
      const r = await request<{ list?: Record<string, string>[] }>('GET', '/v5/position/closed-pnl', { category: 'linear', startTime, limit: 100 });
      const list = r.result?.list ?? [];
      return { count: list.length, pnl: list.reduce((a, x) => a + parseFloat(x.closedPnl || '0'), 0) };
    },
  };
}
export type BybitClient = ReturnType<typeof makeBybitClient>;

export async function fetchInstrument(symbol: string, fetchImpl: FetchLike = fetch): Promise<Instrument> {
  const base = process.env.BYBIT_PROXY_URL?.replace(/\/$/, '') || BASE();
  const res = await fetchImpl(`${base}/v5/market/instruments-info?category=linear&symbol=${symbol}`, { cache: 'no-store' });
  const json = await res.json() as { result?: { list?: Array<{ priceFilter: { tickSize: string }; lotSizeFilter: { qtyStep: string; minOrderQty: string; maxOrderQty: string }; leverageFilter: { maxLeverage: string } }> } };
  const inst = json.result?.list?.[0];
  if (!inst) throw new Error(`Instrument ${symbol} not found on Bybit linear`);
  return { tickSize: parseFloat(inst.priceFilter.tickSize), qtyStep: parseFloat(inst.lotSizeFilter.qtyStep), minQty: parseFloat(inst.lotSizeFilter.minOrderQty), maxQty: parseFloat(inst.lotSizeFilter.maxOrderQty), maxLeverage: parseFloat(inst.leverageFilter.maxLeverage) };
}
