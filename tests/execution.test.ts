import { describe, it, expect } from 'vitest';
import { MemoryKV } from '../src/lib/kv';
import { verifyStop, reconcileFill, manageTrade, splitQty, type TradeRecord } from '../src/lib/execution';
import { fakeClient, INST } from './fixtures';
import type { PositionInfo } from '../src/lib/bybitPrivate';

const pos = (o: Partial<PositionInfo> = {}): PositionInfo => ({ symbol: 'EIGENUSDT', size: 25000, avgPrice: 0.21, stopLoss: 0.208, liqPrice: 0.15, side: 'Buy', leverage: 3, unrealisedPnl: 0, markPrice: 0.21, ...o });
const rec = (o: Partial<TradeRecord> = {}): TradeRecord => ({
  tradeId: 'abc12345', symbol: 'EIGENUSDT', direction: 'LONG', orderType: 'Market', state: 'PROTECTION_PENDING',
  intended: { entry: 0.21, stopLoss: 0.208, tp1: 0.214, tp2: 0.218, tp3: 0.223, qty: 25000, riskUsd: 50, leverage: 3 },
  events: [], inst: INST, createdAt: '', updatedAt: '', ...o,
});

describe('idempotent execution', () => {
  it('second claim of the same tradeId is refused and the stored result is returned', async () => {
    const kv = new MemoryKV();
    expect(await kv.claim('trade:x', { status: 'pending' })).toBe(true);
    expect(await kv.claim('trade:x', { status: 'pending' })).toBe(false);
    await kv.set('trade:x', { status: 'done', result: { orderId: '1' } });
    expect(await kv.get('trade:x')).toEqual({ status: 'done', result: { orderId: '1' } });
  });
});

describe('stop verification', () => {
  it('verifies an attached stop without re-attaching', async () => {
    const c = fakeClient({ positions: [[pos()]] });
    expect(await verifyStop(c, rec(), 0.208)).toBe('verified');
    expect(c.calls.some(x => x.m === 'tradingStop')).toBe(false);
  });
  it('re-attaches when the stop is missing, then verifies', async () => {
    const c = fakeClient({ positions: [[pos({ stopLoss: null })], [pos({ stopLoss: null })], [pos()]] });
    expect(await verifyStop(c, rec(), 0.208)).toBe('re-attached');
  });
  it('emergency-closes when the stop cannot be verified after retries', async () => {
    const c = fakeClient({ positions: [[pos({ stopLoss: null })]], tradingStopOk: false });
    const r = rec();
    expect(await verifyStop(c, r, 0.208)).toBe('failed');
    expect(r.state).toBe('EMERGENCY_CLOSED');
    const close = c.calls.find(x => x.m === 'createOrder' && (x.p as Record<string, string>).reduceOnly === 'true');
    expect(close).toBeTruthy();
    expect((close!.p as Record<string, string>).side).toBe('Sell');
  });
  it('treats a wrong stop price as unverified', async () => {
    const c = fakeClient({ positions: [[pos({ stopLoss: 0.19 })], [pos({ stopLoss: 0.19 })], [pos({ stopLoss: 0.19 })]], tradingStopOk: false });
    expect(await verifyStop(c, rec(), 0.208)).toBe('failed');
  });
});

describe('fill reconciliation', () => {
  it('trims size when slippage pushes true risk >15% over target', async () => {
    const c = fakeClient({ positions: [[pos({ avgPrice: 0.2106, size: 25000 })]] });
    const r = rec();
    await reconcileFill(c, r, pos({ avgPrice: 0.2106, size: 25000 }));
    expect(r.actual!.riskVsTargetPct).toBeGreaterThan(15);
    const trim = c.calls.find(x => x.m === 'createOrder');
    expect(trim).toBeTruthy();
    expect(Number((trim!.p as Record<string, string>).qty)).toBeGreaterThan(0);
  });
  it('emergency-closes when true risk is >50% over target', async () => {
    const c = fakeClient({ positions: [[pos()]] });
    const r = rec();
    await reconcileFill(c, r, pos({ avgPrice: 0.2115, size: 25000 }));
    expect(r.state).toBe('EMERGENCY_CLOSED');
  });
  it('records exchange liquidation distance and stop-to-liq buffer', async () => {
    const c = fakeClient({ positions: [[pos()]] });
    const r = rec();
    await reconcileFill(c, r, pos());
    expect(r.actual!.liqPrice).toBe(0.15);
    expect(r.actual!.liqDistancePct).toBeCloseTo((0.06 / 0.21) * 100, 6);
    expect(r.actual!.stopToLiqPct!).toBeGreaterThan(0);
  });
});

describe('limit entry state machine', () => {
  it('stays pending with no fill, protects a partial fill and re-runs, completes on full fill', async () => {
    const o = { orderId: 'o1', orderStatus: 'New', cumExecQty: 0, avgPrice: 0, qty: 25000, cumExecFee: 0, orderLinkId: '' };
    const c0 = fakeClient({ orders: { o1: o } });
    const r = rec({ orderType: 'Limit', state: 'ENTRY_PENDING', orderId: 'o1' });
    expect((await manageTrade(c0, r)).state).toBe('ENTRY_PENDING');

    const partial = { ...o, orderStatus: 'PartiallyFilled', cumExecQty: 10000, avgPrice: 0.21 };
    const c1 = fakeClient({ orders: { o1: partial }, positions: [[pos({ size: 10000 })]] });
    const r1 = await manageTrade(c1, rec({ orderType: 'Limit', state: 'ENTRY_PENDING', orderId: 'o1' }));
    expect(r1.state).toBe('ENTRY_PARTIAL');
    expect(r1.slVerified).toBe('verified');
    expect(r1.tpOrders!.filter(t => t.ok).length).toBe(3);
    expect(r1.tpOrders!.reduce((a, t) => a + t.qty, 0)).toBeCloseTo(10000, 6);

    const full = { ...o, orderStatus: 'Filled', cumExecQty: 25000, avgPrice: 0.21 };
    const c2 = fakeClient({ orders: { o1: full }, positions: [[pos()]] });
    const r2 = await manageTrade(c2, r1);
    expect(r2.state).toBe('MANAGED');
    expect(r2.tpOrders!.reduce((a, t) => a + t.qty, 0)).toBeCloseTo(25000, 6);
  });
  it('closes the record when the entry is cancelled without a fill', async () => {
    const c = fakeClient({ orders: { o1: { orderId: 'o1', orderStatus: 'Cancelled', cumExecQty: 0, avgPrice: 0, qty: 1, cumExecFee: 0, orderLinkId: '' } } });
    expect((await manageTrade(c, rec({ orderType: 'Limit', state: 'ENTRY_PENDING', orderId: 'o1' }))).state).toBe('CLOSED');
  });
  it('splits 50/25/25 on the exchange step and folds sub-minimum slices into TP1', () => {
    expect(splitQty(1, INST)).toEqual([0.5, 0.25, 0.25]);
    const tiny = splitQty(0.003, { ...INST, qtyStep: 0.001, minQty: 0.001 });
    expect(tiny.reduce((a, b) => a + b, 0)).toBeCloseTo(0.003, 9);
    const coarse = splitQty(0.003, { ...INST, qtyStep: 0.001, minQty: 0.002 });
    expect(coarse[0]).toBeCloseTo(0.003, 9); expect(coarse[1]).toBe(0); expect(coarse[2]).toBe(0);
  });
});
