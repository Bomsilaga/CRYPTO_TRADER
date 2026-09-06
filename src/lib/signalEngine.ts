import type { RawCandle } from "./bybit";
import { atr } from "./indicators";
import {
  evidence,
  snapshot,
  levels,
  STYLE,
  type RecordTrade,
  type Style,
} from "./history";
import { sizeTrade, DEFAULT_COSTS } from "./risk";
export interface Preferences {
  capital: number;
  riskPct: number;
  leverage: number;
  style: Style;
}
export function runEngine(
  symbol: string,
  price: number,
  candles: RawCandle[],
  records: RecordTrade[],
  preferences: Preferences,
  asOf = Date.now(),
) {
  const { style, capital, riskPct, leverage } = preferences;
  if (candles.length < 100 || !Number.isFinite(price) || price <= 0)
    throw new Error("Insufficient valid closed-candle history");
  const past = candles.slice(-200),
    last = candles.at(-1)!;
  const assessments = (["LONG", "SHORT"] as const).map((direction) =>
    evidence(
      records.filter((r) => r.symbol === symbol && r.style === style),
      snapshot(past, style, direction),
      direction,
      asOf,
    ),
  );
  const qualified = assessments.filter(
    (e) =>
      e.comparable.n >= 50 &&
      e.comparable.effectiveSample >= 20 &&
      (e.comparable.expectancy ?? -Infinity) > 0 &&
      e.outOfSample.n >= 20 &&
      (e.outOfSample.expectancy ?? -Infinity) > 0,
  );
  qualified.sort(
    (a, b) => (b.comparable.expectancy ?? 0) - (a.comparable.expectancy ?? 0),
  );
  const tied =
    qualified.length === 2 &&
    Math.abs(
      qualified[0].comparable.expectancy! - qualified[1].comparable.expectancy!,
    ) < 0.05;
  const selected =
    qualified[0] ??
    assessments.sort((a, b) => b.comparable.n - a.comparable.n)[0];
  const direction = qualified.length && !tied ? selected.direction : "NEUTRAL";
  const a = atr(past),
    stale = asOf - (last.time + STYLE[style].ms) > STYLE[style].ms * 1.5;
  const chase = Math.abs(price - last.close) > a * 0.25;
  const trigger =
    selected.direction === "LONG"
      ? selected.features.trend.includes("UP")
      : selected.features.trend.includes("DOWN");
  const action =
    direction === "NEUTRAL" || stale || selected.features.volumeRatio < 0.5
      ? "NO TRADE"
      : chase || !trigger
        ? "WAIT FOR ENTRY"
        : "REVIEW TRADE";
  const p = levels(last.close, a, style, selected.direction);
  const plan = sizeTrade(p, capital, riskPct, leverage, capital, DEFAULT_COSTS);
  const s = selected.comparable,
    o = selected.outOfSample;
  const fmt = (n: number | null, d = 2) =>
    n === null ? "unavailable" : n.toFixed(d);
  const verdict = [
    `${symbol} — ${direction === "NEUTRAL" ? "NO TRADE" : direction + " BIAS"}`,
    `${s.n} comparable ${selected.direction} setups: ${s.wins[0]} reached TP1 before the stop (${fmt(s.tpRates[0], 1)}%). TP2 ${fmt(s.tpRates[1], 1)}%; TP3 ${fmt(s.tpRates[2], 1)}%.`,
    `Observed TP1 95% Wilson interval: ${s.interval ? s.interval.map((n) => n.toFixed(1)).join("–") + "%" : "unavailable"}. ${s.sampleLabel}. These are historical frequencies, not a calibrated forecast.`,
    `Expectancy ${fmt(s.expectancy)}R; profit factor ${fmt(s.profitFactor)}; worst drawdown ${fmt(s.maxDrawdownR)}R; longest losing streak ${s.maxLosingStreak}.`,
    `Walk-forward selected trades: n=${o.n}, expectancy ${fmt(o.expectancy)}R. Regime TP1 ${fmt(selected.regime.tpRates[0], 1)}% (n=${selected.regime.n}).`,
    `${action === "NO TRADE" ? "I stay flat. The evidence, data freshness, or liquidity does not pass the trading gate." : action === "WAIT FOR ENTRY" ? "I wait. Price or trend has not met the entry condition. Do not chase." : "The historical edge passes the review gate. Recheck current price and costs before placing an order."}`,
    `Conditional plan: entry $${p.entry.toPrecision(6)}; invalidation $${p.stopLoss.toPrecision(6)}; targets $${p.tp1.toPrecision(6)}, $${p.tp2.toPrecision(6)}, $${p.tp3.toPrecision(6)}.`,
    `$${capital.toFixed(2)} account; ${riskPct}% risk budget $${plan.riskBudget.toFixed(2)}. Notional $${plan.notional.toFixed(2)}; margin at ${leverage}× $${plan.margin.toFixed(2)}. Planned stop loss including estimated fees/slippage $${plan.plannedLoss.toFixed(2)}. Gaps can exceed this.`,
    `Full-position exit scenarios: TP1 net $${plan.targets[0].net.toFixed(2)}, TP2 $${plan.targets[1].net.toFixed(2)}, TP3 $${plan.targets[2].net.toFixed(2)}. The 50/25/25 path reaching all targets nets $${plan.stagedNet.toFixed(2)}.`,
    `Historical mean at this quantity: ${s.expectancy === null ? "unavailable" : "$" + (s.expectancy * plan.qty * Math.abs(p.entry - p.stopLoss)).toFixed(2)} per trade before funding.`,
    `Verdict: ${action}. A break of invalidation cancels this plan.`,
    selected.costNote,
  ].join("\n\n");
  return {
    symbol,
    price,
    direction,
    action,
    style,
    preferences,
    history: { ...selected, records: undefined },
    alternatives: assessments.map((e) => ({
      direction: e.direction,
      n: e.comparable.n,
      expectancy: e.comparable.expectancy,
    })),
    plan,
    levels: p,
    verdict,
    asOf,
    model: selected.model,
    stale,
    analyst:
      "Deterministic numerical trader commentary; no language model generates the statistics.",
    signalText: verdict,
  };
}
