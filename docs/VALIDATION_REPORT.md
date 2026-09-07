# 4SCANS — Historical Edge Engine: Developer Validation Report

Branch: `claude/historical-edge-engine` · Date: 2026-09-07

This report describes what was built, what was verified, and what was **not**. Update 2 (same day): Bybit is
geo-blocked from the build environment, so an **OKX fallback source** was added and real history for six pairs was
downloaded, replayed and uploaded to Supabase (§6, §13). Those statistics are real market results **from OKX
perpetuals, not Bybit** — a documented venue mismatch (§14).

---

## 1. Files changed / added

| Area | Files |
|---|---|
| Security + execution | `src/lib/auth.ts` (new), `src/lib/kv.ts` (new), `src/lib/risk/limits.ts` (new), `src/lib/risk/riskModel.ts` (new), `src/lib/bybitPrivate.ts` (new), `src/lib/execution.ts` (new), `src/app/api/trade/route.ts` (rewritten), `src/app/api/trade/manage/route.ts` (new), `src/app/api/cron/scan/route.ts` (auth added) |
| Historical engine | `src/lib/history/{types,bybitHistory,okxHistory,sources,resample,store,sync,features,costs,outcome,backtest,stats,similarity,evidence,pipeline}.ts` (new), `supabase/migrations/20260907_crypto_trader_history_engine.sql` + `20260907_crypto_trader_hist_write_token.sql` (new, applied), `scripts/history-build.ts`, `scripts/history-upload.ts` (new) |
| API surface | `src/app/api/scan/route.ts` (features + evidence), `src/app/api/evidence/route.ts` (new), `src/app/api/history/build/route.ts` (new), `src/app/api/history/status/route.ts` (new), `src/app/api/ai-explain/route.ts` (rewritten) |
| UI | `src/app/page.tsx` — Historical Edge panel now renders exchange-replay statistics (4 layers), execution-token setting, history builder, idempotent execution, limit-entry state polling, hard-limit/fill/liquidation display |
| Tooling | `vitest.config.ts`, `eslint.config.mjs`, `tests/*.test.ts` (10 files, 53 tests), `package.json` scripts (`test`, `typecheck`, `lint`, `history:build`, `check`), `.env.local.example` |

## 2. Architecture added

```
Bybit V5 public klines/funding ──▶ history/bybitHistory (paginated, backoff) ──▶ history/sync (incremental)
        │                                                                              │
        ▼                                                                              ▼
history/store  ◀─────────────────────────────────────────────────────────  hist_candles / hist_funding / hist_sync_state
   (file | Supabase)                                                                   │
        │                                                                              ▼
        └──▶ history/backtest.replayOne(T):  slice candles closed ≤ T  ──▶ runEngine (unchanged live engine)
                     │                                                   ──▶ history/features (snapshot at T)
                     └──▶ history/outcome (walk forward T+1…; staged exits; lower-TF ambiguity) ──▶ history/costs (net)
                                            │
                                            ▼
                     history/stats: summarize · Wilson · walkForward · decay · btcSplit  ──▶ hist_backtest_runs / hist_backtest_trades
                                            │
scan route ──▶ features(now) ──▶ history/evidence.buildEvidence ──▶ { pairWide, regime, similarSetups, outOfSample, btcSplit, decay,
                                                                        warnings, noTradeReasons }  ──▶ UI panel + AI prompt
```

* The **live engine is replayed unmodified** (`runEngine`) on a candle map truncated to candles whose *close* time ≤ T,
  then trimmed to the exact counts the live scanner fetches (1m 80 · 5m 100 · 15m 100 · 1h 200 · 4h 100 · 1d 100).
* Decision timeframe: 1h. Entry = decision-candle close (+ slippage under the conservative profile); stop/TPs are the
  engine's absolute levels. `oneAtATime: true` — a new decision is not taken while a replayed trade is still open
  (realistic; also limits autocorrelated duplicates).
* Statistics are R-multiple first; dollars are derived only when the user's current risk amount is applied
  (`risk/riskModel.ts`, shared by UI, AI prompt and execution).

## 3. Security issues fixed

