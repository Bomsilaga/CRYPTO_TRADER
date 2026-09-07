/**
 * kv.ts — small key/value store for idempotency records, daily counters and
 * execution state. Supabase hist_kv (service role) when available, else memory.
 * Memory is per-process and NOT durable across serverless invocations —
 * live execution refuses to run without a durable store (see auth.ts).
 */
export interface KV {
  durable: boolean;
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  incr(key: string, by?: number, ttlSeconds?: number): Promise<number>;
  /** Atomically claim a key. Returns false if already claimed. */
  claim(key: string, value: unknown, ttlSeconds?: number): Promise<boolean>;
}

export class MemoryKV implements KV {
  durable = false;
  private m = new Map<string, { v: unknown; exp: number | null }>();
  private live(key: string) { const e = this.m.get(key); if (!e) return null; if (e.exp && e.exp < Date.now()) { this.m.delete(key); return null; } return e; }
  async get<T>(key: string) { return (this.live(key)?.v as T) ?? null; }
  async set(key: string, value: unknown, ttl?: number) { this.m.set(key, { v: value, exp: ttl ? Date.now() + ttl * 1000 : null }); }
  async incr(key: string, by = 1, ttl?: number) { const cur = Number((await this.get<number>(key)) ?? 0) + by; await this.set(key, cur, ttl); return cur; }
  async claim(key: string, value: unknown, ttl?: number) { if (this.live(key)) return false; await this.set(key, value, ttl); return true; }
}

export class SupabaseKV implements KV {
  durable = true;
  constructor(private url: string, private key: string, private fetchImpl: typeof fetch = fetch) {}
  private h(extra: Record<string, string> = {}) { return { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...extra }; }
  async get<T>(key: string) {
    const res = await this.fetchImpl(`${this.url}/rest/v1/hist_kv?key=eq.${encodeURIComponent(key)}&select=value,expires_at`, { headers: this.h(), cache: 'no-store' });
    if (!res.ok) throw new Error(`KV get ${res.status}`);
    const rows = await res.json() as { value: T; expires_at: string | null }[];
    const r = rows[0];
    if (!r) return null;
    if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) return null;
    return r.value;
  }
  async set(key: string, value: unknown, ttl?: number) {
    const res = await this.fetchImpl(`${this.url}/rest/v1/hist_kv?on_conflict=key`, {
      method: 'POST', headers: this.h({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([{ key, value, expires_at: ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null, updated_at: new Date().toISOString() }]),
    });
    if (!res.ok) throw new Error(`KV set ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  async incr(key: string, by = 1, ttl?: number) { const cur = Number((await this.get<number>(key)) ?? 0) + by; await this.set(key, cur, ttl); return cur; }
  async claim(key: string, value: unknown, ttl?: number) {
    // plain insert (no merge) → 409 on duplicate primary key
    const res = await this.fetchImpl(`${this.url}/rest/v1/hist_kv`, {
      method: 'POST', headers: this.h({ Prefer: 'return=minimal' }),
      body: JSON.stringify([{ key, value, expires_at: ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null }]),
    });
    if (res.status === 409) return false;
    if (!res.ok) throw new Error(`KV claim ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return true;
  }
}

let mem: MemoryKV | null = null;
export function getKV(): KV {
  const url = process.env.SUPABASE_URL ?? 'https://mrhekpgvfcwfnzmipjis.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (key) return new SupabaseKV(url, key);
  return mem ??= new MemoryKV();
}
