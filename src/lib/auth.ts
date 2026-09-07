/**
 * auth.ts — server-side authorization for execution, admin and cron routes.
 *
 * LIVE trading requires ALL of:
 *   1. process.env.TRADING_MODE === 'live'
 *   2. a valid execution token (TRADE_AUTH_TOKEN) presented by the client
 *   3. the request explicitly asking for live (liveMode: true)
 *   4. a durable KV (idempotency + daily limits) — memory-only is refused
 * Anything else executes PAPER. A client flag alone can never enable live.
 */
import { timingSafeEqual } from 'crypto';

export type Env = Record<string, string | undefined>;

export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a), bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function presentedToken(headers: Headers): string | null {
  const x = headers.get('x-4scans-auth');
  if (x) return x.trim();
  const auth = headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

export interface ExecutionAuth {
  authenticated: boolean;
  live: boolean;
  mode: 'paper' | 'live';
  reasons: string[];       // why live was refused (if it was)
}

export function authorizeExecution(headers: Headers, body: { liveMode?: unknown }, env: Env = process.env, kvDurable = false): ExecutionAuth {
  const reasons: string[] = [];
  const token = env.TRADE_AUTH_TOKEN;
  const authenticated = !!token && token.length >= 16 && safeEqual(presentedToken(headers), token);
  if (!token) reasons.push('TRADE_AUTH_TOKEN is not configured on the server');
  else if (!authenticated) reasons.push('missing or invalid execution token');
  const serverLive = env.TRADING_MODE === 'live';
  if (!serverLive) reasons.push('server TRADING_MODE is not "live"');
  const clientLive = body.liveMode === true;
  if (!clientLive) reasons.push('request did not ask for live execution');
  if (!kvDurable) reasons.push('no durable KV store (SUPABASE_SERVICE_ROLE_KEY) for idempotency and daily limits');
  const live = authenticated && serverLive && clientLive && kvDurable;
  return { authenticated, live, mode: live ? 'live' : 'paper', reasons: live ? [] : reasons };
}

/** Admin/maintenance routes (history build). Uses ADMIN_TOKEN, falling back to TRADE_AUTH_TOKEN. */
export function authorizeAdmin(headers: Headers, env: Env = process.env): boolean {
  const token = env.ADMIN_TOKEN || env.TRADE_AUTH_TOKEN;
  return !!token && token.length >= 16 && safeEqual(presentedToken(headers), token);
}

/** Vercel cron sends `Authorization: Bearer $CRON_SECRET`. Unset secret ⇒ always rejected. */
export function authorizeCron(headers: Headers, env: Env = process.env): boolean {
  const secret = env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  return safeEqual(presentedToken(headers), secret);
}
