# 4SCANS — Historical Edge Engine: Developer Validation Report

Branch: `claude/historical-edge-engine` · Date: 2026-09-07

This report describes what was built, what was verified, and — importantly — what was **not** verified. No historical
statistic in this document is a market result. The exchange was not reachable from the build environment
(see §6), so the only replay executed end-to-end ran on deterministic **synthetic** candles to validate the pipeline.

---

## 1. Files changed / added

| Area | Files |
|---|---|
| Security + execution | `src/lib/auth.ts` (new), `src/lib/kv.ts` (new), `src/lib/risk/limits.ts` (new), `src/lib/risk/riskModel.ts` (new), `src/lib/bybitPrivate.ts` (new), `src/lib/execution.ts` (new), `src/app/api/trade/route.ts` (rewritten), `src/app/api/trade/manage/route.ts` (new), `src/app/api/cron/scan/route.ts` (auth added) |
| Historical engine | `src/lib/history/{types,bybitHistory,resample,store,sync,features,costs,outcome,backtest,stats,similarity,evidence,pipeline}.ts` (new), `supabase/migrations/20260907_crypto_trader_history_engine.sql` (new, applied), `scripts/history-build.ts` (new) |
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

Bybit V5 public REST (`/v5/market/kline`, `/v5/market/funding/history`, category `linear`) — the same venue the app
executes on. Paging is backward with `end`, 1000 candles per call, 120 ms inter-request gap, exponential backoff on
429/5xx, de-duplicated by open time. `BYBIT_PROXY_URL` is honoured for blocked regions. Sync is incremental
(`hist_sync_state.last_time`); a re-run fetches only closed candles newer than the last stored one.

Depth targets (first backfill): 1m 3 weeks · 5m ~9 months · 15m ~13 months · 1h 3 years · 4h 5 years · 1d 10 years
(the exchange returns whatever exists; listing date bounds younger pairs such as EIGENUSDT).

## 6. Number of candles available per pair/timeframe

**Not measured.** `api.bybit.com` answers every request from this build environment with
`The Amazon CloudFront distribution is configured to block access from your country`. No candle was downloaded and no
market replay was run. The storage tables were created (migration applied to Supabase project `mrhekpgvfcwfnzmipjis`)
but contain **zero rows**. To populate them run, from a region Bybit serves (the app's Vercel region `sin1` works, or
any machine with `BYBIT_PROXY_URL`):

```
SUPABASE_SERVICE_ROLE_KEY=… npm run history:build -- EIGENUSDT ETHUSDT SOLUSDT BTCUSDT SUIUSDT
# or: Setup → Historical Edge Engine → "Build history for <pair>" (needs the execution token)
```

The script prints fetched/stored counts per timeframe and the per-direction statistics after replay. The pagination
arithmetic was verified with a fake server: 2,500 candles → 3 requests, no duplicates, ascending order.

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

**None from market data** (§6). The synthetic-market run used by the test-suite (`tests/backtest.test.ts`) exercises
the full pipeline — decisions, neutral handling, one-at-a-time, cost subtraction, MFE/MAE, walk-forward and evidence
assembly — but its numbers are meaningless for trading and are deliberately not reported here. The correct sentence to
use once real data exists, if and only if the data supports it, is: *"historically positive out-of-sample expectancy
under tested assumptions"*.

## 14. Known remaining weaknesses

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
| Small live testing | **Conditionally safe** — only after (a) `npm run check` passes, (b) history has been built for the pair from a served region, (c) `TRADING_MODE=live`, `TRADE_AUTH_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` are set, and (d) the first orders are placed on **testnet** (`BYBIT_TESTNET=true`) to exercise fill reconciliation, stop verification and the manage state machine against a real matching engine. None of the exchange calls in `bybitPrivate.ts` were executed against Bybit from this environment. |
| Full live deployment | **Not yet.** No out-of-sample market evidence exists; the execution layer is unit-tested against a fake exchange only. |

## Checks run

`npm run typecheck` (clean), `npm run lint` (0 errors; 7 pre-existing warnings), `npm test` (10 files, 53 tests
passing), `npm run build` (production build succeeds).
