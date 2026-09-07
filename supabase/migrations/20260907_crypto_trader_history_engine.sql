-- 4SCANS historical edge engine (namespaced hist_*). Writes are service-role only; anon may read stats/candles.
-- Applied to project mrhekpgvfcwfnzmipjis on 2026-09-07. Kept here for reproducibility.
create table if not exists public.hist_candles (
  symbol text not null, timeframe text not null, time bigint not null,
  open double precision not null, high double precision not null, low double precision not null, close double precision not null,
  volume double precision not null default 0, turnover double precision,
  created_at timestamptz not null default now(),
  primary key (symbol, timeframe, time)
);
create index if not exists hist_candles_sym_tf_time on public.hist_candles (symbol, timeframe, time desc);
create table if not exists public.hist_sync_state (
  symbol text not null, timeframe text not null, first_time bigint not null, last_time bigint not null,
  count integer not null default 0, updated_at timestamptz not null default now(), primary key (symbol, timeframe)
);
create table if not exists public.hist_funding (symbol text not null, time bigint not null, rate double precision not null, primary key (symbol, time));
create table if not exists public.hist_backtest_runs (
  symbol text primary key, version integer not null default 1, built_at timestamptz not null default now(),
  config jsonb not null, coverage jsonb not null default '{}'::jsonb, decisions integer not null default 0,
  neutral_decisions integer not null default 0, skipped_while_open integer not null default 0,
  feature_norms jsonb not null default '{}'::jsonb, stats jsonb not null
);
create table if not exists public.hist_backtest_trades (
  symbol text not null, time bigint not null, direction text not null, setup_style text not null, score integer not null,
  first_outcome text not null, tp1_hit boolean not null, tp2_hit boolean not null, tp3_hit boolean not null, stop_hit boolean not null,
  net_r double precision not null, gross_r double precision not null, mfe_r double precision not null, mae_r double precision not null,
  hold_ms bigint not null, regime_key text not null, payload jsonb not null, primary key (symbol, time, direction)
);
create index if not exists hist_bt_trades_sym_dir on public.hist_backtest_trades (symbol, direction, time);
create table if not exists public.hist_kv (key text primary key, value jsonb not null, expires_at timestamptz, updated_at timestamptz not null default now());
alter table public.hist_candles enable row level security;
alter table public.hist_sync_state enable row level security;
alter table public.hist_funding enable row level security;
alter table public.hist_backtest_runs enable row level security;
alter table public.hist_backtest_trades enable row level security;
alter table public.hist_kv enable row level security;
create policy hist_candles_read on public.hist_candles for select to anon, authenticated using (true);
create policy hist_sync_read on public.hist_sync_state for select to anon, authenticated using (true);
create policy hist_funding_read on public.hist_funding for select to anon, authenticated using (true);
create policy hist_runs_read on public.hist_backtest_runs for select to anon, authenticated using (true);
create policy hist_bt_trades_read on public.hist_backtest_trades for select to anon, authenticated using (true);
-- hist_kv: no anon policy (execution state + idempotency). Service role bypasses RLS.
