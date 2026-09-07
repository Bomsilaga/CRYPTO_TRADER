import { describe, it, expect } from 'vitest';
import { fetchKlinesRange, fetchFundingRange } from '../src/lib/history/bybitHistory';
import { FileHistoryStore } from '../src/lib/history/store';
import { syncCandles } from '../src/lib/history/sync';
import { bybitSource } from '../src/lib/history/sources';
import { resample, closedBefore, mergeCandles } from '../src/lib/history/resample';
import { synthCandles } from './fixtures';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const H = 3_600_000;

/** Fake Bybit kline server: newest-first pages of `limit`, honouring start/end. */
function fakeBybit(all: { time: number; open: number; high: number; low: number; close: number; volume: number }[]) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const start = Number(u.searchParams.get('start') ?? 0), end = Number(u.searchParams.get('end') ?? Infinity), limit = Number(u.searchParams.get('limit') ?? 1000);
    const list = all.filter(c => c.time >= start && c.time <= end).sort((a, b) => b.time - a.time).slice(0, limit)
      .map(c => [String(c.time), String(c.open), String(c.high), String(c.low), String(c.close), String(c.volume), '0']);
    return { status: 200, ok: true, text: async () => JSON.stringify({ retCode: 0, result: { list } }) };
  };
  return { fetchImpl, calls };
}

describe('historical pagination + storage', () => {
  it('pages backwards through 2,500 candles, de-duplicates and returns ascending', async () => {
    const all = synthCandles({ n: 2500, tf: '1h', seed: 1 });
    const { fetchImpl, calls } = fakeBybit(all);
    const got = await fetchKlinesRange('X', '1h', all[0].time, all[all.length - 1].time, { fetchImpl });
    expect(got).toHaveLength(2500);
    expect(calls.length).toBe(3);
    for (let i = 1; i < got.length; i++) expect(got[i].time).toBeGreaterThan(got[i - 1].time);
    expect(new Set(got.map(c => c.time)).size).toBe(2500);
  });
  it('funding pagination', async () => {
    const pts = Array.from({ length: 450 }, (_, i) => ({ t: i * 8 * H, r: 0.0001 }));
    const fetchImpl = async (url: string) => {
      const u = new URL(url); const end = Number(u.searchParams.get('endTime'));
      const list = pts.filter(p => p.t <= end).sort((a, b) => b.t - a.t).slice(0, 200).map(p => ({ fundingRate: String(p.r), fundingRateTimestamp: String(p.t) }));
      return { status: 200, ok: true, text: async () => JSON.stringify({ retCode: 0, result: { list } }) };
    };
    const got = await fetchFundingRange('X', 0, 449 * 8 * H, { fetchImpl });
    expect(got).toHaveLength(450);
  });
  it('file store upserts without duplicates; sync fetches only new candles on the second run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), '4s-hist-'));
    const store = new FileHistoryStore(dir);
    const all = synthCandles({ n: 1200, tf: '1h', seed: 3 });
    const now = all[999].time + H + 1;                            // candle 1000 still open → first 1000 closed
    const { fetchImpl, calls } = fakeBybit(all);
    const r1 = await syncCandles(store, 'X', '1h', { depthMs: 5000 * H, now, source: bybitSource(fetchImpl) });
    expect(r1.fetched).toBe(1000);
    expect((await store.getCandles('X', '1h')).length).toBe(1000);
    const c1 = calls.length;
    const r2 = await syncCandles(store, 'X', '1h', { now: now + 100 * H, source: bybitSource(fetchImpl) });
    expect(r2.fetched).toBe(100);
    expect(calls.length - c1).toBe(1);
    const stored = await store.getCandles('X', '1h');
    expect(stored.length).toBe(1100);
    expect(new Set(stored.map(c => c.time)).size).toBe(1100);
    const again = await store.upsertCandles('X', '1h', stored.slice(0, 50));
    expect(again.inserted).toBe(0);
    const r3 = await syncCandles(store, 'X', '1h', { now: now + 100 * H, source: bybitSource(fetchImpl) });
    expect(r3.skipped).toBe('up to date');
  });
  it('resample aligns to UTC boundaries and closedBefore excludes the open candle', () => {
    const c15 = synthCandles({ n: 8, tf: '15m', seed: 5, start: Date.UTC(2025, 0, 1) });
    const h1 = resample(c15, '1h');
    expect(h1).toHaveLength(2);
    expect(h1[0].high).toBe(Math.max(...c15.slice(0, 4).map(c => c.high)));
    expect(h1[0].close).toBe(c15[3].close);
    expect(h1[0].volume).toBeCloseTo(c15.slice(0, 4).reduce((a, c) => a + c.volume, 0), 6);
    expect(closedBefore(h1, '1h', h1[1].time + H - 1)).toHaveLength(1);
    expect(closedBefore(h1, '1h', h1[1].time + H)).toHaveLength(2);
    expect(mergeCandles(h1, h1)).toHaveLength(2);
  });
});
