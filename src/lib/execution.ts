/**
 * execution.ts — exchange-side execution primitives with verification.
 * Pure functions take a BybitClient so they can be unit-tested with a fake.
 */
import { fmtStep, roundToStep, type BybitClient, type Instrument, type PositionInfo } from './bybitPrivate';

export type TradeState = 'ENTRY_PENDING' | 'ENTRY_PARTIAL' | 'ENTRY_FILLED' | 'PROTECTION_PENDING' | 'SL_CONFIRMED' | 'TPS_CONFIRMED' | 'MANAGED' | 'CLOSED' | 'EMERGENCY_CLOSED';

export interface TradeRecord {
  tradeId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  orderType: 'Market' | 'Limit';
  state: TradeState;
  intended: { entry: number; stopLoss: number; tp1: number; tp2: number; tp3: number; qty: number; riskUsd: number; leverage: number };
  actual?: { qty: number; avgPrice: number; fees: number; stopDistancePct: number; riskUsd: number; riskVsTargetPct: number; liqPrice: number | null; liqDistancePct: number | null; stopToLiqPct: number | null };
  orderId?: string;
  tpOrders?: { tp: string; orderId?: string; qty: number; price: number; ok: boolean; msg?: string }[];
  slVerified?: 'verified' | 're-attached' | 'failed' | 'pending-fill';
  events: { at: string; msg: string }[];
  inst: Instrument;
  createdAt: string;
  updatedAt: string;
}

export const TP_SPLIT = [0.5, 0.25, 0.25] as const;

export function splitQty(qty: number, inst: Instrument): number[] {
  const q = TP_SPLIT.map(f => roundToStep(qty * f, inst.qtyStep, 'floor'));
  q[0] = roundToStep(q[0] + (qty - q.reduce((a, b) => a + b, 0)), inst.qtyStep, 'round');
  for (let i = 1; i < q.length; i++) if (q[i] > 0 && q[i] < inst.minQty) { q[0] = roundToStep(q[0] + q[i], inst.qtyStep, 'round'); q[i] = 0; }
  return q;
}

export function log(rec: TradeRecord, msg: string) { rec.events.push({ at: new Date().toISOString(), msg }); rec.updatedAt = new Date().toISOString(); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function readPosition(client: BybitClient, symbol: string, attempts = 4, waitMs = 400): Promise<PositionInfo | null> {
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(waitMs);
    const p = (await client.positions(symbol))[0];
    if (p) return p;
  }
  return null;
}

/** Verify the stop on the live position; re-attach once; emergency close on failure. */
export async function verifyStop(client: BybitClient, rec: TradeRecord, intendedStop: number, tolerancePct = 0.2): Promise<'verified' | 're-attached' | 'failed'> {
  const within = (p: PositionInfo | null) => !!p && p.stopLoss !== null && Math.abs(p.stopLoss - intendedStop) / intendedStop * 100 <= tolerancePct && p.size > 0;
  let pos = await readPosition(client, rec.symbol, 2, 300);
  if (within(pos)) { log(rec, `stop verified at ${pos!.stopLoss}`); return 'verified'; }
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await client.tradingStop(rec.symbol, fmtStep(intendedStop, rec.inst.tickSize), 'MarkPrice');
    log(rec, `trading-stop attempt ${attempt + 1}: ${r.retCode === 0 ? 'ok' : r.retMsg}`);
    pos = await readPosition(client, rec.symbol, 3, 300);
    if (within(pos)) { log(rec, `stop re-attached and verified at ${pos!.stopLoss}`); return 're-attached'; }
  }
  await emergencyClose(client, rec, 'stop could not be verified');
  return 'failed';
}

