import { describe, it, expect } from 'vitest';
import { okxFetchKlinesRange, okxFetchFundingRange, toOkxInst } from '../src/lib/history/okxHistory';
import { btcRelation } from '../src/lib/history/stats';
import { synthCandles } from './fixtures';
import { resample } from '../src/lib/history/resample';

const H = 3_600_000;

/** Fake OKX: newest-first pages of 100 with ts < after. Prices are per-coin (multiplier pairs scale). */
function fakeOkx(all: { time: number; open: number; high: number; low: number; close: number; volume: number }[]) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const after = Number(u.searchParams.get('after')), limit = Number(u.searchParams.get('limit') ?? 100);
    const data = all.filter(c => c.time < after).sort((a, b) => b.time - a.time).slice(0, limit)
      .map(c => [String(c.time), String(c.open), String(c.high), String(c.low), String(c.close), '1', String(c.volume), String(c.volume * c.close), '1']);
    return { status: 200, ok: true, text: async () => JSON.stringify({ code: '0', data }) };
  };
  return { fetchImpl, calls };
}

describe('OKX fallback source', () => {
  it('maps Bybit symbols to OKX swaps and scales multiplier pairs', () => {
    expect(toOkxInst('EIGENUSDT')).toEqual({ instId: 'EIGEN-USDT-SWAP', mult: 1 });
    expect(toOkxInst('1000PEPEUSDT')).toEqual({ instId: 'PEPE-USDT-SWAP', mult: 1000 });
    expect(() => toOkxInst('EIGENBTC')).toThrow();
  });
  it('pages backwards in 100s, de-duplicates, returns ascending, applies price multiplier', async () => {
    const all = synthCandles({ n: 350, tf: '1h', seed: 9, price: 0.00001 });
    const { fetchImpl, calls } = fakeOkx(all);
    const got = await okxFetchKlinesRange('1000PEPEUSDT', '1h', all[0].time, all[all.length - 1].time, { fetchImpl });
    expect(got).toHaveLength(350);
    expect(calls.length).toBe(4);
    for (let i = 1; i < got.length; i++) expect(got[i].time).toBeGreaterThan(got[i - 1].time);
    expect(got[0].close).toBeCloseTo(all[0].close * 1000, 12);
    expect(got[0].volume).toBeCloseTo(all[0].volume / 1000, 12);
  });
  it('funding pagination', async () => {
    const pts = Array.from({ length: 230 }, (_, i) => ({ t: i * 8 * H, r: 0.0002 }));
    const fetchImpl = async (url: string) => {
      const u = new URL(url); const after = Number(u.searchParams.get('after'));
      const data = pts.filter(p => p.t < after).sort((a, b) => b.t - a.t).slice(0, 100).map(p => ({ fundingRate: String(p.r), fundingTime: String(p.t) }));
      return { status: 200, ok: true, text: async () => JSON.stringify({ code: '0', data }) };
    };
    const got = await okxFetchFundingRange('EIGENUSDT', 0, 229 * 8 * H, { fetchImpl });
    expect(got).toHaveLength(230);
  });
});

describe('BTC coupling (measured, not assumed)', () => {
  it('reports TIGHT coupling for a pair that is a scaled copy of BTC, and LOOSE for an independent walk', () => {
    const btc15 = synthCandles({ n: 4 * 24 * 200, tf: '15m', seed: 21, price: 60000 });
    const btc4h = resample(btc15, '4h'), btc1d = resample(btc15, '1d');
    const copy4h = btc4h.map(c => ({ ...c, open: c.open / 1000, high: c.high / 1000, low: c.low / 1000, close: c.close / 1000 }));
    const copy1d = btc1d.map(c => ({ ...c, open: c.open / 1000, high: c.high / 1000, low: c.low / 1000, close: c.close / 1000 }));
    const now = btc4h[btc4h.length - 1].time + 4 * H;
    const tight = btcRelation(copy4h, btc4h, copy1d, btc1d, now);
    expect(tight.coupling).toBe('TIGHT');
    expect(tight.corr4hAll).toBeCloseTo(1, 6);
    expect(tight.oppositeDayShare).toBeCloseTo(0, 6);

    const alt15 = synthCandles({ n: 4 * 24 * 200, tf: '15m', seed: 99, price: 3 });
    const loose = btcRelation(resample(alt15, '4h'), btc4h, resample(alt15, '1d'), btc1d, now);
    expect(loose.coupling).toBe('LOOSE');
    expect(Math.abs(loose.corr4hAll)).toBeLessThan(0.3);
    expect(loose.oppositeDayShare).toBeGreaterThan(0.3);
    expect(loose.note).toMatch(/not a gate/);
  });
  it('returns UNKNOWN when overlap is too short', () => {
    const a = synthCandles({ n: 10, tf: '4h', seed: 1 }), b = synthCandles({ n: 10, tf: '4h', seed: 2 });
    expect(btcRelation(a, b, [], []).coupling).toBe('UNKNOWN');
  });
});
