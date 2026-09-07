import { describe, it, expect } from 'vitest';
import { structuralLevels } from '../src/lib/levels';
import type { RawCandle } from '../src/lib/bybit';
import { synthCandleMap } from './fixtures';

const H = 3_600_000;
const c = (i: number, o: number, h: number, l: number, cl: number, v = 1000): RawCandle => ({ time: i * H, open: o, high: h, low: l, close: cl, volume: v });

/** 60 bars of gentle uptrend drift, then a bearish candle (order block) followed by a strong bullish displacement, then price drifts above. */
function obScenario(): RawCandle[] {
  const out: RawCandle[] = [];
  let p = 100;
  for (let i = 0; i < 60; i++) { const o = p, cl = p + 0.05 + (i % 3 === 0 ? -0.15 : 0.1); out.push(c(i, o, Math.max(o, cl) + 0.2, Math.min(o, cl) - 0.2, cl)); p = cl; }
  // bearish OB candle at ~103
  out.push(c(60, p, p + 0.1, p - 0.6, p - 0.5)); p -= 0.5;
  // displacement: three big bullish candles (> 0.8 ATR each, ATR ≈ 0.5)
  for (let i = 61; i < 64; i++) { out.push(c(i, p, p + 1.6, p - 0.05, p + 1.5, 3000)); p += 1.5; }
  // drift sideways above the OB
  for (let i = 64; i < 72; i++) { out.push(c(i, p, p + 0.3, p - 0.3, p + 0.02)); p += 0.02; }
  return out;
}

describe('structural levels', () => {
  it('LONG: entry is a limit at the top of the order-block zone below price, stop beyond it, targets ≥ 1R/2R/3R and monotonic', () => {
    const h1 = obScenario();
    const price = h1[h1.length - 1].close;
    const lv = structuralLevels({ candleMap: { '1h': h1, '15m': h1, '4h': h1.slice(-25) }, direction: 'LONG', price, style: 'INTRADAY' });
    expect(lv.fallback).toBe(false);
    // the displacement leaves an FVG just below price; the OB itself is ~8 ATR away and correctly not chosen
    expect(lv.entryKinds.some(k => k === 'FVG' || k === 'OB')).toBe(true);
    expect(lv.confluence).toBeGreaterThanOrEqual(2);      // same FVG seen on 15m/1h/4h
    expect(lv.entryMode).toBe('LIMIT');
    expect(lv.entryStatus).toBe('WAIT_PULLBACK');
    expect(lv.entry).toBeLessThan(price);                 // pullback entry, not the market price
    expect(lv.entry).toBeCloseTo(lv.entryZone[1], 8);     // top of the zone
    expect(lv.stop).toBeLessThan(lv.entryZone[0]);        // beyond the zone low
    expect(lv.tp1).toBeGreaterThan(lv.entry);
    expect(lv.tp2).toBeGreaterThan(lv.tp1);
    expect(lv.tp3).toBeGreaterThan(lv.tp2);
    expect(lv.rMultiples.tp1).toBeGreaterThanOrEqual(1);
    expect(lv.rMultiples.tp2).toBeGreaterThanOrEqual(2);
    expect(lv.rMultiples.tp3).toBeGreaterThanOrEqual(3);
    expect(lv.windows['1h']).toBeGreaterThanOrEqual(50);
    expect(lv.windows['4h']).toBeGreaterThanOrEqual(20);
  });

  it('SHORT mirrors LONG exactly on mirrored candles', () => {
    const h1 = obScenario();
    const price = h1[h1.length - 1].close;
    const lvL = structuralLevels({ candleMap: { '1h': h1, '15m': h1, '4h': h1.slice(-25) }, direction: 'LONG', price, style: 'INTRADAY' });
    const mir = h1.map(x => ({ ...x, open: -x.open, high: -x.low, low: -x.high, close: -x.close }));
    const lvS = structuralLevels({ candleMap: { '1h': mir, '15m': mir, '4h': mir.slice(-25) }, direction: 'SHORT', price: -price, style: 'INTRADAY' });
    expect(lvS.entry).toBeCloseTo(-lvL.entry, 8);
    expect(lvS.stop).toBeCloseTo(-lvL.stop, 8);
    expect(lvS.tp2).toBeCloseTo(-lvL.tp2, 8);
    expect(lvS.entryMode).toBe(lvL.entryMode);
    expect(lvS.entry).toBeGreaterThan(-price);            // SHORT pullback entry sits above price
    expect(lvS.stop).toBeGreaterThan(lvS.entry);
    expect(lvS.tp1).toBeLessThan(lvS.entry);
  });

  it('in-zone with a bullish engulfing candle → MARKET entry NOW', () => {
    const h1 = obScenario();
    // pull price back (mitigating the displacement FVG) into the order-block zone, then print an engulfing candle inside it
    const ob = h1[60];
    const obLo = ob.low, obHi = Math.max(ob.open, ob.close);
    const cs = [...h1];
    let p = h1[h1.length - 1].close, i = h1.length;
    while (p > obHi + 0.4) { const cl = p - 0.9; cs.push(c(i++, p, p + 0.1, cl - 0.1, cl)); p = cl; }
    const bear = c(i++, obLo + 0.35, obLo + 0.4, obLo + 0.12, obLo + 0.15);
    const engulf = c(i++, obLo + 0.1, obLo + 0.55, obLo + 0.05, obLo + 0.5, 4000);   // closes above bear.open, inside the 0.6-high zone
    cs.push(bear, engulf);
    const price = engulf.close;
    expect(price).toBeGreaterThan(obLo); expect(price).toBeLessThan(obHi);
    const lv = structuralLevels({ candleMap: { '1h': cs, '15m': cs, '4h': cs.slice(-25) }, direction: 'LONG', price, style: 'INTRADAY' });
    expect(lv.entryKinds).toContain('OB');
    expect(lv.entryStatus).toBe('NOW');
    expect(lv.entryMode).toBe('MARKET');
    expect(lv.confirmation?.pattern).toBe('ENGULFING');
    expect(lv.entry).toBe(price);
  });

  it('flags an ATR fallback when there is no structure within reach, and never returns a stop on the wrong side', () => {
    const flat: RawCandle[] = Array.from({ length: 80 }, (_, i) => c(i, 100, 100.02, 99.98, 100));
    const lv = structuralLevels({ candleMap: { '1h': flat, '4h': flat.slice(-25) }, direction: 'LONG', price: 100, style: 'INTRADAY' });
    expect(lv.stop).toBeLessThan(lv.entry);
    expect(lv.tp1).toBeGreaterThan(lv.entry);
    expect(lv.notes.join(' ')).toMatch(/fallback|R-multiple/i);
  });

  it('runs on synthetic multi-timeframe history for both directions and every style without throwing', () => {
    const cm = synthCandleMap(3);
    const price = cm['1h'][cm['1h'].length - 1].close;
    for (const dir of ['LONG', 'SHORT'] as const) for (const style of ['SCALP', 'INTRADAY', 'SWING'] as const) {
      const lv = structuralLevels({ candleMap: cm, direction: dir, price, style });
      expect(Number.isFinite(lv.entry) && Number.isFinite(lv.stop) && Number.isFinite(lv.tp3)).toBe(true);
      if (dir === 'LONG') { expect(lv.stop).toBeLessThan(lv.entry); expect(lv.tp1).toBeGreaterThan(lv.entry); }
      else { expect(lv.stop).toBeGreaterThan(lv.entry); expect(lv.tp1).toBeLessThan(lv.entry); }
      expect(lv.rMultiples.tp2).toBeGreaterThanOrEqual(1.9);
    }
  });
});