| Issue | Fix |
|---|---|
| `/api/trade` publicly callable with server Bybit keys | Live execution requires **all** of `TRADING_MODE=live`, a request carrying `TRADE_AUTH_TOKEN` (timing-safe compare, ≥16 chars), `liveMode:true`, and a durable KV. Anything less runs **paper**. Client-supplied keys are honoured only on an authenticated request. |
| Client `liveMode:true` enabled live | Server decides; the flag is one of four AND-ed conditions (`src/lib/auth.ts`). Tested. |
| Duplicate positions (double-click, retry, refresh) | Every request carries a `tradeId`; `kv.claim()` is an insert-only claim; replays return the stored result (`idempotent:true`). Tested at KV and route level. |
| No server-side risk control | `risk/limits.ts` hard limits: 1 %/trade, 3 % open risk, 3 % daily realised loss, 5 trades/day, 2 positions, 5× leverage, 300 % notional, stop-to-liquidation buffer ≥ 150 % of stop distance, duplicate-symbol and correlation-group checks. `RISK_LIMITS` env can tighten but is clamped (risk ≤ 2 %, leverage ≤ 10×, daily loss ≤ 5 %). `force` bypasses **only** the soft funding-rate warning. Tested. |
| `/api/cron/scan` open to anyone (push spam) | Requires `Authorization: Bearer $CRON_SECRET`; unset secret ⇒ always 401. Tested. |
| Server keys reachable through history/admin routes | `/api/history/build` and `/api/trade/manage` require the admin/execution token. `hist_kv` has no anon RLS policy; writes to `hist_*` require the service-role key. |

## 4. Execution issues fixed

* **Sizing**: `qty = riskUSD / |entry − stop|`, rounded to the instrument's `qtyStep`, min/max qty enforced, margin capped at 90 % of available.
* **Fill reconciliation** (market): position re-read → actual avg price, size, exchange `liqPrice`; true risk recomputed; > 15 % over target → reduce-only trim to target; > 50 % → emergency close.
* **Stop verification**: after entry (and after any re-attach) the position is re-read; stop must exist within 0.2 % of intended and size must match; one retry via `trading-stop` (MarkPrice trigger), then emergency market close. HTTP 200 is never treated as proof.
* **Limit-entry state machine** (`ENTRY_PENDING → ENTRY_PARTIAL/FILLED → PROTECTION_PENDING → SL_CONFIRMED → TPS_CONFIRMED → MANAGED/CLOSED/EMERGENCY_CLOSED`) driven by `/api/trade/manage`; TPs are sized on the **filled** quantity and re-placed on further fills; partial fills are protected immediately. The UI polls every 10 s for up to 15 min.
* **Staged exits**: 50/25/25 reduce-only limits with `orderLinkId` tags; sub-minimum slices fold into TP1.
* **V5 signing** corrected (JSON body for POST, query string for GET); `GTC`/`IOC` time-in-force; leverage `110043` treated as already-set.
* **Liquidation**: estimate `1/lev − MMR` is used only pre-trade for the hard-limit buffer; the exchange's `liqPrice` is displayed after fill with distance-to-liq and stop-to-liq buffer.

## 5. Historical data source

**Primary**: Bybit V5 public REST (`/v5/market/kline`, `/v5/market/funding/history`, category `linear`) — the same venue the app
executes on. Paging is backward with `end`, 1000 candles per call, 120 ms inter-request gap, exponential backoff on
429/5xx, de-duplicated by open time. `BYBIT_PROXY_URL` is honoured for blocked regions. Sync is incremental
(`hist_sync_state.last_time`); a re-run fetches only closed candles newer than the last stored one.

Depth targets (first backfill): 1m 3 weeks · 5m ~9 months · 15m ~13 months · 1h 3 years · 4h 5 years · 1d 10 years
(the exchange returns whatever exists; listing date bounds younger pairs such as EIGENUSDT).

**Fallback** (`HISTORY_SOURCE=auto`, used when Bybit is unreachable): OKX v5 public `history-candles` /
`funding-rate-history` for the same USDT perpetual (`EIGEN-USDT-SWAP`), 100 candles per call, 20 req/2 s, `1Dutc`
bars so daily candles align with Bybit's UTC days; multiplier pairs (1000PEPE) are rescaled. Every run and sync state
records `source`; the UI shows a "source OKX · venue ≠ execution" chip and the AI prompt is told.

**Writes without the service-role key**: `hist_upsert` / `hist_delete_backtest_trades` are SECURITY DEFINER RPCs that
check a sha256-hashed `HISTORY_WRITE_TOKEN` stored in `hist_config` (no anon policy). Verified: wrong token → error,
anon direct insert → RLS error, correct token → upsert with table defaults applied.

## 6. Number of candles available per pair/timeframe

