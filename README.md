# 4SCANS historical edge and execution

The scanner evaluates each pair and style separately. It compares LONG and SHORT histories, then applies minimum sample and walk-forward expectancy gates. A tie or insufficient evidence remains NEUTRAL / NO TRADE. Technical context never increases leverage.

## Run

Use Node 20.9+ and run `npm ci`, `npm test`, `npm run build`, then `npm start`. `npm run dev` starts development. `npm run lint` checks TypeScript.

Scan settings: symbol, SCALP (5m), INTRADAY (1h), SWING (4h), account capital, dollar-risk percentage, and user-selected leverage. The dashboard and trader commentary use the same calculated figures. Commentary is deterministic; it does not claim to be an actual trader or a language-model prediction.

## What the statistics mean

- The initial history fetch is bounded to 5,000 closed candles per symbol/style, not the pair's all-time history. The dashboard states the observed date range. There is a 200-candle feature window, 100-candle warm-up, and a complete future horizon requirement.
- Setup features: RSI, ATR percentage, volatility percentile, volume ratio, session VWAP distance, MACD/ATR momentum, trend, swing location, BOS, CHoCH, FVG, OB, sweeps and 24-hour change. Similarity groups correlated price features instead of counting each as an independent confirmation.
- Entry is the next candle open. Stop is 1.3/2.5/5 ATR by style. Targets are 1R/2R/3R, with 50/25/25 exits. Unfilled remainders exit at 24/24/42 bars. No breakeven or trailing-stop assumptions.
- Simulated trades do not overlap within a direction. LONG and SHORT are separate hypothetical books and must not be summed as an account equity curve. Drawdown and streaks refer to the displayed sample.
- Features only see closed bars at the decision time. Only previously completed records enter each walk-forward decision. A candle touching stop and target resolves stop first. Gap stops fill at the worse open. Missing candles exclude affected samples. MFE/MAE are candle-resolution excursion estimates; intrabar extrema may occur after an exit.
- Walk-forward selection uses at least 50 previously completed comparable records and positive historical expectancy. Its results are reported separately from the retrospective closest-match statistics. No parameter optimization occurs. Current selection additionally requires 20 walk-forward selected outcomes with positive expectancy, an effective recency sample of 20, and positive comparable expectancy. The outcome remains a review candidate, never automatic execution.
- Raw frequencies use all completed outcomes, including timeouts in their denominator. The 95% Wilson interval describes the unweighted TP1 frequency. Recency-weighted frequency and effective sample size are separate. These intervals do not establish independence or calibrated future probabilities.
- Both entry and exits assume 0.055% taker fees and 0.05% slippage. Partial exit costs are quantity-weighted. These are explicit modeling assumptions, not verified account-specific fees. Historical funding, BTC regime, cross-timeframe feature snapshots and order-book liquidity are currently unavailable and identified in the UI. Historical expectancy is therefore **before funding**, not fully net profitability.
- Scans write feature/outcome records to a versioned pair/style JSON cache and append complete decision snapshots to `signals.jsonl`. The cache refreshes on the style interval. Without `TRADING_DATA_DIR`, storage is ephemeral. There is no claim that local files persist across serverless instances.

## Execution contract

`POST /api/trade` defaults to paper preview. It does not need private exchange credentials in paper mode. Paper previews are journaled as previews, never as fills.

Live mode requires `TRADING_MODE=live`, Bybit credentials, `TRADE_API_TOKEN` sent as `Authorization: Bearer ...`, and `TRADING_DATA_DIR` on a persistent shared filesystem. Defaults: `MAX_RISK_PCT=1`. Use `BYBIT_TESTNET=true` for testnet; market data and execution then use the same environment.

Send symbol, direction, entry, stopLoss, tp1, tp2, tp3, riskPct, leverage, optional userLeverage, orderType (Market or Limit), and a unique requestId of 8–30 ASCII letters/digits/dashes/underscores. Paper mode also accepts capital (default 5000).

Quantity derives from the stop loss plus estimated fees, slippage and one adverse funding charge. Leverage caps required margin; it does not multiply risk. The risk budget uses unified-account total equity and available margin. Account modes with unavailable values fail closed. Exchange tick and lot rules apply; minimums never cause size to be rounded upward.

Only a flat one-way symbol without existing orders is supported. Entries are IOC (including limit entries), so pending maker entries are not supported. Partial fills are reconciled using actual size and average price. The position stop is set and read back. TP1/TP2/TP3 are separate reduce-only limits with a 50/25/25 quantity split; every status is checked. Actual liquidation price is checked when the exchange supplies it.

Failures after an entry attempt trigger cancellation and a reduce-only close attempt. `CLOSED_AFTER_FAILURE` means terminal entry and flat position were confirmed. `REQUIRES_ATTENTION` means they were not; it never claims an unverified close succeeded. A fill beyond the planned risk/margin is closed instead of silently accepted.

A durable request lock prevents reuse; a durable symbol lock prevents concurrent/repeated execution. Symbol locks intentionally survive both success and failure. Before removing `symbol-<SYMBOL>.lock`, the operator must reconcile terminal entry, all fills, orders and position directly at Bybit. Do not remove request locks. This implementation supports a single execution account with shared storage, not isolated serverless disks or multiple accounts.

The journal records request and reconciliation results. It is not yet a continuous exchange fill/funding ledger or a durable post-response order monitor. Attached exchange stops remain active, but future exchange-side order cancellations are not monitored by this process. No live orders were used in development. Testnet acceptance, including partial fills, delayed status, rejected stops, and emergency-close behavior, remains required before production use.

## Background scans

`/api/cron/scan` requires `Authorization: Bearer $CRON_SECRET`. It evaluates up to three liquid pairs within a bounded request, records failures, and sends configured push notifications only for historically qualified review candidates. Cold historical backfills need a deployment allowing a 60-second request. Large-universe backfills and continuous execution monitoring require a persistent worker.

## Verification

`npm test` exercises risk/leverage invariance, costs, instrument minimums, neutral rejection, ambiguous candles, gap stops, staged fees, timeouts, future-data invariance, Wilson intervals, signing payloads, staged order confirmation and failed-order recovery. Type checking and the Next production build pass. Read-only EIGENUSDT, ETHUSDT and SOLUSDT scans were also exercised against Bybit; no exchange mutations were performed.

API references: [signing](https://bybit-exchange.github.io/docs/v5/guide), [orders](https://bybit-exchange.github.io/docs/v5/order/create-order), [position stops](https://bybit-exchange.github.io/docs/v5/position/trading-stop), [instrument rules](https://bybit-exchange.github.io/docs/v5/market/instrument), [wallet balance](https://bybit-exchange.github.io/docs/v5/account/wallet-balance).
