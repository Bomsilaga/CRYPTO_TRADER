import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../src/lib/bybitPrivate', async (orig) => {
  const mod = await orig() as Record<string, unknown>;
  return { ...mod, fetchInstrument: vi.fn(async () => ({ tickSize: 0.0001, qtyStep: 1, minQty: 1, maxQty: 1e9, maxLeverage: 50 })) };
});
vi.mock('../src/lib/bybit', () => ({ fetchFundingRate: vi.fn(async () => 0) }));

import { POST } from '../src/app/api/trade/route';

const body = (o: Record<string, unknown> = {}) => ({ tradeId: 'trade-0001', symbol: 'EIGENUSDT', direction: 'LONG', entry: 0.21, stopLoss: 0.208, tp1: 0.214, tp2: 0.218, tp3: 0.223, leverage: 3, riskPct: 1, orderType: 'Limit', accountSize: 5000, liveMode: true, ...o });
const req = (b: Record<string, unknown>, headers: Record<string, string> = {}) => new NextRequest('http://localhost/api/trade', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json', ...headers } });

describe('/api/trade', () => {
  beforeEach(() => { delete process.env.TRADING_MODE; delete process.env.TRADE_AUTH_TOKEN; delete process.env.SUPABASE_SERVICE_ROLE_KEY; });

  it('executes PAPER when the client asks for live but the server is not in live mode', async () => {
    const res = await POST(req(body({ tradeId: 'paper-000001' })));
    const j = await res.json();
    expect(j.paper).toBe(true);
    expect(j.mode).toBe('paper');
    expect(j.liveRefusedBecause.join()).toMatch(/TRADING_MODE/);
    expect(j.qty).toBeCloseTo(25000, 0);                      // $50 / 0.002
    expect(Number(j.riskAmt)).toBeCloseTo(50, 0);
    expect(j.plan.tpQtys).toEqual([12500, 6250, 6250]);
  });
  it('is idempotent — replaying the same tradeId returns the stored result and does not re-execute', async () => {
    const a = await (await POST(req(body({ tradeId: 'idem-000001' })))).json();
    const b = await (await POST(req(body({ tradeId: 'idem-000001', riskPct: 0.5 })))).json();
    expect(b.idempotent).toBe(true);
    expect(b.qty).toBe(a.qty);
  });
  it('hard-rejects risk above the limit and leverage above the cap, even with force', async () => {
    const r1 = await (await POST(req(body({ tradeId: 'hard-000001', riskPct: 3, force: true })))).json();
    expect(r1.rejected).toBe(true); expect(r1.hard).toBe(true); expect(r1.rejections.join()).toMatch(/Risk 3%/);
    const r2 = await (await POST(req(body({ tradeId: 'hard-000002', leverage: 20, force: true })))).json();
    expect(r2.hard).toBe(true); expect(r2.rejections.join()).toMatch(/Leverage 20/);
  });
  it('requires a tradeId and rejects a stop on the wrong side', async () => {
    expect((await POST(req(body({ tradeId: undefined })))).status).toBe(400);
    expect((await POST(req(body({ tradeId: 'bad-side-01', stopLoss: 0.22 })))).status).toBe(400);
  });
  it('refuses live without a durable KV even when everything else is set', async () => {
    process.env.TRADING_MODE = 'live'; process.env.TRADE_AUTH_TOKEN = 'a-very-long-execution-token-123';
    const j = await (await POST(req(body({ tradeId: 'live-000001' }), { 'x-4scans-auth': 'a-very-long-execution-token-123' }))).json();
    expect(j.mode).toBe('paper');
    expect(j.liveRefusedBecause.join()).toMatch(/durable KV/);
  });
});