Downloaded from **OKX** on 2026-09-07 (Bybit blocked from this environment), stored locally and uploaded to Supabase
(`hist_candles`, `hist_funding`, `hist_sync_state`, `hist_backtest_runs`, `hist_backtest_trades`).

| Pair | 1m | 5m | 15m | 1h | 4h | 1d | Funding pts |
|---|---|---|---|---|---|---|---|
| BTCUSDT | 30,241 (3 wk) | 77,761 (Dec-25→) | 38,401 (Aug-25→) | 26,281 (Sep-23→) | 10,951 (Sep-21→) | 2,441 (Jan-20→) | 288 |
| EIGENUSDT | 30,241 | 77,761 | 38,401 | 16,945 (Oct-24→, listing) | 4,236 | 706 | 576 |
| ETHUSDT | 30,241 | 77,761 | 38,401 | 26,281 | 10,951 | 2,441 | 288 |
| SOLUSDT | 30,241 | 77,761 | 38,401 | 26,281 | 10,951 | 2,053 (Jan-21→) | 289 |
| SUIUSDT | 30,241 | 77,761 | 38,401 | 26,281 | 7,328 (May-23→) | 1,221 | 289 |
| ICPUSDT | 30,241 | 77,761 | 38,401 | 26,281 | 10,951 | 1,941 (May-21→) | 289 |

Each pair took ~7–8 minutes to download and replay (≈26,000 hourly decisions for the 3-year pairs). Re-running is
incremental. Other pairs: `HISTORY_WRITE_TOKEN=… npm run history:build -- <PAIR>` (auto-selects source) then
`npm run history:upload -- <PAIR> --candles`, or Setup → "Build history" once `HISTORY_WRITE_TOKEN` is set in Vercel.

## 7. Backtest assumptions

* Decision every closed 1h candle after a 210-bar warm-up; only candles closed at or before T are visible to the engine.
* NEUTRAL bias ⇒ no trade (counted as `neutralDecisions`); no defaulting to LONG anywhere (engine, evidence, AI).
* Exits: TP1 50 %, TP2 25 %, TP3 25 %; stop moved to entry after TP1 (`moveStopToBreakevenAfterTP1: true`).
* Timeout: SCALP 12 bars, INTRADAY 72, SWING 240 — remainder closed at last close as a taker.
* One replayed trade at a time (no pyramiding, no overlapping samples from adjacent hours).
* Default "setup" population for headline stats: engine score ≥ 60 (stored for all scores; the UI also shows the ±7 score band).

## 8. Fee assumptions

Conservative profile (default, used for all stored statistics): taker entry 0.055 %, taker stop/timeout 0.055 %, maker
targets 0.020 %. Base profile: maker entry 0.020 %, otherwise the same. Fees are charged **on each partial exit's
notional** (e.g. TP2 fee = 0.25 × qty × TP2 price × 0.02 %), never as N × full-position fee. Funding is charged from
historical settlements on the fraction still open at each settlement, signed by direction. Unit-tested.

## 9. Slippage assumptions

Conservative 5 bps on every taker fill (entry, stop, timeout); base 2 bps; maker fills 0. Applied before fee
calculation so slippage also increases fee notional. Live fills are reconciled against the real average price (§4).

## 10. Same-candle handling

When one decision-timeframe candle touches both the next target and the stop, the candle is **not** credited as a win.
The resolver descends 15m → 5m → 1m inside that candle and takes the first level touched; if the lowest available
candle is still ambiguous, **STOP is assumed first** (`ambiguityResolvedBy: 'conservative'`). After a target fills inside
a candle, a stop moved to breakeven is not re-tested against the same candle (its low may precede the target); stop
checks resume on the next candle. Every trade records `ambiguousCandles`. Unit-tested in both directions.

## 11. Look-ahead safeguards

* `closedBefore()` (binary search on `open + tf ≤ T`) truncates every timeframe before the engine sees it.
* Feature computation receives only the truncated map; ATR percentile ranks the current value against **prior** values only.
* Test: tampering every candle after T on every timeframe leaves entry, stop, targets, score and features byte-identical.

## 12. Walk-forward methodology

Rolling 6-month train / 1-month validation, stepping monthly. The only tunable is the minimum Setup Quality score
admitted as a setup (candidates 50/60/70/80), chosen on the train window by net expectancy (needs ≥ 15 trades) and
applied blind to the following month. Validation months are pooled as **out-of-sample**; train windows are pooled as
in-sample (overlapping, labelled as such). Stored per fold: parameter chosen, candidates with train results, in-sample
and validation blocks. Warnings are raised for < 3 folds, OOS n < 50, degradation > 0.25R, < 50 % positive folds, and
> 50 % of OOS profit from one month. Test asserts no validation trade enters its own training window.