export async function emergencyClose(client: BybitClient, rec: TradeRecord, why: string) {
  const pos = await readPosition(client, rec.symbol, 1);
  if (!pos) { log(rec, `emergency close requested (${why}) but no position found`); rec.state = 'CLOSED'; return; }
  const r = await client.createOrder({ symbol: rec.symbol, side: pos.side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Market', qty: fmtStep(pos.size, rec.inst.qtyStep), reduceOnly: 'true', timeInForce: 'IOC' });
  log(rec, `EMERGENCY CLOSE (${why}): ${r.retCode === 0 ? 'flattened' : `FAILED ${r.retMsg} — CLOSE MANUALLY`}`);
  rec.state = 'EMERGENCY_CLOSED';
}

/** Cancel any of our TP orders and place fresh reduce-only limits for the filled quantity. */
export async function placeStagedTPs(client: BybitClient, rec: TradeRecord, filledQty: number) {
  const tpSide = rec.direction === 'LONG' ? 'Sell' : 'Buy';
  const existing = await client.openOrders(rec.symbol).catch(() => []);
  for (const o of existing) if (o.orderLinkId.startsWith(`4s-${rec.tradeId}-tp`)) await client.cancelOrder(rec.symbol, o.orderId).catch(() => {});
  const qtys = splitQty(filledQty, rec.inst);
  const prices = [rec.intended.tp1, rec.intended.tp2, rec.intended.tp3];
  const results = await Promise.allSettled(qtys.map((q, i) => q > 0
    ? client.createOrder({ symbol: rec.symbol, side: tpSide, orderType: 'Limit', qty: fmtStep(q, rec.inst.qtyStep), price: fmtStep(prices[i], rec.inst.tickSize), reduceOnly: 'true', timeInForce: 'GTC', orderLinkId: `4s-${rec.tradeId}-tp${i + 1}` })
    : Promise.resolve({ retCode: 0, retMsg: 'skipped (zero qty)', result: {} as { orderId?: string } })));
  rec.tpOrders = results.map((r, i) => r.status === 'rejected'
    ? { tp: `TP${i + 1}`, qty: qtys[i], price: prices[i], ok: false, msg: String(r.reason) }
    : { tp: `TP${i + 1}`, qty: qtys[i], price: prices[i], ok: r.value.retCode === 0, msg: r.value.retMsg, orderId: r.value.result?.orderId });
  const failed = rec.tpOrders.filter(t => !t.ok && t.qty > 0);
  log(rec, `staged TPs placed: ${rec.tpOrders.filter(t => t.ok).length}/${rec.tpOrders.length}${failed.length ? ` (failed: ${failed.map(f => `${f.tp}: ${f.msg}`).join('; ')})` : ''}`);
  return failed.length === 0;
}

/** After a fill: recompute true risk from the actual average price; trim or close if slippage blew the risk budget. */
export async function reconcileFill(client: BybitClient, rec: TradeRecord, pos: PositionInfo, opts: { maxRiskOverrunPct?: number; closeOverrunPct?: number } = {}) {
  const maxOver = opts.maxRiskOverrunPct ?? 15, closeOver = opts.closeOverrunPct ?? 50;
  const stopDist = Math.abs(pos.avgPrice - rec.intended.stopLoss);
  const stopDistancePct = stopDist / pos.avgPrice;
  const riskUsd = pos.size * stopDist;
  const overrun = rec.intended.riskUsd > 0 ? (riskUsd / rec.intended.riskUsd - 1) * 100 : 0;
  const liqDistancePct = pos.liqPrice ? Math.abs(pos.avgPrice - pos.liqPrice) / pos.avgPrice : null;
  rec.actual = {
    qty: pos.size, avgPrice: pos.avgPrice, fees: 0, stopDistancePct, riskUsd, riskVsTargetPct: overrun,
    liqPrice: pos.liqPrice, liqDistancePct: liqDistancePct === null ? null : liqDistancePct * 100,
    stopToLiqPct: liqDistancePct === null ? null : (liqDistancePct - stopDistancePct) * 100,
  };
  log(rec, `fill reconciled: qty ${pos.size} @ ${pos.avgPrice}, true risk $${riskUsd.toFixed(2)} (${overrun >= 0 ? '+' : ''}${overrun.toFixed(1)}% vs target), liq ${pos.liqPrice ?? 'n/a'}`);
  if (overrun > closeOver) { await emergencyClose(client, rec, `true risk ${overrun.toFixed(0)}% over target`); return pos.size; }
  if (overrun > maxOver) {
    const targetQty = roundToStep(rec.intended.riskUsd / stopDist, rec.inst.qtyStep, 'floor');
    const excess = roundToStep(pos.size - targetQty, rec.inst.qtyStep, 'floor');
    if (excess >= rec.inst.minQty) {
      const r = await client.createOrder({ symbol: rec.symbol, side: pos.side === 'Buy' ? 'Sell' : 'Buy', orderType: 'Market', qty: fmtStep(excess, rec.inst.qtyStep), reduceOnly: 'true', timeInForce: 'IOC' });
      log(rec, `risk overrun ${overrun.toFixed(1)}% → trimmed ${excess} (${r.retCode === 0 ? 'ok' : r.retMsg})`);
      const after = await readPosition(client, rec.symbol, 3, 300);
      if (after) { rec.actual.qty = after.size; rec.actual.riskUsd = after.size * stopDist; rec.actual.riskVsTargetPct = (rec.actual.riskUsd / rec.intended.riskUsd - 1) * 100; return after.size; }
    }
  }
  return pos.size;
}

/** Drive a limit-entry trade through its state machine. Safe to call repeatedly. */
export async function manageTrade(client: BybitClient, rec: TradeRecord): Promise<TradeRecord> {
  if (['MANAGED', 'CLOSED', 'EMERGENCY_CLOSED'].includes(rec.state)) return rec;
  if (!rec.orderId) { rec.state = 'CLOSED'; log(rec, 'no order id'); return rec; }
  const order = await client.getOrder(rec.symbol, rec.orderId);
  if (!order) { log(rec, 'order not found on exchange'); return rec; }
  const filled = order.cumExecQty;
  if (['Cancelled', 'Rejected', 'Deactivated'].includes(order.orderStatus) && filled <= 0) { rec.state = 'CLOSED'; log(rec, `entry ${order.orderStatus.toLowerCase()} without fill`); return rec; }
  if (filled <= 0) { rec.state = 'ENTRY_PENDING'; return rec; }
  rec.state = order.orderStatus === 'Filled' ? 'ENTRY_FILLED' : 'ENTRY_PARTIAL';
  const pos = await readPosition(client, rec.symbol, 3, 300);
  if (!pos) { log(rec, 'fill reported but no position visible yet'); return rec; }
  rec.state = 'PROTECTION_PENDING';
  await reconcileFill(client, rec, pos);
  if ((rec.state as TradeState) === 'EMERGENCY_CLOSED') return rec;
  const sl = await verifyStop(client, rec, rec.intended.stopLoss);
  rec.slVerified = sl;
  if (sl === 'failed') return rec;
  rec.state = 'SL_CONFIRMED';
  const tpsOk = await placeStagedTPs(client, rec, rec.actual?.qty ?? pos.size);
  if (tpsOk) rec.state = 'TPS_CONFIRMED';
  rec.state = order.orderStatus === 'Filled' ? 'MANAGED' : 'ENTRY_PARTIAL';
  if (order.orderStatus !== 'Filled') log(rec, 'partial fill protected; will re-run on next manage call');
  return rec;
}
