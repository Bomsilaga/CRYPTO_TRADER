/**
 * telegram.ts — Telegram Bot API delivery for viable setups.
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Messages use HTML parse mode.
 */
export interface TelegramConfig { token: string; chatId: string }

export function telegramConfig(env: Record<string, string | undefined> = process.env): TelegramConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN, chatId = env.TELEGRAM_CHAT_ID;
  return token && chatId ? { token, chatId } : null;
}

export async function sendTelegram(text: string, cfg: TelegramConfig | null = telegramConfig(), fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; error?: string }> {
  if (!cfg) return { ok: false, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured' };
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const j = await res.json().catch(() => ({})) as { ok?: boolean; description?: string };
    return j.ok ? { ok: true } : { ok: false, error: j.description ?? `HTTP ${res.status}` };
  } catch (e) { return { ok: false, error: String(e) }; }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const px = (v: number) => v < 1 ? v.toFixed(6) : v < 100 ? v.toFixed(4) : v.toFixed(2);
const R = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}R`;

export interface AlertCard {
  symbol: string; direction: 'LONG' | 'SHORT'; price: number; score: number; style: string;
  entry: number; entryMode: string; entryStatus: string; entryBasis: string; entryKinds: string[]; entryTfs: string[]; confirmation: { pattern: string; tf: string } | null;
  stop: number; stopBasis: string; tp1: number; tp2: number; tp3: number; rTp1: number; rTp2: number; rTp3: number; targetBasis: string[];
  leverage: number;
  evidence?: { pairN: number; pairQuality: string; pairTp1: number; pairExp: number; oosN: number; oosExp: number; oosPf: number; similarN?: number; similarExp?: number; similarTp1?: number; source?: string; decay?: string; btcCoupling?: string; btcAgainstPct?: number } | null;
  risk?: { capital: number; riskUsd: number; notional: number; margin3x: number; margin5x: number; netStop: number; netTp1: number; netTp2: number; netStaged: number } | null;
  reasonsPassed: string[];
  appUrl?: string;
}

export function formatAlert(a: AlertCard): string {
  const arrow = a.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const slPct = Math.abs(a.entry - a.stop) / a.entry * 100;
  const lines = [
    `<b>4SCANS · ${esc(a.symbol.replace('USDT', ''))} ${arrow}</b>  <i>${esc(a.style)} · score ${a.score}</i>`,
    `Price ${px(a.price)}`,
    ``,
    `<b>ENTRY ${esc(a.entryMode)} ${esc(a.entryStatus.replace(/_/g, ' '))} @ ${px(a.entry)}</b>`,
    `${esc(a.entryKinds.join('+') || 'ATR')} ${esc(a.entryTfs.join('/'))}${a.confirmation ? ` · ${esc(a.confirmation.pattern.toLowerCase().replace('_', ' '))} on ${esc(a.confirmation.tf)}` : ''}`,
    `<i>${esc(a.entryBasis)}</i>`,
    ``,
    `🛑 Stop ${px(a.stop)} (${slPct.toFixed(2)}%) — ${esc(a.stopBasis)}`,
    `🎯 TP1 ${px(a.tp1)} (${a.rTp1.toFixed(1)}R) · TP2 ${px(a.tp2)} (${a.rTp2.toFixed(1)}R) · TP3 ${px(a.tp3)} (${a.rTp3.toFixed(1)}R)`,
    `<i>${esc(a.targetBasis[0])}</i>`,
    `Exits 50/25/25 · stop to entry after TP1 · leverage ≤ ${a.leverage}×`,
  ];
  if (a.evidence) {
    const e = a.evidence;
    lines.push(``, `<b>HISTORY</b> (${esc(e.source ?? 'bybit')} replay, net of costs)`);
    lines.push(`Pair: n=${e.pairN} [${esc(e.pairQuality)}] TP1 ${(e.pairTp1 * 100).toFixed(0)}% · exp ${R(e.pairExp)}`);
    lines.push(`OOS: n=${e.oosN} · exp ${R(e.oosExp)} · PF ${e.oosPf.toFixed(2)}`);
    if (e.similarN !== undefined && e.similarExp !== undefined) lines.push(`Closest ${e.similarN}: TP1 ${((e.similarTp1 ?? 0) * 100).toFixed(0)}% · exp ${R(e.similarExp)}`);
    if (e.decay) lines.push(`Recent edge: ${esc(e.decay)}`);
    if (e.btcCoupling) lines.push(`BTC coupling: ${esc(e.btcCoupling)}${e.btcAgainstPct !== undefined ? ` · against BTC ${(e.btcAgainstPct * 100).toFixed(0)}% of days` : ''}`);
  }
  if (a.risk) {
    const r = a.risk;
    const $ = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(0)}`;
    lines.push(``, `<b>ACCOUNT</b> ${$(r.capital)} · risk ${$(r.riskUsd)} · notional ${$(r.notional)} · margin @3× ${$(r.margin3x)} / @5× ${$(r.margin5x)}`);
    lines.push(`Net: stop ${$(r.netStop)} · TP1 ${$(r.netTp1)} · TP2 ${$(r.netTp2)} · staged ${$(r.netStaged)}`);
  }
  lines.push(``, `✅ ${esc(a.reasonsPassed.join(' · '))}`);
  if (a.appUrl) lines.push(`<a href="${a.appUrl}?symbol=${a.symbol}">Open in 4SCANS</a>`);
  return lines.join('\n');
}