## 13. Out-of-sample results

Real replay, OKX data, **conservative** profile (taker entry/stop, maker targets, 5 bps slippage, historical funding),
stop-to-breakeven after TP1, one trade at a time, headline population = engine score ≥ 60. OOS = pooled validation
months of the rolling 6m/1m walk-forward. Sample quality per §Phase 14 scale.

| Pair | Dir | n (≥60) | Quality | TP1 | TP2 | TP3 | Stop-first | Exp (all) | PF | OOS n | **OOS exp** | OOS PF | Recent edge |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| EIGENUSDT | LONG | 33 | VERY LOW | 48.5% | 24.2% | 18.2% | 51.5% | −0.05R | 0.91 | 20 | **−0.14R** | 0.77 | INSUFFICIENT |
| EIGENUSDT | SHORT | 33 | VERY LOW | 57.6% | 39.4% | 15.2% | 39.4% | +0.22R | 1.53 | 38 | **+0.24R** | 1.67 | INSUFFICIENT |
| ETHUSDT | LONG | 105 | MODERATE | 61.0% | 32.4% | 21.0% | 38.1% | +0.10R | 1.23 | 131 | **+0.08R** | 1.18 | EDGE NEGATIVE |
| ETHUSDT | SHORT | 92 | LOW | 51.1% | 28.3% | 20.7% | 45.7% | −0.02R | 0.96 | 106 | **−0.02R** | 0.97 | EDGE NEGATIVE |
| SOLUSDT | LONG | 81 | LOW | 58.0% | 29.6% | 17.3% | 42.0% | +0.07R | 1.15 | 95 | **−0.05R** | 0.91 | STABLE |
| SOLUSDT | SHORT | 66 | LOW | 47.0% | 22.7% | 13.6% | 50.0% | −0.13R | 0.77 | 82 | **−0.14R** | 0.76 | EDGE NEGATIVE |
| SUIUSDT | LONG | 58 | LOW | 58.6% | 34.5% | 22.4% | 41.4% | +0.18R | 1.41 | 79 | **+0.18R** | 1.43 | STABLE |
| SUIUSDT | SHORT | 61 | LOW | 57.4% | 26.2% | 13.1% | 42.6% | +0.05R | 1.10 | 66 | **+0.08R** | 1.17 | EDGE WEAKENING |
| ICPUSDT | LONG | 60 | LOW | 50.0% | 31.7% | 18.3% | 46.7% | +0.02R | 1.04 | 84 | **+0.04R** | 1.07 | EDGE WEAKENING |
| ICPUSDT | SHORT | 54 | LOW | 42.6% | 25.9% | 13.0% | 55.6% | −0.15R | 0.75 | 72 | **−0.02R** | 0.96 | EDGE NEGATIVE |
| BTCUSDT | LONG | 147 | MODERATE | 49.0% | 25.2% | 17.0% | 48.3% | −0.19R | 0.69 | 151 | **−0.26R** | 0.59 | EDGE NEGATIVE |
| BTCUSDT | SHORT | 131 | MODERATE | 43.5% | 22.1% | 13.7% | 53.4% | −0.31R | 0.52 | 161 | **−0.14R** | 0.76 | EDGE NEGATIVE |

Reading this honestly:

* Under conservative costs the engine's edge is **thin to negative** on most pair/direction combinations. Only
  SUIUSDT LONG (+0.18R OOS, PF 1.43, n=79, LOW EVIDENCE) and ETHUSDT LONG (+0.08R OOS, n=131, MODERATE, but recent
  edge NEGATIVE) show a *historically positive out-of-sample expectancy under tested assumptions*, and neither sample
  is large. EIGENUSDT SHORT looks best on paper (+0.24R OOS) but n=38 is VERY LOW EVIDENCE.
* BTCUSDT is negative in both directions — consistent with the app's existing choice to blacklist BTC from autoscan.
* This is exactly what the engine is for: the live panel now shows these numbers with Wilson intervals, and the
  server raises **NO TRADE** reasons where pair-wide or OOS expectancy ≤ 0, so the AI cannot talk a negative-edge
  setup into a trade.

**Measured BTC coupling** (4h log-return correlation vs BTCUSDT; "against BTC" = share of daily closes in the opposite
direction). This replaces the old hard-coded "BTC opposite ⇒ half size / skip" rule, which is now **informational only**:

