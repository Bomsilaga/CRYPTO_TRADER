import { describe, it, expect } from 'vitest';
import { authorizeExecution, authorizeCron, authorizeAdmin } from '../src/lib/auth';

const TOKEN = 'a-very-long-execution-token-123';
const h = (t?: string) => new Headers(t ? { 'x-4scans-auth': t } : {});

describe('execution authorization', () => {
  it('live requires server mode + token + client flag + durable kv', () => {
    const env = { TRADING_MODE: 'live', TRADE_AUTH_TOKEN: TOKEN };
    expect(authorizeExecution(h(TOKEN), { liveMode: true }, env, true).mode).toBe('live');
    expect(authorizeExecution(h(TOKEN), { liveMode: true }, env, false).mode).toBe('paper');
    expect(authorizeExecution(h(TOKEN), { liveMode: false }, env, true).mode).toBe('paper');
    expect(authorizeExecution(h('wrong-token-wrong-token'), { liveMode: true }, env, true).mode).toBe('paper');
    expect(authorizeExecution(h(), { liveMode: true }, env, true).mode).toBe('paper');
  });
  it('client liveMode alone can never enable live', () => {
    const r = authorizeExecution(h(TOKEN), { liveMode: true }, { TRADE_AUTH_TOKEN: TOKEN }, true);
    expect(r.mode).toBe('paper');
    expect(r.reasons.join()).toMatch(/TRADING_MODE/);
    const noToken = authorizeExecution(h(), { liveMode: true }, { TRADING_MODE: 'live' }, true);
    expect(noToken.mode).toBe('paper');
    expect(noToken.reasons.join()).toMatch(/TRADE_AUTH_TOKEN/);
  });
  it('short tokens are rejected', () => {
    expect(authorizeExecution(h('short'), { liveMode: true }, { TRADING_MODE: 'live', TRADE_AUTH_TOKEN: 'short' }, true).mode).toBe('paper');
  });
  it('cron requires the configured secret via bearer header; unset secret rejects everything', () => {
    const env = { CRON_SECRET: 'cron-secret-that-is-long-enough' };
    expect(authorizeCron(new Headers({ authorization: 'Bearer cron-secret-that-is-long-enough' }), env)).toBe(true);
    expect(authorizeCron(new Headers({ authorization: 'Bearer nope' }), env)).toBe(false);
    expect(authorizeCron(new Headers(), env)).toBe(false);
    expect(authorizeCron(new Headers({ authorization: 'Bearer anything' }), {})).toBe(false);
  });
  it('admin falls back to the execution token', () => {
    expect(authorizeAdmin(h(TOKEN), { TRADE_AUTH_TOKEN: TOKEN })).toBe(true);
    expect(authorizeAdmin(h(TOKEN), { ADMIN_TOKEN: 'another-admin-token-value', TRADE_AUTH_TOKEN: TOKEN })).toBe(false);
  });
});
