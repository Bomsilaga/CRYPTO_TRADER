/**
 * history/similarity.ts — transparent nearest-neighbour matching.
 * Normalised (z-score) weighted Euclidean distance over numeric features,
 * plus flag mismatches and categorical regime mismatches. No black box.
 */
import type { BacktestTrade, FeatureNorm, FeatureSnapshot } from './types';
import { SIMILARITY_CATEGORICAL, SIMILARITY_FEATURES, SIMILARITY_FLAGS } from './features';

export function distance(a: FeatureSnapshot, b: FeatureSnapshot, norms: Record<string, FeatureNorm>): number {
  let d = 0;
  for (const { key, weight } of SIMILARITY_FEATURES) {
    const n = norms[key] ?? { mean: 0, std: 1 };
    const za = (Number(a[key]) - n.mean) / n.std, zb = (Number(b[key]) - n.mean) / n.std;
    if (!Number.isFinite(za) || !Number.isFinite(zb)) continue;
    d += weight * (za - zb) ** 2;
  }
  for (const { key, weight } of SIMILARITY_FLAGS) if (Boolean(a[key]) !== Boolean(b[key])) d += weight;
  for (const { key, weight } of SIMILARITY_CATEGORICAL) if (a[key] !== b[key]) d += weight * 2;
  return Math.sqrt(d);
}

export function nearest(current: FeatureSnapshot, pool: BacktestTrade[], norms: Record<string, FeatureNorm>, k?: number): { matches: BacktestTrade[]; k: number; avgDistance: number; maxDistance: number } {
  const same = pool.filter(t => t.direction === current.direction);
  const kk = k ?? Math.max(30, Math.min(150, Math.round(same.length * 0.08)));
  const scored = same.map(t => ({ t, d: distance(current, t.features, norms) })).sort((a, b) => a.d - b.d).slice(0, kk);
  return {
    matches: scored.map(s => s.t),
    k: scored.length,
    avgDistance: scored.length ? scored.reduce((a, s) => a + s.d, 0) / scored.length : 0,
    maxDistance: scored.length ? scored[scored.length - 1].d : 0,
  };
}
