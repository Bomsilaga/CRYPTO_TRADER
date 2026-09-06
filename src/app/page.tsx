"use client";
import { useState, useEffect } from "react";
import type { scanPair } from "@/lib/scanner";
type Result = Awaited<ReturnType<typeof scanPair>>;
const card = {
  padding: 20,
  background: "#111827",
  border: "1px solid #263244",
  borderRadius: 12,
};
const input = {
  padding: 10,
  background: "#0b1220",
  border: "1px solid #334155",
  borderRadius: 6,
  color: "#e2e8f0",
  width: "100%",
};
const number = (v: number | null, d = 2) => (v === null ? "—" : v.toFixed(d));
export default function Home() {
  const [symbol, setSymbol] = useState("ETHUSDT"),
    [capital, setCapital] = useState(5000),
    [risk, setRisk] = useState(1),
    [leverage, setLeverage] = useState(3),
    [style, setStyle] = useState("INTRADAY");
  const [result, setResult] = useState<Result | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  async function scan() {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const query = new URLSearchParams({
        symbol,
        capital: String(capital),
        riskPct: String(risk),
        leverage: String(leverage),
        style,
      });
      const response = await fetch("/api/scan?" + query),
        data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setResult(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const selected = new URLSearchParams(window.location.search).get("symbol");
    if (selected && /^[A-Z0-9]+USDT$/.test(selected)) setSymbol(selected);
  }, []);
  const h = result?.history,
    s = h?.comparable,
    p = result?.plan;
  return (
    <main
      style={{
        maxWidth: 1000,
        margin: "auto",
        padding: "32px 18px",
        color: "#e2e8f0",
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>
        4SCANS{" "}
        <span style={{ color: "#5eead4", fontSize: 14 }}>HISTORICAL EDGE</span>
      </h1>
      <p style={{ color: "#94a3b8", margin: "8px 0 24px" }}>
        Any Bybit USDT perpetual pair · Separate historical evidence for each
        symbol
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          scan();
        }}
        style={card}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(135px,1fr))",
            gap: 12,
          }}
        >
          <label>
            Pair
            <input
              style={input}
              placeholder="ETHUSDT, SOLUSDT, BTCUSDT…"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              required
              pattern="[A-Z0-9]+USDT"
            />
          </label>
          <label>
            Account ($)
            <input
              style={input}
              type="number"
              min="1"
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value))}
            />
          </label>
          <label>
            Risk (%)
            <input
              style={input}
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              value={risk}
              onChange={(e) => setRisk(Number(e.target.value))}
            />
          </label>
          <label>
            Leverage (×)
            <input
              style={input}
              type="number"
              min="1"
              max="100"
              value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
            />
          </label>
          <label>
            Style
            <select
              style={input}
              value={style}
              onChange={(e) => setStyle(e.target.value)}
            >
              <option>SCALP</option>
              <option>INTRADAY</option>
              <option>SWING</option>
            </select>
          </label>
        </div>
        <button
          disabled={loading}
          style={{
            ...input,
            marginTop: 16,
            background: "#0f766e",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          {loading
            ? "Loading pair history and testing setups…"
            : "Analyse pair history"}
        </button>
      </form>
      {error && (
        <p role="alert" style={{ ...card, color: "#fca5a5", marginTop: 16 }}>
          {error}
        </p>
      )}
      {result && h && s && p && (
        <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
          <section style={card}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              <h2 style={{ fontSize: 22, fontWeight: 700 }}>
                {result.symbol} · ${result.price.toPrecision(6)}
              </h2>
              <strong
                style={{
                  color: result.action === "NO TRADE" ? "#fbbf24" : "#5eead4",
                }}
              >
                {result.action}
              </strong>
            </div>
            <p>
              {result.direction} · {result.style} · {s.sampleLabel}
            </p>
          </section>
          <section style={card}>
            <h2 style={{ fontWeight: 700, marginBottom: 12 }}>
              Historical edge — {h.direction} comparisons
            </h2>
            <p style={{ color: "#94a3b8" }}>
              Loaded period:{" "}
              {h.range.from ? new Date(h.range.from).toLocaleDateString() : "—"}{" "}
              to {h.range.to ? new Date(h.range.to).toLocaleDateString() : "—"}.
              Historical simulations, not actual fills.
            </p>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ marginTop: 12 }}>
                <div
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <span>TP{i + 1} before stop</span>
                  <span>
                    {s.wins[i]} / {s.n} · {number(s.tpRates[i], 1)}%
                  </span>
                </div>
                <div
                  style={{
                    height: 7,
                    background: "#253145",
                    marginTop: 6,
                    borderRadius: 4,
                  }}
                >
                  <div
                    style={{
                      height: 7,
                      width: `${s.tpRates[i] ?? 0}%`,
                      background: "#2dd4bf",
                      borderRadius: 4,
                    }}
                  />
                </div>
              </div>
            ))}
            <p style={{ marginTop: 12 }}>
              TP1 95% Wilson interval:{" "}
              {s.interval
                ? s.interval.map((v) => v.toFixed(1)).join("–") + "%"
                : "unavailable"}
              . Observed frequency; not a calibrated forecast.
            </p>
            <div style={{ overflowX: "auto", marginTop: 16 }}>
              <table
                style={{
                  width: "100%",
                  textAlign: "left",
                  borderCollapse: "collapse",
                }}
              >
                <thead>
                  <tr>
                    {[
                      "Evidence",
                      "Trades",
                      "TP1",
                      "Expectancy",
                      "Profit factor",
                    ].map((v) => (
                      <th key={v} style={{ padding: 8 }}>
                        {v}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    ["Loaded pair history", h.all],
                    ["Current regime", h.regime],
                    ["Closest matches", s],
                    ["Walk-forward selected", h.outOfSample],
                  ].map(([label, v]) => {
                    const a = v as typeof s;
                    return (
                      <tr key={String(label)}>
                        {[
                          String(label),
                          a.n,
                          number(a.tpRates[0], 1) + "%",
                          number(a.expectancy) + "R",
                          number(a.profitFactor),
                        ].map((c, i) => (
                          <td
                            key={i}
                            style={{
                              padding: 8,
                              borderTop: "1px solid #263244",
                            }}
                          >
                            {c}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
                gap: 12,
                marginTop: 16,
              }}
            >
              {[
                [
                  "Mean / median MFE",
                  `${number(s.avgMFE)}% / ${number(s.medianMFE)}%`,
                ],
                [
                  "Mean / median MAE",
                  `${number(s.avgMAE)}% / ${number(s.medianMAE)}%`,
                ],
                ["Mean holding time", `${number(s.holdingHours)} hours`],
                ["Worst drawdown", `${number(s.maxDrawdownR)}R`],
                ["Longest losing streak", s.maxLosingStreak],
                ["Stop before TP1", `${number(s.stopFirst, 1)}%`],
                ["30-day TP1", `${number(s.recent30DayTp1, 1)}%`],
                [
                  "Recency-weighted TP1",
                  `${number(s.weightedTp1, 1)}% (effective n=${number(s.effectiveSample, 1)})`,
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    background: "#0b1220",
                    padding: 12,
                    borderRadius: 6,
                  }}
                >
                  <p style={{ color: "#94a3b8", fontSize: 12 }}>{label}</p>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <p style={{ color: "#94a3b8", marginTop: 12 }}>{h.validation}</p>
            <p style={{ color: "#fbbf24", marginTop: 8 }}>{h.costNote}</p>
          </section>
          <section style={card}>
            <h2 style={{ fontWeight: 700 }}>
              Your ${p.capital.toLocaleString()} conditional trade
            </h2>
            <p style={{ color: "#94a3b8" }}>
              Estimates before exchange precision, live funding and fill
              reconciliation. Planned loss is not a guaranteed maximum.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(165px,1fr))",
                gap: 12,
                marginTop: 16,
              }}
            >
              {[
                ["Risk budget", p.riskBudget],
                ["Planned stop loss", p.plannedLoss],
                ["Notional", p.notional],
                ["Selected margin", p.margin],
                ["Margin at 3×", p.margin3x],
                ["Margin at 5×", p.margin5x],
                ["Stop fees", p.stop.fees],
                ["Stop slippage", p.stop.slippage],
              ].map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    padding: 12,
                    background: "#0b1220",
                    borderRadius: 6,
                  }}
                >
                  <p style={{ fontSize: 12, color: "#94a3b8" }}>{label}</p>
                  <strong>${Number(value).toFixed(2)}</strong>
                </div>
              ))}
            </div>
            <p style={{ marginTop: 12 }}>
              Entry ${result.levels.entry.toPrecision(6)} · Stop $
              {result.levels.stopLoss.toPrecision(6)} · Distance{" "}
              {p.stopDistancePct.toFixed(3)}%
            </p>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{ width: "100%", textAlign: "left", marginTop: 12 }}
              >
                <thead>
                  <tr>
                    <th>Full-position scenario</th>
                    <th>Target</th>
                    <th>Gross P&amp;L</th>
                    <th>Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {p.targets.map((t, i) => (
                    <tr key={i}>
                      <td>TP{i + 1}</td>
                      <td>
                        $
                        {[
                          result.levels.tp1,
                          result.levels.tp2,
                          result.levels.tp3,
                        ][i].toPrecision(6)}
                      </td>
                      <td>${t.gross.toFixed(2)}</td>
                      <td>${t.net.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ marginTop: 12 }}>
              50/25/25 exit path reaching all targets:{" "}
              <strong>${p.stagedNet.toFixed(2)} net</strong>.
            </p>
            <p style={{ color: "#94a3b8" }}>{p.liquidationNote}</p>
          </section>
          <section style={card}>
            <h2 style={{ fontWeight: 700, marginBottom: 12 }}>
              Trader verdict
            </h2>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
              {result.verdict}
            </p>
          </section>
          <details style={card}>
            <summary>Method and data coverage</summary>
            <p>{result.analyst}</p>
            <p>Storage: {result.storage}</p>
            <p>Unavailable features: {h.missingFeatures.join(", ")}.</p>
            <p>
              Model: {result.model}. Non-overlapping trades within each
              direction; stop-first for ambiguous candles; timeouts exit at the
              final candle close. Wilson intervals do not account for all market
              dependence. Undefined profit factor is shown as —.
            </p>
          </details>
        </div>
      )}
    </main>
  );
}