| Pair | Coupling (90d) | corr all / 90d | beta | Against BTC (all / 90d) | LONG when BTC opposed | SHORT when BTC opposed | Sizing rule from history |
|---|---|---|---|---|---|---|---|
| EIGENUSDT | MODERATE | 0.58 / 0.49 | 1.69 | 27% / **39%** | n=2 | n=9, +0.34R | not supported (n too small) |
| ICPUSDT | MODERATE | 0.61 / 0.54 | 1.23 | 25% / 21% | n=5, +0.56R | n=6 | not supported |
| SUIUSDT | TIGHT | 0.62 / 0.70 | 1.46 | 27% / 21% | n=2 | n=10, −0.45R | not supported |
| SOLUSDT | TIGHT | 0.72 / 0.81 | 1.39 | 21% / 17% | n=4 | n=6 | not supported |
| ETHUSDT | TIGHT | 0.85 / 0.87 | 1.13 | 17% / 10% | n=2 | n=1 | not supported |

EIGENUSDT and ICPUSDT are the pairs in this set that most often trend against BTC (EIGEN closed against BTC on 39 % of
the last 90 days). No pair has enough BTC-opposed setups to justify a sizing rule, so **no pair is written off for
trading against BTC** — BTC context is shown, measured, and left to the trader and the pair's own structure.

## 14. Known remaining weaknesses

0. **Venue mismatch**: the stored history is OKX, execution is Bybit. Perp prices track within a few bps but funding
   schedules and wicks differ; re-run the build from a Bybit-served region (Vercel `sin1`, or `BYBIT_PROXY_URL`) to
   replace it — the pipeline auto-selects Bybit when reachable and the run records its source.
1. **Microstructure coverage**: 1m data is synced for ~3 weeks only, so ambiguity resolution below 5m is unavailable for
   most of the history; those candles resolve at 5m/15m or conservatively as STOP (slightly pessimistic, by design).
2. **Live vs replay input parity**: the live scanner fetches 1m candles for every scan; the replay has 1m only inside its
   synced window, so the 1m vote is `NEUTRAL` for older decisions. `tfCoverage` is stored per trade so this can be filtered.
3. **Regime buckets are coarse** (vol tercile × 1h/4h trend × BTC trend); rare regimes fall back to pair-wide with a warning.
4. **Similarity is a hand-weighted distance**, not learned; correlated indicators are down-weighted but not orthogonalised.
5. **Daily-loss accounting for paper mode** relies on KV counters (no realised PnL feed); live mode uses Bybit closed-PnL.
6. **Serverless management**: limit-entry protection depends on the client polling `/api/trade/manage` (or a future cron);
   a browser closed mid-fill leaves the stop attached to the order but TPs unplaced until the next poll.
7. **Supabase reads at scan time** pull all replayed trades for the pair (paginated, cached 10 min per lambda). Fine for
   a few thousand trades; large multi-year 1h histories may want a columnar cache.
8. **`hist_*` reads are public** (anon SELECT). They contain only market-derived statistics, no user data.
9. Funding-rate soft rejection stores the response for 120 s; a forced retry must use a new `tradeId` (the UI does this).

## 15. Safety assessment

| Environment | Verdict |
|---|---|
| Development | **Safe.** Default is paper; no credentials required; file store available. |
| Paper trading | **Safe.** Same code path as live for sizing, limits and idempotency, no exchange calls. |
| Small live testing | **Conditionally safe** — only after (a) `npm run check` passes, (b) history exists for the pair (six pairs are loaded; prefer a Bybit-sourced rebuild), (c) `TRADING_MODE=live`, `TRADE_AUTH_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` are set, and (d) the first orders are placed on **testnet** (`BYBIT_TESTNET=true`) to exercise fill reconciliation, stop verification and the manage state machine against a real matching engine. None of the exchange calls in `bybitPrivate.ts` were executed against Bybit from this environment. |
| Full live deployment | **Not yet.** Out-of-sample evidence is thin-to-negative for most pairs (§13); the execution layer is unit-tested against a fake exchange only. |

## Checks run

`npm run typecheck` (clean), `npm run lint` (0 errors; 8 warnings, pre-existing style), `npm test` (11 files, 58 tests
passing), `npm run build` (production build succeeds). Real-data pipeline run: 6 pairs, ~1.2 M candles, 4,638
replayed trades, uploaded to Supabase and verified readable through `/api/evidence`.
