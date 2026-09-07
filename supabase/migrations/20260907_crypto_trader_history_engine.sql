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

-- ── 2026-09-07 (2): source tracking + token-guarded write RPCs ─────────────────────────────
-- Writes without a service-role key go through SECURITY DEFINER functions that verify
-- sha256(HISTORY_WRITE_TOKEN) against a private hist_config row (no anon policy on hist_config).
create extension if not exists pgcrypto with schema extensions;
alter table public.hist_sync_state add column if not exists source text;
alter table public.hist_backtest_runs add column if not exists source text;
create table if not exists public.hist_config (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.hist_config enable row level security;
-- insert into public.hist_config (key, value) values ('write_token_sha256', encode(extensions.digest('<HISTORY_WRITE_TOKEN>', 'sha256'), 'hex'));
create or replace function public.hist_check_token(p_token text) returns boolean
language sql security definer set search_path = public, extensions as $$
  select exists (select 1 from public.hist_config where key = 'write_token_sha256' and value = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex'));
$$;
create or replace function public.hist_upsert(p_token text, p_table text, p_rows jsonb) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare v_pk text; v_set text; v_n integer;
begin
  if not public.hist_check_token(p_token) then raise exception 'invalid history write token'; end if;
  v_pk := case p_table when 'hist_candles' then 'symbol, timeframe, time' when 'hist_sync_state' then 'symbol, timeframe' when 'hist_funding' then 'symbol, time'
    when 'hist_backtest_runs' then 'symbol' when 'hist_backtest_trades' then 'symbol, time, direction' else null end;
  if v_pk is null then raise exception 'table % not allowed', p_table; end if;
  select string_agg(format('%I = excluded.%I', column_name, column_name), ', ') into v_set from information_schema.columns
   where table_schema = 'public' and table_name = p_table and column_name not in (select trim(x) from unnest(string_to_array(v_pk, ',')) x) and column_name not in ('created_at');
  execute format('insert into public.%I select * from jsonb_populate_recordset(null::public.%I, $1) on conflict (%s) do update set %s', p_table, p_table, v_pk, v_set) using p_rows;
  get diagnostics v_n = row_count; return v_n;
end $$;
create or replace function public.hist_delete_backtest_trades(p_token text, p_symbol text) returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if not public.hist_check_token(p_token) then raise exception 'invalid history write token'; end if;
  delete from public.hist_backtest_trades where symbol = p_symbol; get diagnostics v_n = row_count; return v_n;
end $$;
revoke all on function public.hist_check_token(text) from public;
grant execute on function public.hist_upsert(text, text, jsonb) to anon, authenticated;
grant execute on function public.hist_delete_backtest_trades(text, text) to anon, authenticated;
