'use client';

import { useState, useEffect } from 'react';

/* ─── Types ──────────────────────────────────────────────────────────────── */

type AiProvider = 'claude' | 'openai' | 'deepseek';

interface AutoScanAlert {
  symbol: string;
  score: number;
  direction: string;
  tier: string;
}

interface AutoScanResult {
  ok: boolean;
  timestamp?: string;
  scanned?: number;
  elapsed?: number;
  alerts?: AutoScanAlert[];
  timedOut?: boolean;
  message?: string;
}

interface ScanResult {
  ok: boolean;
  symbol: string;
  price: number;
  change24h: number;
  direction: string;
  totalScore: number;
  confidence: number;
  alignmentScore: number;
  alignmentQuality: string;
  bestSetup: string;
  verdict: string;
  masterSignal: {
    entry: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    tp3: number;
    leverage: number;
    leverageWarning?: string;
    netRR: number;
    signalText: string;
  };
  deep: {
    rsi: number;
    wyckoffPhase: string;
    hasBOS: boolean;
    hasOB: boolean;
    hasFVG: boolean;
    hasChoCH: boolean;
    hasSweep: boolean;
    macdBull: boolean;
    macdBear: boolean;
    vwapAbove: boolean;
    volRatio: number;
  };
  avgMoves?: { daily: number; h8: number; h4: number };
  spotAvgMoves?: { daily: number; h8: number; h4: number } | null;
  error?: string;
}

interface TradeResult {
  paper?: boolean;
  success?: boolean;
  rejected?: boolean;
  error?: string;
  message?: string;
  reason?: string;
  leverageWarning?: string;
  orderId?: string;
  qty?: number;
  balance?: string;
  riskAmt?: string;
  fundingChecked?: boolean;
  feeEstimate?: {
    totalFee: string;
    entryFee?: string;
    exitFee?: string;
    note?: string;
  };
  simulated?: {
    symbol: string;
    direction: string;
    entry: number;
    stopLoss: number;
    tp1: number;
    leverage: number;
    riskPct: number;
  };
}

interface MarketTicker {
  symbol:    string;
  price:     number;
  change24h: number;
  volume24h: number;
}

interface RadarSignal {
  symbol:    string;
  price:     number;
  change24h: number;
  volume24h: number;
  direction: 'LONG' | 'SHORT';
  signals:   string[];
  reason:    string;
  score:     number;
}

interface RadarResult {
  ok:      boolean;
  count:   number;
  scanned: number;
  elapsed: number;
  signals: RadarSignal[];
  error?:  string;
}

interface HourlyCandle {
  hour: string;   // ISO hour bucket e.g. "2026-06-30T10:00:00Z"
  open: number;
  high: number;
  low: number;
  close: number;
}

interface FullAnalysisSnapshot {
  direction: string;
  totalScore: number;
  confidence: number;
  alignmentScore: number;
  alignmentQuality: string;
  verdict: string;
  signalText: string;
  leverageWarning?: string;
  deep: ScanResult['deep'];
  avgMoves?: { daily: number; h8: number; h4: number };
  spotAvgMoves?: { daily: number; h8: number; h4: number } | null;
}

interface TradeEntry {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  leverage: number;
  riskPct: number;
  orderType: 'Market' | 'Limit';
  mode: 'paper' | 'live';
  timestamp: string;
  timezone: string;
  score: number;
  confidence: number;
  bestSetup: string;
  netRR: number;
  qty: number;
  positionNotional: number;
  marginUsed: number;
  status: 'open' | 'tp3' | 'sl' | 'manual';
  exitPrice?: number;
  pnlDollars?: number;
  orderId?: string;
  // TP milestone tracking — set automatically, trade stays open until TP3 or SL
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  tp3Hit?: boolean;
  // Extended for log + sync
  notes?: string;
  highestPrice?: number;
  lowestPrice?: number;
  hourlyCandles?: HourlyCandle[];
  fullAnalysis?: FullAnalysisSnapshot;
}

const TIMEZONES = [
  { label: 'UTC',                    value: 'UTC'                   },
  { label: 'New York (EST/EDT)',      value: 'America/New_York'      },
  { label: 'Chicago (CST/CDT)',       value: 'America/Chicago'       },
  { label: 'Los Angeles (PST/PDT)',   value: 'America/Los_Angeles'   },
  { label: 'London (GMT/BST)',        value: 'Europe/London'         },
  { label: 'Frankfurt (CET/CEST)',    value: 'Europe/Berlin'         },
  { label: 'Dubai (GST+4)',           value: 'Asia/Dubai'            },
  { label: 'Singapore (SGT+8)',       value: 'Asia/Singapore'        },
  { label: 'Tokyo (JST+9)',           value: 'Asia/Tokyo'            },
  { label: 'Hong Kong (HKT+8)',       value: 'Asia/Hong_Kong'        },
  { label: 'Melbourne (AEST/AEDT)',   value: 'Australia/Melbourne'   },
  { label: 'Sydney (AEST/AEDT)',      value: 'Australia/Sydney'      },
];

/* ─── Risk Calculator ───────────────────────────────────────────────────── */

function RiskCalculator() {
  const [accountSize, setAccountSize] = useState(2000);
  const [leverage, setLeverage] = useState(3);
  const [riskPct, setRiskPct] = useState(1);
  const [spotTargetPct, setSpotTargetPct] = useState(1);
  const [orderTypeCalc, setOrderTypeCalc] = useState<'limit' | 'market'>('limit');
  const [dailyTarget, setDailyTarget] = useState(100);

  const position = accountSize * leverage;
  const riskDollars = accountSize * (riskPct / 100);
  const grossProfit = position * (spotTargetPct / 100);
  const takerFee = 0.00055;
  const makerFee = 0.00020;
  const entryFee = position * (orderTypeCalc === 'limit' ? makerFee : takerFee);
  const exitFee  = position * takerFee; // exit is always taker for speed
  const totalFee = entryFee + exitFee;
  const netProfit = grossProfit - totalFee;
  // Bybit isolated margin liq formula: distance = 1/leverage - MMR
  // Standard MMR for retail positions < $500k notional = 0.5%
  const MMR = 0.005;
  const liquidationPct = Math.max(0, (1 / leverage - MMR) * 100).toFixed(1);
  const tradesNeeded = netProfit > 0 ? Math.ceil(dailyTarget / netProfit) : '∞';
  const feeSavingVsMarket = orderTypeCalc === 'limit'
    ? (position * (takerFee - makerFee)).toFixed(2)
    : '0.00';

  const row = (label: string, value: string, color?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--c-border)' }}>
      <span style={{ color: 'var(--c-dim)', fontSize: 12 }}>{label}</span>
      <span style={{ color: color ?? 'var(--c-text)', fontSize: 12, fontWeight: 600 }}>{value}</span>
    </div>
  );

  return (
    <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--c-muted)', marginBottom: 14 }}>📐 POSITION CALCULATOR</div>

      {/* Inputs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div>
          <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 3 }}>Account size (USDT)</label>
          <input type="number" value={accountSize} onChange={e => setAccountSize(+e.target.value || 0)}
            style={{ width: '100%', padding: '7px 10px', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 3 }}>Daily profit target ($)</label>
          <input type="number" value={dailyTarget} onChange={e => setDailyTarget(+e.target.value || 0)}
            style={{ width: '100%', padding: '7px 10px', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 3 }}>Risk per trade (%)</label>
          <input type="number" min={0.1} max={10} step={0.1} value={riskPct} onChange={e => setRiskPct(+e.target.value || 1)}
            style={{ width: '100%', padding: '7px 10px', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 3 }}>Spot move target (%)</label>
          <input type="number" min={0.1} max={10} step={0.1} value={spotTargetPct} onChange={e => setSpotTargetPct(+e.target.value || 1)}
            style={{ width: '100%', padding: '7px 10px', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
      </div>

      {/* Leverage selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ color: 'var(--c-dim)', fontSize: 11, minWidth: 60 }}>Leverage</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {[3, 5, 10, 20].map(lv => (
            <button key={lv} onClick={() => setLeverage(lv)}
              style={{ padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                background: leverage === lv ? '#6366f133' : 'var(--c-inner)',
                color: leverage === lv ? '#818cf8' : 'var(--c-faint)',
              }}>
              {lv}×
            </button>
          ))}
          <input type="number" min={1} max={100} value={leverage} onChange={e => setLeverage(+e.target.value || 1)}
            style={{ width: 52, padding: '4px 8px', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-muted)', outline: 'none', fontSize: 12, textAlign: 'center' }} />
        </div>
      </div>

      {/* Order type */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ color: 'var(--c-dim)', fontSize: 11, minWidth: 60 }}>Order type</span>
        <div style={{ display: 'flex', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, overflow: 'hidden' }}>
          {(['limit', 'market'] as const).map(t => (
            <button key={t} onClick={() => setOrderTypeCalc(t)}
              style={{ padding: '4px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: orderTypeCalc === t ? '#6366f133' : 'transparent',
                color: orderTypeCalc === t ? '#818cf8' : 'var(--c-faint)',
              }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div style={{ background: 'var(--c-inner)', borderRadius: 8, padding: '10px 14px' }}>
        {row('Position size', `$${position.toLocaleString()}`)}
        {row('Max risk this trade', `$${riskDollars.toFixed(2)}`, '#ef4444')}
        {row('Liquidation at', `-${liquidationPct}% spot move`, '#ef4444')}
        {row('Gross profit (target)', `$${grossProfit.toFixed(2)}`, '#22c55e')}
        {row('Fees (round trip)', `-$${totalFee.toFixed(2)}`, '#eab308')}
        {orderTypeCalc === 'limit' && row('Fee saving vs market', `+$${feeSavingVsMarket}`, '#22c55e')}
        {row('Net profit per trade', `$${netProfit.toFixed(2)}`, netProfit > 0 ? '#22c55e' : '#ef4444')}
        {row(`Trades to hit $${dailyTarget}/day`, `${tradesNeeded} winning trades`, typeof tradesNeeded === 'number' && tradesNeeded <= 5 ? '#22c55e' : '#eab308')}
        {row('ROI on margin per trade', `${((netProfit / accountSize) * 100).toFixed(2)}%`)}
      </div>

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--c-faintest)', lineHeight: 1.6 }}>
        Rule: Risk ${riskDollars.toFixed(0)} per trade max · Stop at 1% against entry · Close 50% at TP1 · Never hold through funding.
      </div>
    </div>
  );
}

/* ─── BTC Divergence Detector ────────────────────────────────────────────── */

function detectBtcDivergences(signal: ScanResult, btc: ScanResult): string[] {
  const divs: string[] = [];
  const dir = signal.direction;
  const bd = btc.deep;
  if (btc.direction !== 'NEUTRAL' && btc.direction !== dir)
    divs.push(`BTC trending ${btc.direction} (score ${btc.totalScore}) while signal is ${dir} — major macro divergence`);
  if (dir === 'LONG' && bd.rsi > 70)
    divs.push(`BTC RSI ${bd.rsi.toFixed(1)} overbought — crypto-wide exhaustion risk for longs`);
  if (dir === 'SHORT' && bd.rsi < 30)
    divs.push(`BTC RSI ${bd.rsi.toFixed(1)} oversold — reversal risk shorting into deeply oversold BTC`);
  if (dir === 'LONG' && bd.macdBear && !bd.macdBull)
    divs.push('BTC MACD bearish — macro momentum is against this LONG');
  if (dir === 'SHORT' && bd.macdBull && !bd.macdBear)
    divs.push('BTC MACD bullish — macro momentum is against this SHORT');
  if (dir === 'LONG' && !bd.vwapAbove)
    divs.push('BTC trading below VWAP — broad market structure bearish');
  if (dir === 'SHORT' && bd.vwapAbove)
    divs.push('BTC trading above VWAP — broad market structure bullish, shorts swim against tide');
  if (bd.wyckoffPhase?.includes('DISTRIBUTION') && dir === 'LONG')
    divs.push('BTC Wyckoff: DISTRIBUTION — macro selling pressure poorly aligned with LONG');
  if (bd.wyckoffPhase?.includes('ACCUMULATION') && dir === 'SHORT')
    divs.push('BTC Wyckoff: ACCUMULATION — macro demand building, fading this SHORT is risky');
  if (btc.totalScore >= 75 && signal.totalScore < 55)
    divs.push(`BTC signal very strong (${btc.totalScore}) vs weak coin signal (${signal.totalScore}) — confirm alt follows`);
  return divs;
}

/* ─── BTC Verdict Engine (rule-based, no API cost) ──────────────────────── */

type BtcVerdict = { label: string; color: string; bg: string; border: string; reason: string };

function getBtcVerdict(signal: ScanResult, btc: ScanResult, divs: string[]): BtcVerdict {
  const dirConflict = btc.direction !== 'NEUTRAL' && btc.direction !== signal.direction;
  const strong = signal.totalScore >= 80;
  const btcStrong = btc.totalScore >= 70;

  if (dirConflict && divs.length >= 3)
    return { label: 'SKIP', color: '#ef4444', bg: '#ef444411', border: '#ef444433',
      reason: `BTC is firmly ${btc.direction} with ${divs.length} macro conflicts. Do not fight the macro trend.` };

  if (dirConflict && divs.length >= 2)
    return { label: 'SKIP', color: '#ef4444', bg: '#ef444411', border: '#ef444433',
      reason: `BTC trending ${btc.direction} and multiple macro indicators oppose this ${signal.direction}. Wait for BTC alignment.` };

  if (dirConflict)
    return { label: 'HALF SIZE', color: '#f97316', bg: '#f9731611', border: '#f9731633',
      reason: `BTC trending ${btc.direction} vs your ${signal.direction}. Enter at 50% size only — exit immediately if BTC accelerates opposite.` };

  if (divs.length >= 3)
    return { label: 'REDUCE SIZE', color: '#eab308', bg: '#eab30811', border: '#eab30833',
      reason: `${divs.length} BTC indicators warn against this ${signal.direction}. Risk ≤1% and tighten stop to nearest structure.` };

  if (divs.length === 2)
    return { label: 'HALF SIZE', color: '#f97316', bg: '#f9731611', border: '#f9731633',
      reason: `Two BTC macro conflicts. Use 50% normal size; invalidate if either condition worsens before entry.` };

  if (divs.length === 1 && !strong)
    return { label: 'PROCEED CAUTIOUSLY', color: '#eab308', bg: '#eab30811', border: '#eab30833',
      reason: `One minor BTC conflict noted. Signal score ${signal.totalScore} is not exceptional — wait for entry candle confirmation before executing.` };

  if (divs.length === 1 && strong && btcStrong)
    return { label: 'PROCEED', color: '#22c55e', bg: '#22c55e11', border: '#22c55e33',
      reason: `Strong signal (${signal.totalScore}) with only one minor BTC conflict and aligned BTC momentum. Execute at planned entry with standard size.` };

  if (divs.length === 1)
    return { label: 'PROCEED CAUTIOUSLY', color: '#eab308', bg: '#eab30811', border: '#eab30833',
      reason: `Minor BTC divergence present. Standard entry is fine but stay alert — close early if BTC flips.` };

  // No divergences
  if (btcStrong && strong)
    return { label: 'HIGH CONVICTION — PROCEED', color: '#22c55e', bg: '#22c55e18', border: '#22c55e44',
      reason: `Full BTC macro alignment with no conflicts. Both BTC (${btc.totalScore}) and signal (${signal.totalScore}) are strong. Execute with confidence.` };

  return { label: 'PROCEED', color: '#22c55e', bg: '#22c55e11', border: '#22c55e33',
    reason: `BTC macro is aligned with this ${signal.direction} — no conflicts detected. Standard position size and risk apply.` };
}

/* ─── Constants ──────────────────────────────────────────────────────────── */

const GROUPS: { label: string; symbols: string[] }[] = [
  { label: 'Core L1',       symbols: ['ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','ATOMUSDT','TRXUSDT','ICPUSDT','XLMUSDT','HBARUSDT'] },
  { label: 'Memes',         symbols: ['DOGEUSDT','1000PEPEUSDT','WIFUSDT','1000FLOKIUSDT','1000BONKUSDT'] },
  { label: 'L2 / Rollups',  symbols: ['ARBUSDT','OPUSDT','STRKUSDT','POLUSDT','MNTUSDT'] },
  { label: 'Move / New L1', symbols: ['SUIUSDT','APTUSDT','SEIUSDT'] },
  { label: 'Cosmos',        symbols: ['INJUSDT','TIAUSDT','NEARUSDT','RUNEUSDT'] },
  { label: 'DeFi',          symbols: ['LINKUSDT','AAVEUSDT','UNIUSDT','LDOUSDT','CRVUSDT','PENDLEUSDT','GRTUSDT'] },
  { label: 'AI / Infra',    symbols: ['TAOUSDT','RENDERUSDT','WLDUSDT'] },
  { label: 'Solana',        symbols: ['JUPUSDT','PYTHUSDT','JTOUSDT'] },
  { label: 'BTC Ecosystem', symbols: ['ORDIUSDT','STXUSDT','LTCUSDT'] },
  { label: 'Gaming',        symbols: ['SANDUSDT','AXSUSDT','GALAUSDT','MANAUSDT','APEUSDT'] },
  { label: 'Other',         symbols: ['ENAUSDT','FILUSDT','ALGOUSDT','VETUSDT'] },
];
const POPULAR = GROUPS.flatMap(g => g.symbols);

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 4, fontSize: 12,
      background: ok ? '#16a34a22' : '#71717a22',
      color: ok ? '#22c55e' : '#71717a',
      border: `1px solid ${ok ? '#16a34a44' : '#3f3f4644'}`,
    }}>
      {ok ? '✓' : '✗'} {label}
    </span>
  );
}

function SyncKeyInput({ onLoad }: { onLoad: (key: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        placeholder="Paste sync key from another device…"
        style={{ flex: 1, padding: '8px 10px', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 12, fontFamily: 'monospace' }}
      />
      <button
        onClick={() => { if (val.trim()) { onLoad(val.trim()); setVal(''); } }}
        style={{ padding: '8px 14px', background: '#6366f122', border: '1px solid #6366f144', borderRadius: 6, color: '#818cf8', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
      >
        Load
      </button>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 80 ? '#22c55e' : score >= 60 ? '#eab308' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: 'var(--c-border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.5s' }} />
      </div>
      <span style={{ color, fontWeight: 700, minWidth: 36 }}>{score}</span>
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────────────────────── */

type Tab = 'scan' | 'radar' | 'calc' | 'trades' | 'log' | 'settings';
type Theme = 'dark' | 'light';

export default function Home() {
  const [tab, setTab] = useState<Tab>('scan');

  // Scan state
  const [symbol, setSymbol] = useState('ETHUSDT');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [autoScan, setAutoScan] = useState<AutoScanResult | null>(null);

  // Market overview — all pairs scanned at once
  const [marketOv, setMarketOv] = useState<Record<string, { score: number; direction: string; confidence: number }>>({});
  const [marketScanning, setMarketScanning] = useState(false);
  const [marketProgress, setMarketProgress] = useState(0);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Settings state
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // AI provider API keys (stored in localStorage, sent with AI requests)
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [deepseekKey, setDeepseekKey] = useState('');
  const [showAiKeys, setShowAiKeys] = useState(false);

  // Server-side env var status (fetched once on mount — no values exposed)
  const [serverStatus, setServerStatus] = useState<{
    bybit: boolean; anthropic: boolean; openai: boolean; deepseek: boolean; testnet: boolean;
  } | null>(null);

  // Account & risk
  const [accountSize, setAccountSize] = useState(2000);
  const [dailyLossLimit, setDailyLossLimit] = useState(80);
  const [dailyTarget, setDailyTarget] = useState(100);
  const [maxTrades, setMaxTrades] = useState(5);
  const [targetSpotPct, setTargetSpotPct] = useState(1);
  const [timezone, setTimezone] = useState('Australia/Melbourne');

  // Trade state
  const [riskPct, setRiskPct] = useState(1);
  const [orderType, setOrderType] = useState<'Market' | 'Limit'>('Limit');
  const [userLeverage, setUserLeverage] = useState<number | ''>('');
  const [forceTrade, setForceTrade] = useState(false);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeResult, setTradeResult] = useState<TradeResult | null>(null);
  const [manualMarginUsdt, setManualMarginUsdt] = useState<number | ''>('');

  // Theme
  const [theme, setTheme] = useState<Theme>('dark');

  // Trade journal
  const [trades, setTrades] = useState<TradeEntry[]>([]);
  const [livePrices, setLivePrices] = useState<Record<string, { price: number; updatedAt: number }>>({});
  const [liveRefreshing, setLiveRefreshing] = useState(false);
  const [syncKey, setSyncKey] = useState('');
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'ok' | 'error'>('idle');
  const [pendingSync, setPendingSync] = useState<Set<string>>(new Set());

  // All-markets browser (for search autocomplete)
  const [allMarkets, setAllMarkets] = useState<MarketTicker[]>([]);
  const [marketsLoaded, setMarketsLoaded] = useState(false);
  const [symbolSearch, setSymbolSearch] = useState('');

  // Radar scanner
  const [radarResult, setRadarResult] = useState<RadarResult | null>(null);
  const [radarLoading, setRadarLoading] = useState(false);
  const [radarFilter, setRadarFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');

  // TP/SL toast notifications
  const [toasts, setToasts] = useState<{ id: string; msg: string; color: string }[]>([]);
  function showToast(msg: string, color: string) {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev.slice(-4), { id, msg, color }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  }

  // BTC comparison
  const [btcResult, setBtcResult] = useState<ScanResult | null>(null);

  // AI explanation
  const [aiLoading, setAiLoading] = useState(false);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiProvider, setAiProvider] = useState<AiProvider>('claude');

  // Fetch server env var status once on mount
  useEffect(() => {
    fetch('/api/status').then(r => r.json()).then(setServerStatus).catch(() => {});
  }, []);

  // Load settings from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('4scans-settings');
      if (saved) {
        const s = JSON.parse(saved);
        if (s.apiKey)    setApiKey(s.apiKey);
        if (s.apiSecret) setApiSecret(s.apiSecret);
        if (typeof s.liveMode === 'boolean') setLiveMode(s.liveMode);
        if (s.riskPct)   setRiskPct(s.riskPct);
        if (s.orderType) setOrderType(s.orderType);
        if (s.aiProvider) setAiProvider(s.aiProvider as AiProvider);
        if (s.accountSize)    setAccountSize(s.accountSize);
        if (s.dailyLossLimit) setDailyLossLimit(s.dailyLossLimit);
        if (s.dailyTarget)    setDailyTarget(s.dailyTarget);
        if (s.maxTrades)      setMaxTrades(s.maxTrades);
        if (s.targetSpotPct)  setTargetSpotPct(s.targetSpotPct);
        if (s.timezone)       setTimezone(s.timezone);
        if (s.anthropicKey)   setAnthropicKey(s.anthropicKey);
        if (s.openaiKey)      setOpenaiKey(s.openaiKey);
        if (s.deepseekKey)    setDeepseekKey(s.deepseekKey);
        if (s.theme)          setTheme(s.theme as Theme);
      }
    } catch { /* ignore */ }

    // Init sync key — generate UUID if none stored
    try {
      let key = localStorage.getItem('4scans-sync-key');
      if (!key) {
        key = crypto.randomUUID();
        localStorage.setItem('4scans-sync-key', key);
      }
      setSyncKey(key);
    } catch { /* ignore */ }
  }, []);

  function saveSettings() {
    try {
      localStorage.setItem('4scans-settings', JSON.stringify({
        apiKey, apiSecret, liveMode, riskPct, orderType, aiProvider, theme,
        accountSize, dailyLossLimit, dailyTarget, maxTrades, targetSpotPct, timezone,
        anthropicKey, openaiKey, deepseekKey,
      }));
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch { /* ignore */ }
  }

  // Load trade journal from localStorage first (fast), then sync from Supabase
  useEffect(() => {
    try {
      const saved = localStorage.getItem('4scans-trades');
      if (saved) setTrades(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  // Once syncKey is ready, load from Supabase and merge
  useEffect(() => {
    if (!syncKey) return;
    setSyncStatus('syncing');
    fetch(`/api/trades?syncKey=${encodeURIComponent(syncKey)}`)
      .then(r => r.json())
      .then((data: { ok: boolean; trades?: TradeEntry[] }) => {
        if (data.ok && data.trades) {
          setTrades(data.trades);
          try { localStorage.setItem('4scans-trades', JSON.stringify(data.trades)); } catch { /* ignore */ }
          setSyncStatus('ok');
        }
      })
      .catch(() => setSyncStatus('error'));
  }, [syncKey]);

  // Flush pending high/low + hourly updates to Supabase (debounced 30s)
  useEffect(() => {
    if (!syncKey || pendingSync.size === 0) return;
    const timer = setTimeout(async () => {
      const ids = [...pendingSync];
      setPendingSync(new Set());
      for (const id of ids) {
        const trade = trades.find(t => t.id === id);
        if (!trade) continue;
        try {
          await fetch(`/api/trades/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              highestPrice: trade.highestPrice,
              lowestPrice: trade.lowestPrice,
              hourlyCandles: trade.hourlyCandles ?? [],
            }),
          });
        } catch { /* ignore */ }
      }
    }, 30_000);
    return () => clearTimeout(timer);
  }, [pendingSync, syncKey, trades]);

  // Live price polling for open trades — refresh every 8 seconds
  useEffect(() => {
    const openTrades = trades.filter(t => t.status === 'open');
    const openSymbols = [...new Set(openTrades.map(t => t.symbol))];
    if (!openSymbols.length) return;

    async function refresh() {
      setLiveRefreshing(true);
      try {
        const res = await fetch(`/api/ticker?symbols=${openSymbols.join(',')}`);
        const data = await res.json() as { ok: boolean; prices: { symbol: string; price: number | null }[] };
        if (data.ok) {
          const priceMap: Record<string, number> = {};
          data.prices.forEach(p => { if (p.price !== null) priceMap[p.symbol] = p.price; });

          setLivePrices(prev => {
            const next = { ...prev };
            Object.entries(priceMap).forEach(([sym, price]) => { next[sym] = { price, updatedAt: Date.now() }; });
            return next;
          });

          // Update H/L + hourly candles + TP/SL detection for open trades
          const nowHour = new Date().toISOString().slice(0, 13) + ':00:00Z';
          const changedIds = new Set<string>();
          const toastQueue: { msg: string; color: string }[] = [];
          const patchQueue: { id: string; patch: Partial<TradeEntry> }[] = [];
          const fmt4 = (v: number) => v < 1 ? v.toFixed(6) : v < 100 ? v.toFixed(4) : v.toFixed(2);

          setTrades(prev => prev.map(t => {
            if (t.status !== 'open') return t;
            const price = priceMap[t.symbol];
            if (price == null) return t;
            let updated = { ...t };
            // High/Low tracking
            if (updated.highestPrice == null || price > updated.highestPrice) { updated.highestPrice = price; changedIds.add(t.id); }
            if (updated.lowestPrice  == null || price < updated.lowestPrice)  { updated.lowestPrice  = price; changedIds.add(t.id); }
            // Hourly candle
            const candles = [...(updated.hourlyCandles ?? [])];
            const lastIdx = candles.length - 1;
            if (lastIdx >= 0 && candles[lastIdx].hour === nowHour) {
              const c = { ...candles[lastIdx] };
              if (price > c.high) c.high = price;
              if (price < c.low)  c.low  = price;
              c.close = price;
              candles[lastIdx] = c;
            } else {
              candles.push({ hour: nowHour, open: price, high: price, low: price, close: price });
            }
            updated.hourlyCandles = candles;
            changedIds.add(t.id);

            // ── Tiered TP / SL auto-detection ──────────────────────────
            const isLong = t.direction === 'LONG';

            // SL check first (takes priority over TP)
            if ((isLong ? price <= t.stopLoss : price >= t.stopLoss)) {
              const pnl = t.qty * (t.stopLoss - t.entry) * (isLong ? 1 : -1);
              updated = { ...updated, status: 'sl', exitPrice: t.stopLoss, pnlDollars: pnl };
              toastQueue.push({ msg: `STOPPED OUT — ${t.symbol} @ $${fmt4(t.stopLoss)} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, color: '#ef4444' });
              patchQueue.push({ id: t.id, patch: { status: 'sl', exitPrice: t.stopLoss, pnlDollars: pnl, tp1Hit: updated.tp1Hit, tp2Hit: updated.tp2Hit } });
              changedIds.add(t.id);
              return updated;
            }

            // TP1
            if (!updated.tp1Hit && (isLong ? price >= t.tp1 : price <= t.tp1)) {
              updated.tp1Hit = true;
              toastQueue.push({ msg: `TP1 HIT — ${t.symbol} @ $${fmt4(t.tp1)} | Move SL to breakeven`, color: '#22c55e' });
              patchQueue.push({ id: t.id, patch: { tp1Hit: true } });
              changedIds.add(t.id);
            }

            // TP2
            if (updated.tp1Hit && !updated.tp2Hit && (isLong ? price >= t.tp2 : price <= t.tp2)) {
              updated.tp2Hit = true;
              toastQueue.push({ msg: `TP2 HIT — ${t.symbol} @ $${fmt4(t.tp2)} | Trail stop to TP1`, color: '#22c55e' });
              patchQueue.push({ id: t.id, patch: { tp1Hit: true, tp2Hit: true } });
              changedIds.add(t.id);
            }

            // TP3 — auto-close full position
            if (updated.tp1Hit && updated.tp2Hit && !updated.tp3Hit && (isLong ? price >= t.tp3 : price <= t.tp3)) {
              const pnl = t.qty * (t.tp3 - t.entry) * (isLong ? 1 : -1);
              updated = { ...updated, tp3Hit: true, status: 'tp3', exitPrice: t.tp3, pnlDollars: pnl };
              toastQueue.push({ msg: `FULL TARGET — ${t.symbol} TP3 @ $${fmt4(t.tp3)} | +$${pnl.toFixed(2)}`, color: '#16a34a' });
              patchQueue.push({ id: t.id, patch: { status: 'tp3', exitPrice: t.tp3, pnlDollars: pnl, tp1Hit: true, tp2Hit: true, tp3Hit: true } });
              changedIds.add(t.id);
            }

            return updated;
          }));

          if (changedIds.size > 0) {
            setPendingSync(prev => new Set([...prev, ...changedIds]));
          }
          // Fire side effects outside the state updater
          toastQueue.forEach(({ msg, color }) => showToast(msg, color));
          patchQueue.forEach(({ id, patch }) => patchTrade(id, patch));
        }
      } catch { /* ignore */ }
      setLiveRefreshing(false);
    }

    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [trades.filter(t => t.status === 'open').map(t => t.id).join(',')]);

  function saveTrades(updated: TradeEntry[]) {
    setTrades(updated);
    try { localStorage.setItem('4scans-trades', JSON.stringify(updated)); } catch { /* ignore */ }
  }

  async function pushTrade(trade: TradeEntry) {
    if (!syncKey) return;
    try {
      await fetch('/api/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trade, syncKey }),
      });
      setSyncStatus('ok');
    } catch { setSyncStatus('error'); }
  }

  async function patchTrade(id: string, patch: Partial<TradeEntry>) {
    if (!syncKey) return;
    try {
      await fetch(`/api/trades/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    } catch { /* ignore */ }
  }

  async function updateTradeNotes(id: string, notes: string) {
    setTrades(prev => prev.map(t => t.id === id ? { ...t, notes } : t));
    try { const all = trades.map(t => t.id === id ? { ...t, notes } : t); localStorage.setItem('4scans-trades', JSON.stringify(all)); } catch { /* ignore */ }
    await patchTrade(id, { notes });
  }

  async function updateTradeStatus(id: string, status: TradeEntry['status'], exitPrice?: number) {
    const updated = trades.map(t => {
      if (t.id !== id) return t;
      const slDist = Math.abs(t.entry - t.stopLoss) / t.entry;
      const pnlDollars = exitPrice != null && slDist > 0
        ? t.qty * (exitPrice - t.entry) * (t.direction === 'LONG' ? 1 : -1)
        : undefined;
      return { ...t, status, exitPrice, pnlDollars };
    });
    saveTrades(updated);
    await patchTrade(id, { status, exitPrice, pnlDollars: updated.find(t => t.id === id)?.pnlDollars });
  }

  async function deleteTrade(id: string) {
    saveTrades(trades.filter(t => t.id !== id));
    if (!syncKey) return;
    try { await fetch(`/api/trades/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
  }

  async function changeSyncKey(newKey: string) {
    const key = newKey.trim();
    if (!key) return;
    setSyncKey(key);
    try { localStorage.setItem('4scans-sync-key', key); } catch { /* ignore */ }
    setSyncStatus('syncing');
    try {
      const r = await fetch(`/api/trades?syncKey=${encodeURIComponent(key)}`);
      const data = await r.json() as { ok: boolean; trades?: TradeEntry[] };
      if (data.ok && data.trades) {
        setTrades(data.trades);
        try { localStorage.setItem('4scans-trades', JSON.stringify(data.trades)); } catch { /* ignore */ }
        setSyncStatus('ok');
      }
    } catch { setSyncStatus('error'); }
  }

  // Load all markets once for the all-coins search
  useEffect(() => {
    if (marketsLoaded) return;
    fetch('/api/markets')
      .then(r => r.json())
      .then((d: { ok: boolean; markets?: MarketTicker[] }) => {
        if (d.ok && d.markets) { setAllMarkets(d.markets); setMarketsLoaded(true); }
      })
      .catch(() => { /* ignore */ });
  }, [marketsLoaded]);

  async function runRadar() {
    setRadarLoading(true);
    setRadarResult(null);
    try {
      const res = await fetch('/api/radar');
      const data = await res.json() as RadarResult;
      setRadarResult(data);
    } catch (e) {
      setRadarResult({ ok: false, count: 0, scanned: 0, elapsed: 0, signals: [], error: String(e) });
    } finally {
      setRadarLoading(false);
    }
  }

  // Poll for latest autoscan result every 60s
  useEffect(() => {
    const fetchLatest = async () => {
      try {
        const res = await fetch('/api/scan/latest');
        const data = await res.json() as AutoScanResult;
        setAutoScan(data);
      } catch { /* ignore */ }
    };
    fetchLatest();
    const id = setInterval(fetchLatest, 60_000);
    return () => clearInterval(id);
  }, []);

  function normalizeSymbol(s: string): string {
    const up = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!up) return 'BTCUSDT';
    // Already has a known quote currency suffix
    if (/^(\d+)/.test(up)) return up;  // multiplier pairs like 1000PEPEUSDT
    const quotes = ['USDT','USDC','BTC','ETH','BNB','SOL','BUSD'];
    if (quotes.some(q => up.endsWith(q))) return up;
    return up + 'USDT';
  }

  async function scan(sym = symbol) {
    setLoading(true);
    setResult(null);
    setBtcResult(null);
    setTradeResult(null);
    setAiExplanation(null);
    setAiWarnings([]);
    setTab('scan');
    try {
      const upperSym = normalizeSymbol(sym);
      if (upperSym !== sym.toUpperCase().replace(/[^A-Z0-9]/g, '')) {
        setSymbol(upperSym);
      }
      const isBtc = upperSym === 'BTCUSDT';
      const [res, btcRes] = await Promise.all([
        fetch(`/api/scan?symbol=${upperSym}`),
        isBtc ? null : fetch('/api/scan?symbol=BTCUSDT'),
      ]);
      const data = await res.json() as ScanResult;
      setResult(data);
      if (btcRes) {
        const btcData = await btcRes.json() as ScanResult;
        if (btcData.ok) setBtcResult(btcData);
      }
      if (data?.masterSignal?.leverage) {
        setUserLeverage(data.masterSignal.leverage);
      }
    } catch (e) {
      setResult({ ok: false, error: String(e) } as ScanResult);
    } finally {
      setLoading(false);
    }
  }

  async function scanMarket() {
    setMarketScanning(true);
    setMarketOv({});
    setMarketProgress(0);
    let done = 0;
    const BATCH = 5;
    for (let i = 0; i < POPULAR.length; i += BATCH) {
      const batch = POPULAR.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(async (sym) => {
          try {
            const res = await fetch(`/api/scan?symbol=${sym}`);
            const data = await res.json() as ScanResult;
            if (data.ok) {
              setMarketOv(prev => ({ ...prev, [sym]: { score: data.totalScore, direction: data.direction, confidence: data.confidence } }));
            }
          } catch { /* skip */ }
          done++;
          setMarketProgress(done);
        })
      );
    }
    setMarketScanning(false);
  }

  async function getAiExplain() {
    if (!result?.ok) return;
    setAiLoading(true);
    setAiExplanation(null);
    setAiWarnings([]);
    try {
      const aiKeyMap: Record<AiProvider, string> = {
        claude:   anthropicKey,
        openai:   openaiKey,
        deepseek: deepseekKey,
      };
      const res = await fetch('/api/ai-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...result,
          provider: aiProvider,
          clientApiKey: aiKeyMap[aiProvider] || undefined,
          btcDirection: btcResult?.direction,
          btcScore: btcResult?.totalScore,
          btcConfidence: btcResult?.confidence,
          btcDeep: btcResult?.deep,
        }),
      });
      const data = await res.json() as { explanation?: string; error?: string };
      if (data.error) { setAiExplanation(`Error: ${data.error}`); return; }
      setAiExplanation(data.explanation ?? '');

      // Flag misalignments: coin vs its own deep data
      const warnings: string[] = [];
      const d = result.deep;
      const dir = result.direction;
      if (dir === 'LONG' && !d.vwapAbove)  warnings.push('[Signal] VWAP is above price — longs trading against VWAP bias');
      if (dir === 'SHORT' && d.vwapAbove)  warnings.push('[Signal] VWAP is below price — shorts trading against VWAP bias');
      if (dir === 'LONG' && d.rsi > 70)    warnings.push(`[Signal] RSI ${d.rsi.toFixed(1)} overbought — entering longs here is high risk`);
      if (dir === 'SHORT' && d.rsi < 30)   warnings.push(`[Signal] RSI ${d.rsi.toFixed(1)} oversold — entering shorts here is high risk`);
      if (dir === 'LONG' && d.macdBear && !d.macdBull)  warnings.push('[Signal] MACD bearish — momentum not aligned with LONG');
      if (dir === 'SHORT' && d.macdBull && !d.macdBear) warnings.push('[Signal] MACD bullish — momentum not aligned with SHORT');
      if (d.volRatio < 0.8) warnings.push(`[Signal] Volume ${d.volRatio.toFixed(1)}× below average — no institutional participation`);
      if (!d.hasBOS)            warnings.push('[Signal] No BOS confirmed — entry lacks structural validity');
      if (!d.hasOB && !d.hasFVG) warnings.push('[Signal] No OB or FVG — no ICT confluence zone identified');
      if (d.wyckoffPhase?.includes('ACCUMULATION') && dir === 'SHORT') warnings.push('[Signal] Wyckoff ACCUMULATION — shorting into potential demand zone');
      if (d.wyckoffPhase?.includes('DISTRIBUTION') && dir === 'LONG')  warnings.push('[Signal] Wyckoff DISTRIBUTION — buying into potential supply zone');

      // Flag BTC divergences
      if (btcResult?.ok) {
        const btcDivs = detectBtcDivergences(result, btcResult);
        btcDivs.forEach(d => warnings.push(`[BTC] ${d}`));
      }

      setAiWarnings(warnings);
    } catch (e) {
      setAiExplanation(`Error: ${String(e)}`);
    } finally {
      setAiLoading(false);
    }
  }

  async function enterTrade() {
    if (!result?.ok || result.direction === 'NEUTRAL') return;
    setTradeLoading(true);
    setTradeResult(null);

    const rawLev = typeof userLeverage === 'number' ? userLeverage : result.masterSignal.leverage;
    const effectiveLev = rawLev;

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: result.symbol,
          direction: result.direction,
          entry: result.masterSignal.entry,
          stopLoss: result.masterSignal.stopLoss,
          tp1: result.masterSignal.tp1,
          tp2: result.masterSignal.tp2,
          tp3: result.masterSignal.tp3,
          leverage: effectiveLev,
          riskPct,
          style: result.bestSetup,
          orderType,
          force: forceTrade,
          userLeverage: effectiveLev,
          ...(apiKey && { apiKey }),
          ...(apiSecret && { apiSecret }),
          liveMode,
        }),
      });
      const data = await res.json() as TradeResult;
      setTradeResult(data);

      // Save to trade journal on success/paper
      if (data.paper || data.success) {
        const ep    = result.masterSignal.entry;
        const sl    = result.masterSignal.stopLoss;
        const slDist = Math.abs(ep - sl) / ep;
        let calcQty: number;
        let positionNotional: number;
        let marginUsed: number;
        if (typeof manualMarginUsdt === 'number' && manualMarginUsdt > 0) {
          // User-specified margin → derive position
          marginUsed       = manualMarginUsdt;
          positionNotional = marginUsed * effectiveLev;
          calcQty          = positionNotional / ep;
        } else {
          const riskAmt = accountSize * riskPct / 100;
          calcQty        = slDist > 0 ? riskAmt / (ep * slDist) : 0;
          positionNotional = calcQty * ep;
          marginUsed       = positionNotional / effectiveLev;
        }
        const qty      = data.qty ?? parseFloat(calcQty.toFixed(3));
        const tzAbbr = new Date().toLocaleTimeString('en', { timeZoneName: 'short', timeZone: timezone }).split(' ').pop() ?? timezone;
        const entry: TradeEntry = {
          id: Date.now().toString(),
          symbol: result.symbol,
          direction: result.direction as 'LONG' | 'SHORT',
          entry: ep,
          stopLoss: sl,
          tp1: result.masterSignal.tp1,
          tp2: result.masterSignal.tp2,
          tp3: result.masterSignal.tp3,
          leverage: effectiveLev,
          riskPct,
          orderType,
          mode: liveMode ? 'live' : 'paper',
          timestamp: new Date().toLocaleString('en-AU', { timeZone: timezone }),
          timezone: tzAbbr,
          score: result.totalScore,
          confidence: result.confidence,
          bestSetup: result.bestSetup,
          netRR: result.masterSignal.netRR,
          qty,
          positionNotional,
          marginUsed,
          status: 'open',
          orderId: data.orderId,
          notes: '',
          highestPrice: ep,
          lowestPrice: ep,
          hourlyCandles: [],
          fullAnalysis: {
            direction: result.direction,
            totalScore: result.totalScore,
            confidence: result.confidence,
            alignmentScore: result.alignmentScore,
            alignmentQuality: result.alignmentQuality,
            verdict: result.verdict,
            signalText: result.masterSignal.signalText,
            leverageWarning: result.masterSignal.leverageWarning,
            deep: result.deep,
            avgMoves: result.avgMoves,
            spotAvgMoves: result.spotAvgMoves,
          },
        };
        const newTrades = [entry, ...trades];
        saveTrades(newTrades);
        await pushTrade(entry);
      }
    } catch (e) {
      setTradeResult({ error: String(e) });
    } finally {
      setTradeLoading(false);
    }
  }

  const dirColor = result?.direction === 'LONG' ? '#22c55e' : result?.direction === 'SHORT' ? '#ef4444' : 'var(--c-muted)';
  const canTrade = result?.ok && result.direction !== 'NEUTRAL';

  const isDark = theme === 'dark';
  // CSS variable values injected onto <main>
  const cssVars = isDark ? {
    '--c-bg':        '#080810',
    '--c-card':      '#111118',
    '--c-inner':     '#0a0a0f',
    '--c-border':    '#1e1e2e',
    '--c-text':      '#e2e8f0',
    '--c-muted':     '#94a3b8',
    '--c-dim':       '#64748b',
    '--c-faint':     '#475569',
    '--c-faintest':  '#334155',
    '--c-subtle':    '#cbd5e1',
  } : {
    '--c-bg':        '#f1f5f9',
    '--c-card':      '#ffffff',
    '--c-inner':     '#f8fafc',
    '--c-border':    '#e2e8f0',
    '--c-text':      '#0f172a',
    '--c-muted':     '#1e293b',
    '--c-dim':       '#334155',
    '--c-faint':     '#475569',
    '--c-faintest':  '#64748b',
    '--c-subtle':    '#1e293b',
  };

  const TAB_STYLE = (active: boolean) => ({
    flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer',
    fontWeight: 700, fontSize: 13,
    background: active ? 'var(--c-card)' : 'transparent',
    color: active ? 'var(--c-text)' : 'var(--c-faint)',
    borderBottom: active ? '2px solid #6366f1' : '2px solid transparent',
    transition: 'all 0.15s',
  });

  return (
    <main data-theme={theme} style={{ maxWidth: 920, margin: '0 auto', padding: '0 0 40px', background: 'var(--c-bg)', minHeight: '100vh', ...cssVars } as React.CSSProperties}>
      <style>{`body { background: ${isDark ? '#080810' : '#f1f5f9'}; margin: 0; }`}</style>

      {/* ── Toast notifications ────────────────────────────────────────── */}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 340, pointerEvents: 'none' }}>
          {toasts.map(toast => (
            <div key={toast.id} style={{
              padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 700,
              background: `${toast.color}22`, border: `1.5px solid ${toast.color}66`,
              color: toast.color,
              backdropFilter: 'blur(12px)',
              boxShadow: `0 4px 24px ${toast.color}33`,
              animation: 'slideIn 0.2s ease',
              lineHeight: 1.4,
            }}>
              {toast.msg}
            </div>
          ))}
        </div>
      )}
      <style>{`@keyframes slideIn { from { opacity: 0; transform: translateX(60px); } to { opacity: 1; transform: translateX(0); } }`}</style>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ padding: '20px 16px 0', marginBottom: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px', margin: 0, color: 'var(--c-text)' }}>
              🚀 4SCANS
            </h1>
            <p style={{ color: 'var(--c-dim)', fontSize: 12, marginTop: 3, marginBottom: 0 }}>
              Bybit perpetuals · ICT + Wyckoff · {liveMode ? <span style={{ color: '#ef4444', fontWeight: 700 }}>⚡ LIVE</span> : <span style={{ color: '#22c55e' }}>📄 PAPER</span>}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Theme toggle */}
            <button onClick={() => {
              const next: Theme = theme === 'dark' ? 'light' : 'dark';
              setTheme(next);
              try { const s = JSON.parse(localStorage.getItem('4scans-settings') ?? '{}'); localStorage.setItem('4scans-settings', JSON.stringify({ ...s, theme: next })); } catch { /* ignore */ }
            }} style={{
              padding: '6px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              background: 'var(--c-card)', color: 'var(--c-dim)',
              border: '1px solid var(--c-border)',
            }}>
              {isDark ? '☀️ Light' : '🌙 Dark'}
            </button>
            {/* Mode badge */}
            <div style={{
              padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              background: liveMode ? '#ef444422' : '#16a34a22',
              color: liveMode ? '#ef4444' : '#22c55e',
              border: `1px solid ${liveMode ? '#ef444444' : '#16a34a44'}`,
            }} onClick={() => setTab('settings')}>
              {liveMode ? '⚡ Live' : '📄 Paper'}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--c-border)', marginBottom: 0, overflowX: 'auto' }}>
          <button style={TAB_STYLE(tab === 'scan')} onClick={() => setTab('scan')}>📡 Scan</button>
          <button style={TAB_STYLE(tab === 'radar')} onClick={() => setTab('radar')}>🔭 Radar</button>
          <button style={TAB_STYLE(tab === 'calc')} onClick={() => setTab('calc')}>📐 Calc</button>
          <button style={TAB_STYLE(tab === 'trades')} onClick={() => setTab('trades')}>
            📒{trades.some(t => t.status === 'open') ? ` (${trades.filter(t => t.status === 'open').length})` : ' Trades'}
          </button>
          <button style={TAB_STYLE(tab === 'log')} onClick={() => setTab('log')}>
            📋{trades.length > 0 ? ` (${trades.length})` : ' Log'}
          </button>
          <button style={TAB_STYLE(tab === 'settings')} onClick={() => setTab('settings')}>⚙️</button>
        </div>
      </div>

      <div style={{ padding: '20px 16px 0' }}>

        {/* ══════════════════ SCAN TAB ══════════════════ */}
        {tab === 'scan' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Search row with all-markets autocomplete */}
            <div style={{ position: 'relative' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={symbolSearch || symbol}
                  onChange={e => {
                    const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
                    setSymbolSearch(v);
                    setSymbol(v);
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') { setSymbolSearch(''); scan(); } if (e.key === 'Escape') setSymbolSearch(''); }}
                  onBlur={() => setTimeout(() => setSymbolSearch(''), 180)}
                  placeholder="Search any pair — e.g. AIGENSYN, SOL, ETH…"
                  style={{
                    flex: 1, padding: '11px 14px', background: 'var(--c-card)',
                    border: '1px solid var(--c-border)', borderRadius: 8, color: 'var(--c-text)', outline: 'none', fontSize: 14,
                  }}
                />
                <button onClick={() => { setSymbolSearch(''); scan(); }} disabled={loading} style={{
                  padding: '11px 22px', background: loading ? '#3730a3' : '#6366f1', color: '#fff',
                  border: 'none', borderRadius: 8, cursor: loading ? 'not-allowed' : 'pointer',
                  fontWeight: 700, fontSize: 14, minWidth: 90,
                }}>
                  {loading ? '…' : 'Scan'}
                </button>
              </div>
              {/* Autocomplete dropdown */}
              {symbolSearch.length >= 2 && (() => {
                const q = symbolSearch;
                const matches = allMarkets
                  .filter(m => m.symbol.includes(q) || m.symbol.replace('USDT','').startsWith(q))
                  .slice(0, 8);
                if (!matches.length) return null;
                return (
                  <div style={{
                    position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                    background: 'var(--c-card)', border: '1px solid var(--c-border)',
                    borderRadius: 8, marginTop: 4, overflow: 'hidden', boxShadow: '0 8px 24px #00000044',
                  }}>
                    {matches.map(m => {
                      const chg = m.change24h;
                      const vol = m.volume24h >= 1e9 ? `$${(m.volume24h/1e9).toFixed(1)}B` : m.volume24h >= 1e6 ? `$${(m.volume24h/1e6).toFixed(0)}M` : `$${(m.volume24h/1e3).toFixed(0)}K`;
                      return (
                        <button key={m.symbol} onMouseDown={() => { setSymbol(m.symbol); setSymbolSearch(''); scan(m.symbol); }} style={{
                          width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer',
                          borderBottom: '1px solid var(--c-border)', color: 'var(--c-text)', textAlign: 'left',
                        }}>
                          <span style={{ fontWeight: 700, fontSize: 13 }}>{m.symbol}</span>
                          <span style={{ fontSize: 12, display: 'flex', gap: 10 }}>
                            <span style={{ color: chg >= 0 ? '#22c55e' : '#ef4444' }}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
                            <span style={{ color: 'var(--c-faint)' }}>{vol}</span>
                          </span>
                        </button>
                      );
                    })}
                    <div style={{ padding: '6px 14px', fontSize: 11, color: 'var(--c-faintest)' }}>
                      {allMarkets.filter(m => m.symbol.includes(q) || m.symbol.replace('USDT','').startsWith(q)).length} matches across all Bybit perpetuals
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Market overview: grouped, collapsible, sortable */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ fontSize: 11, color: 'var(--c-faintest)' }}>
                {marketScanning
                  ? `Scanning ${marketProgress} / ${POPULAR.length}…`
                  : Object.keys(marketOv).length > 0
                    ? `${Object.keys(marketOv).length} pairs scored · tap group to expand`
                    : 'Tap group to expand · scan all for scores'}
              </span>
              <button
                onClick={marketScanning ? undefined : scanMarket}
                disabled={marketScanning}
                style={{
                  padding: '4px 12px', background: '#0f172a',
                  border: '1px solid var(--c-faintest)', borderRadius: 6,
                  color: marketScanning ? 'var(--c-faint)' : 'var(--c-muted)',
                  cursor: marketScanning ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600,
                }}
              >
                {marketScanning ? `${marketProgress}/${POPULAR.length}…` : '⚡ Scan All'}
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {GROUPS.map(group => {
                const isExpanded = expandedGroups.has(group.label);
                const scanned = Object.keys(marketOv).length > 0;

                // Best score + direction in this group
                const scored = group.symbols
                  .map(s => ({ s, ov: marketOv[s] }))
                  .filter(x => x.ov)
                  .sort((a, b) => b.ov.score - a.ov.score);
                const best = scored[0]?.ov;
                const bestDir = best?.direction;
                const bestScore = best?.score ?? null;
                const dirColor = bestDir === 'LONG' ? '#22c55e' : bestDir === 'SHORT' ? '#ef4444' : 'var(--c-dim)';
                const scoreColor = bestScore === null ? 'var(--c-faint)' : bestScore >= 80 ? '#22c55e' : bestScore >= 65 ? '#eab308' : 'var(--c-dim)';

                // Sort symbols by score desc within expanded group
                const sorted = isExpanded
                  ? [...group.symbols].sort((a, b) => (marketOv[b]?.score ?? 0) - (marketOv[a]?.score ?? 0))
                  : group.symbols;

                return (
                  <div key={group.label} style={{ border: '1px solid var(--c-border)', borderRadius: 8, overflow: 'hidden' }}>
                    {/* Group header — click to toggle */}
                    <button
                      onClick={() => setExpandedGroups(prev => {
                        const next = new Set(prev);
                        if (next.has(group.label)) next.delete(group.label); else next.add(group.label);
                        return next;
                      })}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '7px 10px', background: isExpanded ? 'var(--c-card)' : 'var(--c-inner)',
                        border: 'none', cursor: 'pointer', gap: 8,
                      }}
                    >
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-dim)', letterSpacing: '0.05em' }}>
                        {group.label}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                        {scanned && bestScore !== null && (
                          <>
                            <span style={{ fontSize: 11, fontWeight: 800, color: scoreColor }}>{bestScore}</span>
                            {bestDir && bestDir !== 'NEUTRAL' && (
                              <span style={{ fontSize: 10, color: dirColor, fontWeight: 700 }}>
                                {bestDir === 'LONG' ? '▲' : '▼'} {bestDir}
                              </span>
                            )}
                          </>
                        )}
                        {marketScanning && !scanned && (
                          <span style={{ fontSize: 10, color: 'var(--c-faintest)' }}>…</span>
                        )}
                        <span style={{ fontSize: 10, color: 'var(--c-faintest)' }}>{group.symbols.length}</span>
                        <span style={{ fontSize: 10, color: 'var(--c-faintest)' }}>{isExpanded ? '▲' : '▼'}</span>
                      </div>
                    </button>

                    {/* Expanded: 3-column scored grid */}
                    {isExpanded && (
                      <div style={{ padding: '6px 6px 6px', background: 'var(--c-bg)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5 }}>
                        {sorted.map(s => {
                          const ov = marketOv[s];
                          const lbl = s.replace('1000', '').replace('USDT', '');
                          const dir = ov?.direction ?? null;
                          const score = ov?.score ?? null;
                          const active = symbol === s;
                          const dc = dir === 'LONG' ? '#22c55e' : dir === 'SHORT' ? '#ef4444' : 'var(--c-faint)';
                          const sc = score === null ? 'var(--c-faintest)' : score >= 80 ? '#22c55e' : score >= 65 ? '#eab308' : 'var(--c-dim)';
                          return (
                            <button key={s} onClick={() => { setSymbol(s); scan(s); }} style={{
                              padding: '7px 8px', textAlign: 'left',
                              background: active ? '#1e1b4b' : ov ? `${dc}0d` : 'var(--c-inner)',
                              border: `1px solid ${active ? '#6366f1' : ov ? `${dc}33` : '#1a1a2e'}`,
                              borderRadius: 6, cursor: 'pointer',
                            }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 11, fontWeight: 700, color: active ? '#818cf8' : 'var(--c-muted)' }}>{lbl}</span>
                                {score !== null
                                  ? <span style={{ fontSize: 13, fontWeight: 800, color: sc }}>{score}</span>
                                  : marketScanning ? <span style={{ fontSize: 10, color: 'var(--c-border)' }}>…</span> : null}
                              </div>
                              {dir && dir !== 'NEUTRAL' && (
                                <div style={{ fontSize: 9, color: dc, fontWeight: 600, marginTop: 1 }}>
                                  {dir === 'LONG' ? '▲' : '▼'} {dir}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Autoscan panel */}
            <div style={{ padding: 14, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--c-muted)' }}>⚡ AUTOSCAN</span>
                <span style={{ fontSize: 11, color: 'var(--c-faint)' }}>every 15 min · score ≥ 80</span>
              </div>
              {!autoScan || !autoScan.ok ? (
                <div style={{ color: 'var(--c-faint)', fontSize: 13 }}>{autoScan?.message ?? 'Waiting for first cron scan…'}</div>
              ) : (
                <>
                  <div style={{ color: 'var(--c-faint)', fontSize: 11, marginBottom: 8 }}>
                    {autoScan.timestamp} · {autoScan.scanned} pairs · {((autoScan.elapsed ?? 0) / 1000).toFixed(1)}s
                    {autoScan.timedOut && <span style={{ color: '#eab308', marginLeft: 6 }}>⚠ timed out</span>}
                  </div>
                  {autoScan.alerts && autoScan.alerts.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {autoScan.alerts.map(a => (
                        <button key={a.symbol} onClick={() => { setSymbol(a.symbol); scan(a.symbol); }} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '9px 12px', background: 'var(--c-inner)', border: '1px solid var(--c-border)',
                          borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                        }}>
                          <span style={{ fontWeight: 700, color: 'var(--c-text)' }}>{a.symbol}</span>
                          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span style={{ color: a.direction === 'LONG' ? '#22c55e' : '#ef4444', fontSize: 12, fontWeight: 700 }}>
                              {a.direction === 'LONG' ? '▲' : '▼'} {a.direction}
                            </span>
                            <span style={{
                              padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                              background: a.tier === 'A+' ? '#f59e0b22' : '#6366f122',
                              color: a.tier === 'A+' ? '#f59e0b' : '#818cf8',
                            }}>{a.tier} · {a.score}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div style={{ color: 'var(--c-faint)', fontSize: 13 }}>No signals above 80 in last scan</div>
                  )}
                </>
              )}
            </div>

            {/* Error */}
            {result?.error && (
              <div style={{ padding: 14, background: '#ef444422', border: '1px solid #ef444444', borderRadius: 8, color: '#ef4444' }}>
                {result.error}
              </div>
            )}

            {/* Result */}
            {result?.ok && (
              <>
                {/* Symbol header */}
                <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontWeight: 800, fontSize: 20 }}>{result.symbol}</span>
                      <span style={{ color: 'var(--c-faint)', marginLeft: 8, fontSize: 13 }}>PERP</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, fontSize: 20 }}>${result.price.toFixed(4)}</div>
                      <div style={{ fontSize: 12, color: result.change24h >= 0 ? '#22c55e' : '#ef4444' }}>
                        {result.change24h >= 0 ? '+' : ''}{result.change24h.toFixed(2)}% 24h
                      </div>
                    </div>
                  </div>
                </div>

                {/* Direction + score */}
                <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <span style={{
                      padding: '5px 16px', borderRadius: 20, fontWeight: 800, fontSize: 16,
                      background: `${dirColor}22`, color: dirColor, border: `1px solid ${dirColor}44`,
                    }}>
                      {result.direction === 'LONG' ? '▲' : result.direction === 'SHORT' ? '▼' : '—'} {result.direction}
                    </span>
                    <span style={{ color: 'var(--c-dim)', fontSize: 12 }}>{result.bestSetup} · {result.alignmentQuality}</span>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span style={{ color: 'var(--c-dim)', fontSize: 12 }}>Signal Score</span>
                      <span style={{ color: 'var(--c-dim)', fontSize: 12 }}>Confidence {result.confidence}%</span>
                    </div>
                    <ScoreBar score={result.totalScore} />
                  </div>
                  <div>
                    <div style={{ color: 'var(--c-dim)', fontSize: 12, marginBottom: 5 }}>Alignment {result.alignmentScore.toFixed(0)}%</div>
                    <ScoreBar score={result.alignmentScore} />
                  </div>
                </div>

                {/* BTC Trend Comparison */}
                {btcResult?.ok && (
                  (() => {
                    const btcDir = btcResult.direction;
                    const btcAligned = btcDir === result.direction || btcDir === 'NEUTRAL';
                    const divs = detectBtcDivergences(result, btcResult);
                    const btcDirColor = btcDir === 'LONG' ? '#22c55e' : btcDir === 'SHORT' ? '#ef4444' : 'var(--c-muted)';
                    return (
                      <div style={{
                        padding: 14, background: 'var(--c-card)',
                        border: `1px solid ${btcAligned ? '#1e3a2e' : '#3a1e1e'}`,
                        borderRadius: 10,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: divs.length > 0 ? 10 : 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--c-muted)' }}>₿ BTC TREND</span>
                            <span style={{
                              padding: '2px 10px', borderRadius: 4, fontSize: 12, fontWeight: 700,
                              background: `${btcDirColor}22`, color: btcDirColor, border: `1px solid ${btcDirColor}44`,
                            }}>
                              {btcDir === 'LONG' ? '▲' : btcDir === 'SHORT' ? '▼' : '—'} {btcDir}
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--c-faint)' }}>
                              Score {btcResult.totalScore} · RSI {btcResult.deep.rsi.toFixed(0)} · {btcResult.deep.wyckoffPhase}
                            </span>
                          </div>
                          <span style={{
                            padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                            background: btcAligned ? '#16a34a22' : '#dc262622',
                            color: btcAligned ? '#22c55e' : '#ef4444',
                            border: `1px solid ${btcAligned ? '#16a34a44' : '#dc262644'}`,
                          }}>
                            {btcAligned ? '✓ Aligned' : '⚠ Diverging'}
                          </span>
                        </div>
                        {divs.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                            {divs.map((d, i) => (
                              <div key={i} style={{ padding: '5px 9px', background: '#dc262611', border: '1px solid #dc262633', borderRadius: 5, color: '#fca5a5', fontSize: 11 }}>
                                ⚠ {d}
                              </div>
                            ))}
                          </div>
                        )}
                        {(() => {
                          const v = getBtcVerdict(result, btcResult, divs);
                          return (
                            <div style={{ padding: '9px 12px', background: v.bg, border: `1px solid ${v.border}`, borderRadius: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                <span style={{ fontSize: 10, color: 'var(--c-dim)', fontWeight: 600, letterSpacing: 1 }}>BTC VERDICT</span>
                                <span style={{ fontSize: 12, fontWeight: 800, color: v.color }}>{v.label}</span>
                              </div>
                              <div style={{ fontSize: 11, color: 'var(--c-muted)', lineHeight: 1.5 }}>{v.reason}</div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })()
                )}

                {/* Trade levels */}
                {(() => {
                  const ms = result.masterSignal;
                  const effLev = userLeverage || ms.leverage;
                  const MMR = 0.005;
                  const liqDist = Math.max(0, 1 / effLev - MMR);
                  const liqPrice = result.direction === 'LONG'
                    ? ms.entry * (1 - liqDist)
                    : ms.entry * (1 + liqDist);
                  const slDist = Math.abs(ms.entry - ms.stopLoss) / ms.entry;
                  const liqBeforeSL = result.direction === 'LONG'
                    ? liqPrice > ms.stopLoss
                    : liqPrice < ms.stopLoss;
                  const maxSafeLev = Math.floor(1 / (slDist + MMR));
                  const fmt = (v: number) => v < 1 ? v.toFixed(6) : v < 100 ? v.toFixed(4) : v.toFixed(2);

                  // P&L per level — use manual margin or risk-based sizing
                  const riskAmt = accountSize * riskPct / 100;
                  const qty = typeof manualMarginUsdt === 'number' && manualMarginUsdt > 0
                    ? (manualMarginUsdt * effLev) / ms.entry
                    : slDist > 0 ? riskAmt / (ms.entry * slDist) : 0;
                  const pnl = (price: number) =>
                    qty * (price - ms.entry) * (result.direction === 'LONG' ? 1 : -1);

                  const levels = [
                    { label: 'Entry',     value: ms.entry,    pnlVal: null,                color: 'var(--c-text)', pct: null },
                    { label: 'Stop Loss', value: ms.stopLoss, pnlVal: pnl(ms.stopLoss),    color: '#ef4444', pct: -(slDist * 100) },
                    { label: 'TP1 · 50%', value: ms.tp1,      pnlVal: pnl(ms.tp1),         color: '#4ade80', pct: Math.abs(ms.tp1 - ms.entry) / ms.entry * 100 },
                    { label: 'TP2 · 25%', value: ms.tp2,      pnlVal: pnl(ms.tp2),         color: '#22c55e', pct: Math.abs(ms.tp2 - ms.entry) / ms.entry * 100 },
                    { label: 'TP3 · 25%', value: ms.tp3,      pnlVal: pnl(ms.tp3),         color: '#16a34a', pct: Math.abs(ms.tp3 - ms.entry) / ms.entry * 100 },
                    { label: 'Net R:R',   value: null,         pnlVal: null,                color: '#6366f1', pct: null },
                  ];

                  return (
                    <div style={{ padding: 16, background: 'var(--c-card)', border: `1px solid ${liqBeforeSL ? '#ef444444' : 'var(--c-border)'}`, borderRadius: 10 }}>
                      <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 13, color: 'var(--c-muted)' }}>TRADE LEVELS</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 7 }}>
                        {levels.map(({ label, value, pnlVal, color, pct }) => (
                          <div key={label} style={{ padding: '9px 10px', background: 'var(--c-inner)', borderRadius: 7, borderTop: `2px solid ${color}33` }}>
                            <div style={{ color: 'var(--c-faint)', fontSize: 10, marginBottom: 3 }}>{label}</div>
                            <div style={{ color, fontWeight: 800, fontSize: 13 }}>
                              {value !== null ? `$${fmt(value)}` : `${ms.netRR.toFixed(2)}×`}
                            </div>
                            {pct !== null && (
                              <div style={{ fontSize: 10, color: color, opacity: 0.7, marginTop: 1 }}>
                                {pct > 0 ? '+' : ''}{pct.toFixed(2)}%
                              </div>
                            )}
                            {pnlVal !== null && qty > 0 && (
                              <div style={{ fontSize: 11, fontWeight: 700, color: pnlVal >= 0 ? '#22c55e' : '#ef4444', marginTop: 3 }}>
                                {pnlVal >= 0 ? '+' : ''}${Math.abs(pnlVal).toFixed(2)}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Liquidation row */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                        <div style={{ padding: '8px 12px', background: liqBeforeSL ? '#ef444422' : 'var(--c-inner)', border: `1px solid ${liqBeforeSL ? '#ef444455' : 'transparent'}`, borderRadius: 6 }}>
                          <div style={{ color: 'var(--c-faint)', fontSize: 11 }}>Liquidation @ {effLev}×</div>
                          <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 14 }}>${fmt(liqPrice)}</div>
                          <div style={{ color: 'var(--c-faint)', fontSize: 10, marginTop: 2 }}>{(liqDist * 100).toFixed(1)}% from entry · MMR 0.5%</div>
                        </div>
                        <div style={{ padding: '8px 12px', background: 'var(--c-inner)', borderRadius: 6 }}>
                          <div style={{ color: 'var(--c-faint)', fontSize: 11 }}>Rec. Leverage</div>
                          <div style={{ color: '#6366f1', fontWeight: 700, fontSize: 14 }}>{ms.leverage}×</div>
                          <div style={{ color: 'var(--c-faint)', fontSize: 10, marginTop: 2 }}>Your setting: {effLev}×</div>
                        </div>
                      </div>

                      {liqBeforeSL && (
                        <div style={{ marginTop: 10, padding: '10px 12px', background: '#ef444422', border: '1px solid #ef444455', borderRadius: 6 }}>
                          <div style={{ color: '#ef4444', fontWeight: 700, fontSize: 12, marginBottom: 4 }}>
                            🚨 LIQUIDATION BEFORE STOP LOSS
                          </div>
                          <div style={{ color: '#fca5a5', fontSize: 12, lineHeight: 1.5 }}>
                            At {effLev}× leverage, you get liquidated at ${fmt(liqPrice)} before your stop loss at ${fmt(ms.stopLoss)} triggers.
                            Reduce leverage to <strong>{maxSafeLev}× or below</strong> for this SL to protect your position.
                          </div>
                        </div>
                      )}

                      {result.masterSignal.leverageWarning && (
                        <div style={{ marginTop: 10, padding: 10, background: '#eab30822', borderRadius: 6, color: '#eab308', fontSize: 12 }}>
                          {result.masterSignal.leverageWarning}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Structure */}
                <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: 'var(--c-muted)' }}>STRUCTURE</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    <Badge ok={result.deep.hasBOS}   label="BOS" />
                    <Badge ok={result.deep.hasOB}    label="Order Block" />
                    <Badge ok={result.deep.hasFVG}   label="FVG" />
                    <Badge ok={result.deep.hasChoCH} label="CHoCH" />
                    <Badge ok={result.deep.hasSweep} label="Liq. Sweep" />
                    <Badge ok={result.deep.macdBull || result.deep.macdBear} label="MACD" />
                    <Badge ok={result.deep.vwapAbove === (result.direction === 'LONG')} label="VWAP aligned" />
                    <Badge ok={result.deep.volRatio >= 1.5} label={`Vol ${result.deep.volRatio.toFixed(1)}×`} />
                  </div>
                  <div style={{ display: 'flex', gap: 20, fontSize: 13 }}>
                    <div>
                      <span style={{ color: 'var(--c-dim)' }}>RSI </span>
                      <span style={{ color: result.deep.rsi > 70 ? '#ef4444' : result.deep.rsi < 30 ? '#22c55e' : 'var(--c-text)', fontWeight: 700 }}>
                        {result.deep.rsi.toFixed(1)}
                        {result.deep.rsi > 70 ? ' ⚠ Overbought' : result.deep.rsi < 30 ? ' ⚠ Oversold' : ''}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: 'var(--c-dim)' }}>Wyckoff </span>
                      <span style={{ fontWeight: 600 }}>{result.deep.wyckoffPhase}</span>
                    </div>
                  </div>
                </div>

                {/* ── AI DEEP ANALYSIS ────────────────────────────────── */}
                <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--c-muted)' }}>🤖 AI DEEP ANALYSIS</span>
                    <button onClick={getAiExplain} disabled={aiLoading} style={{
                      padding: '6px 16px', background: aiLoading ? 'var(--c-border)' : '#6366f122',
                      border: '1px solid #6366f144', borderRadius: 6,
                      color: aiLoading ? 'var(--c-faint)' : '#818cf8',
                      cursor: aiLoading ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700,
                    }}>
                      {aiLoading ? 'Analysing…' : aiExplanation ? 'Refresh' : 'Get Analysis'}
                    </button>
                  </div>

                  {/* Provider toggle */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: aiExplanation || aiWarnings.length > 0 ? 12 : 0 }}>
                    {([
                      { id: 'claude',   label: 'Claude',   color: '#d97706' },
                      { id: 'openai',   label: 'GPT-4o',   color: '#10b981' },
                      { id: 'deepseek', label: 'DeepSeek', color: '#6366f1' },
                    ] as { id: AiProvider; label: string; color: string }[]).map(p => (
                      <button key={p.id} onClick={() => { setAiProvider(p.id); setAiExplanation(null); }} style={{
                        padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700,
                        background: aiProvider === p.id ? `${p.color}22` : 'var(--c-inner)',
                        color: aiProvider === p.id ? p.color : 'var(--c-faintest)',
                        border: `1px solid ${aiProvider === p.id ? `${p.color}55` : 'var(--c-border)'}`,
                      }}>
                        {p.label}
                      </button>
                    ))}
                    <span style={{ fontSize: 10, color: 'var(--c-faintest)', marginLeft: 4, alignSelf: 'center' }}>
                      {aiProvider === 'claude' ? 'ANTHROPIC_API_KEY' : aiProvider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY'}
                    </span>
                  </div>

                  {/* Misalignment warnings */}
                  {aiWarnings.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
                      {aiWarnings.map((w, i) => (
                        <div key={i} style={{ padding: '7px 10px', background: '#eab30822', border: '1px solid #eab30844', borderRadius: 6, color: '#eab308', fontSize: 12 }}>
                          ⚠ {w}
                        </div>
                      ))}
                    </div>
                  )}

                  {aiExplanation && (
                    <div style={{ color: 'var(--c-subtle)', fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {aiExplanation}
                    </div>
                  )}
                </div>

                {/* ── HISTORICAL AVG MOVEMENT ─────────────────────────── */}
                {result.avgMoves && (() => {
                  const m  = result.avgMoves!;
                  const sm = result.spotAvgMoves ?? null;
                  const ms = result.masterSignal;
                  const isLong = result.direction === 'LONG';

                  // P&L sizing (reuse same calc as Trade Levels)
                  const slDist2 = Math.abs(ms.entry - ms.stopLoss) / ms.entry;
                  const effLev2 = userLeverage || ms.leverage;
                  const riskAmt2 = accountSize * riskPct / 100;
                  const qty2 = typeof manualMarginUsdt === 'number' && manualMarginUsdt > 0
                    ? (manualMarginUsdt * effLev2) / ms.entry
                    : slDist2 > 0 ? riskAmt2 / (ms.entry * slDist2) : 0;
                  const pnl2 = (price: number) => qty2 * (price - ms.entry) * (isLong ? 1 : -1);

                  const tpRows = [
                    { label: 'TP1', price: ms.tp1, pct: Math.abs(ms.tp1 - ms.entry) / ms.entry * 100, split: '50%' },
                    { label: 'TP2', price: ms.tp2, pct: Math.abs(ms.tp2 - ms.entry) / ms.entry * 100, split: '25%' },
                    { label: 'TP3', price: ms.tp3, pct: Math.abs(ms.tp3 - ms.entry) / ms.entry * 100, split: '25%' },
                  ];
                  const maxBar = Math.max(m.daily, ...tpRows.map(t => t.pct)) * 1.15;

                  const verdictOf = (ratio: number) =>
                    ratio <= 0.4  ? { text: 'Scalp',       color: '#06b6d4' } :
                    ratio <= 0.75 ? { text: 'Intraday',    color: '#22c55e' } :
                    ratio <= 1.1  ? { text: 'Full Session', color: '#4ade80' } :
                    ratio <= 1.8  ? { text: 'Overnight',   color: '#eab308' } :
                    ratio <= 3.0  ? { text: 'Multi-Day',   color: '#f97316' } :
                                    { text: 'Extended',    color: '#ef4444' };
                  const sessionsOf = (ratio: number) =>
                    ratio <= 1   ? '< 1 day'  :
                    ratio <= 2   ? '1–2 days' :
                    ratio <= 3   ? '2–3 days' : '3+ days';

                  return (
                    <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--c-muted)', marginBottom: 14, letterSpacing: '0.06em' }}>
                        AVG HISTORICAL RANGE
                      </div>

                      {/* Futures vs Spot comparison table */}
                      <div style={{ display: 'grid', gridTemplateColumns: sm ? '56px 1fr 1fr 1fr' : '56px 1fr 1fr 1fr', gap: 6, marginBottom: 14 }}>
                        <div />
                        {['4H', '8H', 'DAILY'].map(lbl => (
                          <div key={lbl} style={{ textAlign: 'center', fontSize: 10, color: 'var(--c-faint)', fontWeight: 700, letterSpacing: '0.06em', paddingBottom: 4 }}>{lbl}</div>
                        ))}
                        {/* Futures row */}
                        <div style={{ fontSize: 10, color: '#818cf8', fontWeight: 700, display: 'flex', alignItems: 'center' }}>PERP</div>
                        {[m.h4, m.h8, m.daily].map((val, i) => (
                          <div key={i} style={{ padding: '6px 4px', background: 'var(--c-inner)', borderRadius: 6, border: '1px solid #6366f122', textAlign: 'center' }}>
                            <div style={{ fontSize: 14, fontWeight: 800, color: '#818cf8' }}>±{val.toFixed(2)}%</div>
                          </div>
                        ))}
                        {/* Spot row */}
                        {sm && <>
                          <div style={{ fontSize: 10, color: '#fbbf24', fontWeight: 700, display: 'flex', alignItems: 'center' }}>SPOT</div>
                          {[sm.h4, sm.h8, sm.daily].map((val, i) => {
                            const diff = val - [m.h4, m.h8, m.daily][i];
                            return (
                              <div key={i} style={{ padding: '6px 4px', background: 'var(--c-inner)', borderRadius: 6, border: '1px solid #f59e0b22', textAlign: 'center' }}>
                                <div style={{ fontSize: 14, fontWeight: 800, color: '#fbbf24' }}>±{val.toFixed(2)}%</div>
                                <div style={{ fontSize: 9, color: Math.abs(diff) < 0.05 ? 'var(--c-faint)' : diff > 0 ? '#f97316' : '#22c55e', marginTop: 1 }}>
                                  {diff >= 0 ? '+' : ''}{diff.toFixed(2)}%
                                </div>
                              </div>
                            );
                          })}
                        </>}
                      </div>

                      {/* TP reachability cards */}
                      <div style={{ fontSize: 11, color: 'var(--c-faint)', fontWeight: 700, letterSpacing: '0.06em', marginBottom: 10 }}>
                        TP REACHABILITY
                      </div>

                      {/* Scale reference bar */}
                      <div style={{ position: 'relative', height: 24, marginBottom: 18 }}>
                        <div style={{ position: 'absolute', inset: '10px 0 0 0', background: 'var(--c-border)', borderRadius: 4 }} />
                        {[
                          { val: m.h4,    label: `4H ${m.h4.toFixed(2)}%`,       color: 'var(--c-faint)' },
                          { val: m.h8,    label: `8H ${m.h8.toFixed(2)}%`,       color: 'var(--c-dim)' },
                          { val: m.daily, label: `Day ${m.daily.toFixed(2)}%`,   color: 'var(--c-muted)' },
                        ].map(({ val, label, color }) => (
                          <div key={label} style={{ position: 'absolute', left: `${(val / maxBar) * 100}%`, top: 0, bottom: 0 }}>
                            <div style={{ position: 'absolute', top: 10, bottom: 0, width: 2, background: color, borderRadius: 1 }} />
                            <span style={{ position: 'absolute', top: 0, fontSize: 9, color, whiteSpace: 'nowrap', transform: 'translateX(-50%)' }}>{label}</span>
                          </div>
                        ))}
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {tpRows.map(({ label, price, pct, split }) => {
                          const ratioDay  = m.daily > 0 ? pct / m.daily : 0;
                          const ratio4h   = m.h4    > 0 ? pct / m.h4    : 0;
                          const ratio8h   = m.h8    > 0 ? pct / m.h8    : 0;
                          const spotRatio = sm && sm.daily > 0 ? pct / sm.daily : null;
                          const v = verdictOf(ratioDay);
                          const barW = Math.min(100, (pct / maxBar) * 100);
                          const dollarPnl = qty2 > 0 ? pnl2(price) : null;
                          const fmt2 = (x: number) => x < 1 ? x.toFixed(6) : x < 100 ? x.toFixed(4) : x.toFixed(2);

                          return (
                            <div key={label} style={{ padding: 12, background: 'var(--c-inner)', borderRadius: 9, border: `1px solid ${v.color}33`, borderLeft: `4px solid ${v.color}` }}>
                              {/* Row 1: label + price + pct + P&L + verdict */}
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                                <div>
                                  <span style={{ fontWeight: 800, fontSize: 13, color: v.color }}>{label}</span>
                                  <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--c-faint)' }}>{split} exit</span>
                                  <div style={{ marginTop: 3, fontSize: 13, color: 'var(--c-text)', fontWeight: 700 }}>
                                    ${fmt2(price)}
                                    <span style={{ marginLeft: 8, fontSize: 11, color: v.color }}>+{pct.toFixed(2)}%</span>
                                    {dollarPnl !== null && (
                                      <span style={{ marginLeft: 8, fontSize: 12, color: '#22c55e', fontWeight: 800 }}>(+${dollarPnl.toFixed(2)})</span>
                                    )}
                                  </div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                  <div style={{ padding: '3px 10px', background: v.color + '22', border: `1px solid ${v.color}44`, borderRadius: 20, fontSize: 11, color: v.color, fontWeight: 700, whiteSpace: 'nowrap' }}>
                                    {v.text}
                                  </div>
                                  <div style={{ fontSize: 10, color: 'var(--c-faint)', marginTop: 4 }}>{sessionsOf(ratioDay)}</div>
                                </div>
                              </div>

                              {/* Row 2: progress bar with markers */}
                              <div style={{ position: 'relative', height: 14, background: '#1a1a28', borderRadius: 7, overflow: 'hidden', marginBottom: 8 }}>
                                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${barW}%`, background: `linear-gradient(90deg, ${v.color}88, ${v.color}cc)`, borderRadius: 7 }} />
                                {[m.h4, m.h8, m.daily].map((ref, i) => (
                                  <div key={i} style={{ position: 'absolute', left: `${(ref / maxBar) * 100}%`, top: 0, bottom: 0, width: 1.5, background: ['var(--c-faintest)','var(--c-faint)','var(--c-dim)'][i] }} />
                                ))}
                              </div>

                              {/* Row 3: multiples */}
                              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11 }}>
                                <span><span style={{ color: 'var(--c-faint)' }}>vs 4H </span><span style={{ color: ratio4h <= 1 ? '#22c55e' : '#eab308', fontWeight: 700 }}>{ratio4h.toFixed(1)}×</span></span>
                                <span><span style={{ color: 'var(--c-faint)' }}>vs 8H </span><span style={{ color: ratio8h <= 1 ? '#22c55e' : '#eab308', fontWeight: 700 }}>{ratio8h.toFixed(1)}×</span></span>
                                <span><span style={{ color: 'var(--c-faint)' }}>vs Day </span><span style={{ color: v.color, fontWeight: 700 }}>{ratioDay.toFixed(2)}×</span></span>
                                {spotRatio !== null && (
                                  <span><span style={{ color: 'var(--c-faint)' }}>vs Spot Day </span><span style={{ color: '#fbbf24', fontWeight: 700 }}>{spotRatio.toFixed(2)}×</span></span>
                                )}
                                <span style={{ marginLeft: 'auto', color: 'var(--c-faintest)', fontWeight: 600 }}>≈ {sessionsOf(ratioDay)}</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* ── TRADE EXECUTION ─────────────────────────────────── */}
                {canTrade && (
                  <div style={{
                    padding: 16, borderRadius: 10,
                    background: result.direction === 'LONG' ? '#052e1611' : '#450a0a11',
                    border: `2px solid ${result.direction === 'LONG' ? '#16a34a55' : '#ef444455'}`,
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: dirColor, marginBottom: 14 }}>
                      {result.direction === 'LONG' ? '▲' : '▼'} ENTER {result.direction} — {result.symbol}
                    </div>

                    {/* Sizing row */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
                      <div>
                        <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 4 }}>Risk % of balance</label>
                        <input type="number" min={0.1} max={10} step={0.1} value={riskPct}
                          onChange={e => { setRiskPct(parseFloat(e.target.value) || 1); setManualMarginUsdt(''); }}
                          style={{ width: '100%', padding: '9px 10px', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 14, boxSizing: 'border-box' }} />
                      </div>
                      <div>
                        <label style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>
                          <span style={{ color: manualMarginUsdt !== '' ? '#6366f1' : 'var(--c-dim)' }}>
                            Margin USDT {manualMarginUsdt !== '' ? '(override active)' : '(optional override)'}
                          </span>
                        </label>
                        <input type="number" min={1} step={1} value={manualMarginUsdt}
                          onChange={e => setManualMarginUsdt(e.target.value === '' ? '' : parseFloat(e.target.value) || '')}
                          placeholder={`auto ≈ $${(accountSize * riskPct / 100).toFixed(0)} risk`}
                          style={{ width: '100%', padding: '9px 10px', background: 'var(--c-inner)',
                            border: `1px solid ${manualMarginUsdt !== '' ? '#6366f155' : 'var(--c-border)'}`,
                            borderRadius: 6, color: manualMarginUsdt !== '' ? '#818cf8' : 'var(--c-text)',
                            outline: 'none', fontSize: 14, boxSizing: 'border-box' }} />
                      </div>
                    </div>

                    {/* Position preview */}
                    {(() => {
                      const ep = result.masterSignal.entry;
                      const sl = result.masterSignal.stopLoss;
                      const effLev = typeof userLeverage === 'number' ? userLeverage : result.masterSignal.leverage;
                      const slDist = Math.abs(ep - sl) / ep;
                      let margin: number, notional: number, qty: number, riskDollars: number;
                      if (typeof manualMarginUsdt === 'number' && manualMarginUsdt > 0) {
                        margin   = manualMarginUsdt;
                        notional = margin * effLev;
                        qty      = notional / ep;
                        riskDollars = notional * slDist;
                      } else {
                        riskDollars = accountSize * riskPct / 100;
                        qty      = slDist > 0 ? riskDollars / (ep * slDist) : 0;
                        notional = qty * ep;
                        margin   = notional / effLev;
                      }
                      const fmtP = (v: number) => v < 1 ? v.toFixed(6) : v < 100 ? v.toFixed(4) : v.toFixed(2);
                      return (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 10px', background: 'var(--c-inner)', borderRadius: 6, marginBottom: 10, fontSize: 11 }}>
                          <span style={{ color: 'var(--c-faint)' }}>Qty <span style={{ color: 'var(--c-text)', fontWeight: 700 }}>{fmtP(qty)}</span></span>
                          <span style={{ color: 'var(--c-faintest)' }}>·</span>
                          <span style={{ color: 'var(--c-faint)' }}>Notional <span style={{ color: 'var(--c-text)', fontWeight: 700 }}>${notional.toFixed(0)}</span></span>
                          <span style={{ color: 'var(--c-faintest)' }}>·</span>
                          <span style={{ color: 'var(--c-faint)' }}>Margin <span style={{ color: '#818cf8', fontWeight: 700 }}>${margin.toFixed(2)}</span></span>
                          <span style={{ color: 'var(--c-faintest)' }}>·</span>
                          <span style={{ color: 'var(--c-faint)' }}>Risk at SL <span style={{ color: '#ef4444', fontWeight: 700 }}>${riskDollars.toFixed(2)}</span></span>
                        </div>
                      );
                    })()}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                      <div>
                        <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 4 }}>
                          Leverage
                          <span style={{ color: '#818cf8', marginLeft: 6 }}>engine rec: {result.masterSignal.leverage}×</span>
                        </label>
                        <input type="number" min={1} max={200}
                          value={userLeverage}
                          onChange={e => setUserLeverage(parseInt(e.target.value) || 1)}
                          placeholder={String(result.masterSignal.leverage)}
                          style={{ width: '100%', padding: '9px 10px', background: 'var(--c-inner)',
                            border: '1px solid #6366f144',
                            borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 14, boxSizing: 'border-box' }} />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                        {manualMarginUsdt !== '' && (
                          <button onClick={() => setManualMarginUsdt('')}
                            style={{ padding: '9px 12px', background: '#6366f122', border: '1px solid #6366f133', borderRadius: 6, color: '#818cf8', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                            Clear USDT override
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Order type + force */}
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, overflow: 'hidden' }}>
                        {(['Limit', 'Market'] as const).map(t => (
                          <button key={t} onClick={() => setOrderType(t)} style={{
                            padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                            background: orderType === t ? '#6366f133' : 'transparent',
                            color: orderType === t ? '#818cf8' : 'var(--c-faint)',
                          }}>{t}</button>
                        ))}
                      </div>
                      {orderType === 'Limit' && <span style={{ fontSize: 11, color: '#22c55e' }}>saves ~0.035% fees</span>}
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginLeft: 'auto', fontSize: 12, color: 'var(--c-dim)' }}>
                        <input type="checkbox" checked={forceTrade} onChange={e => setForceTrade(e.target.checked)} style={{ accentColor: '#6366f1' }} />
                        Force (override funding check)
                      </label>
                    </div>

                    {/* Mode reminder */}
                    <div style={{ marginBottom: 12, padding: '7px 12px', borderRadius: 6, fontSize: 12,
                      background: liveMode ? '#ef444422' : '#16a34a22',
                      color: liveMode ? '#ef4444' : '#22c55e',
                    }}>
                      {liveMode ? '⚡ LIVE — real order fires on Bybit' : '📄 PAPER — simulated, no real money'}
                      {!liveMode && <span style={{ color: 'var(--c-faintest)', marginLeft: 6 }}>Switch in Settings tab</span>}
                    </div>

                    {/* BIG BUTTON */}
                    <button onClick={enterTrade} disabled={tradeLoading} style={{
                      width: '100%', padding: '14px 0', border: 'none', borderRadius: 8,
                      fontWeight: 800, fontSize: 16, letterSpacing: '0.5px',
                      cursor: tradeLoading ? 'not-allowed' : 'pointer',
                      background: tradeLoading ? 'var(--c-border)'
                        : result.direction === 'LONG' ? 'linear-gradient(135deg, #16a34a, #15803d)'
                        : 'linear-gradient(135deg, #dc2626, #b91c1c)',
                      color: tradeLoading ? 'var(--c-faint)' : '#fff',
                      boxShadow: tradeLoading ? 'none' : `0 4px 20px ${result.direction === 'LONG' ? '#16a34a44' : '#dc262644'}`,
                    }}>
                      {tradeLoading ? 'Placing order…'
                        : `${result.direction === 'LONG' ? '▲ BUY LONG' : '▼ SELL SHORT'} ${result.symbol}`}
                    </button>
                  </div>
                )}

                {/* Trade result */}
                {tradeResult && (
                  <div style={{
                    padding: 14, borderRadius: 10,
                    background: tradeResult.error ? '#ef444422' : tradeResult.rejected ? '#eab30822' : '#16a34a22',
                    border: `1px solid ${tradeResult.error ? '#ef444444' : tradeResult.rejected ? '#eab30844' : '#16a34a44'}`,
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8,
                      color: tradeResult.error ? '#ef4444' : tradeResult.rejected ? '#eab308' : '#22c55e' }}>
                      {tradeResult.error ? '✗ Error' : tradeResult.rejected ? '⚠ Rejected' : tradeResult.paper ? '📄 Paper Trade Simulated' : '✓ Order Placed'}
                    </div>
                    {tradeResult.message && <div style={{ color: 'var(--c-subtle)', fontSize: 13, marginBottom: 6 }}>{tradeResult.message}</div>}
                    {tradeResult.error && <div style={{ color: '#ef4444', fontSize: 13 }}>{tradeResult.error}</div>}
                    {tradeResult.leverageWarning && <div style={{ color: '#eab308', fontSize: 12, marginBottom: 6 }}>{tradeResult.leverageWarning}</div>}
                    {(tradeResult.paper || tradeResult.success) && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: 'var(--c-muted)' }}>
                        {tradeResult.orderId && <div>Order ID: <span style={{ color: 'var(--c-text)' }}>{tradeResult.orderId}</span></div>}
                        {tradeResult.qty !== undefined && <div>Qty: <span style={{ color: 'var(--c-text)' }}>{tradeResult.qty}</span></div>}
                        {tradeResult.balance && <div>Balance: <span style={{ color: 'var(--c-text)' }}>${tradeResult.balance}</span></div>}
                        {tradeResult.riskAmt && <div>Risk amt: <span style={{ color: '#ef4444' }}>${tradeResult.riskAmt}</span></div>}
                        {tradeResult.feeEstimate && <div>Fees: <span style={{ color: '#eab308' }}>${tradeResult.feeEstimate.totalFee}</span>
                          {tradeResult.feeEstimate.note && <span style={{ color: 'var(--c-faintest)' }}> · {tradeResult.feeEstimate.note}</span>}</div>}
                        {tradeResult.simulated && (
                          <div style={{ marginTop: 4, color: 'var(--c-faint)' }}>
                            {tradeResult.simulated.symbol} {tradeResult.simulated.direction} @ ${tradeResult.simulated.entry} · {tradeResult.simulated.leverage}× · {tradeResult.simulated.riskPct}% risk
                          </div>
                        )}
                      </div>
                    )}
                    {tradeResult.rejected && !forceTrade && (
                      <button onClick={() => setForceTrade(true)} style={{
                        marginTop: 8, padding: '6px 14px', background: '#eab30822',
                        border: '1px solid #eab30844', borderRadius: 6, color: '#eab308',
                        cursor: 'pointer', fontSize: 12, fontWeight: 600,
                      }}>
                        Enable force override
                      </button>
                    )}
                  </div>
                )}

                {/* Verdict */}
                <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: 'var(--c-muted)' }}>VERDICT</div>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.8, color: 'var(--c-subtle)', margin: 0 }}>
                    {result.verdict}
                  </pre>
                </div>

                {/* Raw signal toggle */}
                <button onClick={() => setShowRaw(v => !v)} style={{
                  padding: '9px 0', background: 'none', border: '1px solid var(--c-border)',
                  borderRadius: 8, color: 'var(--c-faint)', cursor: 'pointer', fontSize: 13,
                }}>
                  {showRaw ? '▲ Hide' : '▼ Show'} raw signal text
                </button>

                {showRaw && (
                  <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                    <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, color: 'var(--c-dim)', margin: 0 }}>
                      {result.masterSignal.signalText}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ══════════════════ RADAR TAB ══════════════════ */}
        {tab === 'radar' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Header + scan button */}
            <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--c-text)' }}>🔭 Pre-Pump Radar</div>
                  <div style={{ fontSize: 12, color: 'var(--c-dim)', marginTop: 3 }}>
                    Scans ALL Bybit perpetuals for liquidity sweeps, CHoCH, BOS &amp; volume spikes
                  </div>
                </div>
                <button
                  onClick={runRadar}
                  disabled={radarLoading}
                  style={{
                    padding: '10px 20px', background: radarLoading ? '#3730a3' : '#6366f1', color: '#fff',
                    border: 'none', borderRadius: 8, cursor: radarLoading ? 'not-allowed' : 'pointer',
                    fontWeight: 700, fontSize: 13,
                  }}
                >
                  {radarLoading ? '⟳ Scanning…' : '▶ Run Scan'}
                </button>
              </div>
              {radarResult && (
                <div style={{ fontSize: 11, color: 'var(--c-faintest)' }}>
                  Scanned {radarResult.scanned} pairs · Found {radarResult.count} signals · {(radarResult.elapsed / 1000).toFixed(1)}s
                </div>
              )}
            </div>

            {/* How to use */}
            {!radarResult && !radarLoading && (
              <div style={{ padding: 20, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--c-muted)', marginBottom: 10 }}>What Radar detects</div>
                {[
                  ['💧 SWEEP', 'Liquidity grab — price took out a swing high/low then reversed. Classic pump setup.'],
                  ['🔄 CHOCH', 'Change of Character — trend shifted. First signal of a potential reversal.'],
                  ['🔨 BOS', 'Break of Structure — new swing high/low confirmed. Trend continuation signal.'],
                  ['⚡ VOL_SPIKE', 'Volume > 1.8× average — unusual interest, often precedes a big move.'],
                  ['📈 RSI_BOUNCE', 'RSI recovering from oversold zone — exhaustion of sellers.'],
                  ['🔀 BB_SQUEEZE', 'Bollinger Bands tight — compressed volatility about to expand.'],
                ].map(([tag, desc]) => (
                  <div key={tag} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--c-border)', alignItems: 'flex-start' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#818cf8', minWidth: 110, paddingTop: 1 }}>{tag}</span>
                    <span style={{ fontSize: 12, color: 'var(--c-dim)', lineHeight: 1.5 }}>{desc}</span>
                  </div>
                ))}
              </div>
            )}

            {radarLoading && (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--c-faint)', background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>🔭</div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Scanning all Bybit perpetuals…</div>
                <div style={{ fontSize: 12, color: 'var(--c-faintest)', marginTop: 6 }}>Fetching 4h + 1h klines · detecting ICT structures</div>
              </div>
            )}

            {radarResult?.error && (
              <div style={{ padding: 16, background: '#ef444411', border: '1px solid #ef444433', borderRadius: 10, color: '#ef4444', fontSize: 13 }}>
                ✗ {radarResult.error}
              </div>
            )}

            {radarResult && radarResult.signals.length > 0 && (
              <>
                {/* Filter bar */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {(['ALL', 'LONG', 'SHORT'] as const).map(f => (
                    <button key={f} onClick={() => setRadarFilter(f)} style={{
                      padding: '6px 16px', borderRadius: 6, border: '1px solid var(--c-border)', cursor: 'pointer',
                      background: radarFilter === f ? '#6366f122' : 'var(--c-card)',
                      color: radarFilter === f ? '#818cf8' : 'var(--c-faint)',
                      fontWeight: radarFilter === f ? 700 : 400, fontSize: 12,
                    }}>
                      {f === 'ALL' ? `All (${radarResult.signals.length})` : f === 'LONG' ? `🟢 Long (${radarResult.signals.filter(s => s.direction === 'LONG').length})` : `🔴 Short (${radarResult.signals.filter(s => s.direction === 'SHORT').length})`}
                    </button>
                  ))}
                </div>

                {/* Signal cards */}
                {radarResult.signals
                  .filter(s => radarFilter === 'ALL' || s.direction === radarFilter)
                  .map(sig => {
                    const isLong = sig.direction === 'LONG';
                    const dirColor = isLong ? '#22c55e' : '#ef4444';
                    const vol = sig.volume24h >= 1e9 ? `$${(sig.volume24h/1e9).toFixed(2)}B` : sig.volume24h >= 1e6 ? `$${(sig.volume24h/1e6).toFixed(0)}M` : `$${(sig.volume24h/1e3).toFixed(0)}K`;
                    const SIGNAL_META: Record<string, { emoji: string; label: string; color: string }> = {
                      SWEEP:      { emoji: '💧', label: 'Sweep',      color: '#818cf8' },
                      CHOCH:      { emoji: '🔄', label: 'CHoCH',      color: '#a78bfa' },
                      BOS:        { emoji: '🔨', label: 'BOS',        color: '#6366f1' },
                      VOL_SPIKE:  { emoji: '⚡', label: 'Vol Spike',  color: '#eab308' },
                      RSI_BOUNCE: { emoji: '📈', label: 'RSI Bounce', color: '#22c55e' },
                      RSI_TOP:    { emoji: '📉', label: 'RSI Top',    color: '#ef4444' },
                      BB_SQUEEZE: { emoji: '🔀', label: 'BB Squeeze', color: '#f59e0b' },
                      MOMENTUM:   { emoji: '🚀', label: 'Momentum',   color: '#06b6d4' },
                    };
                    return (
                      <div key={sig.symbol} style={{ padding: 14, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                        {/* Top row */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--c-text)' }}>{sig.symbol}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: `${dirColor}22`, color: dirColor }}>
                              {isLong ? '▲ LONG' : '▼ SHORT'}
                            </span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: sig.score >= 70 ? '#22c55e' : sig.score >= 50 ? '#eab308' : 'var(--c-dim)' }}>
                              {sig.score}/100
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span style={{ fontSize: 12, color: sig.change24h >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                              {sig.change24h >= 0 ? '+' : ''}{sig.change24h.toFixed(2)}%
                            </span>
                            <button
                              onClick={() => { setSymbol(sig.symbol); scan(sig.symbol); setTab('scan'); }}
                              style={{ padding: '5px 12px', background: '#6366f122', border: '1px solid #6366f144', borderRadius: 6, color: '#818cf8', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
                            >
                              Deep Scan →
                            </button>
                          </div>
                        </div>

                        {/* Signal tags */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                          {sig.signals.map(s => {
                            const m = SIGNAL_META[s] ?? { emoji: '•', label: s, color: 'var(--c-muted)' };
                            return (
                              <span key={s} style={{
                                padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
                                background: `${m.color}22`, color: m.color, border: `1px solid ${m.color}44`,
                              }}>
                                {m.emoji} {m.label}
                              </span>
                            );
                          })}
                        </div>

                        {/* Reason */}
                        <div style={{ fontSize: 12, color: 'var(--c-dim)', lineHeight: 1.5 }}>{sig.reason}</div>

                        {/* Price + volume */}
                        <div style={{ display: 'flex', gap: 16, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--c-border)' }}>
                          <span style={{ fontSize: 11, color: 'var(--c-faint)' }}>
                            Price: <span style={{ color: 'var(--c-text)', fontWeight: 600 }}>${sig.price.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--c-faint)' }}>
                            Vol 24h: <span style={{ color: 'var(--c-text)', fontWeight: 600 }}>{vol}</span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
              </>
            )}

            {radarResult && radarResult.signals.length === 0 && !radarResult.error && (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--c-faint)', background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🔭</div>
                <div>No strong pre-pump signals found right now</div>
                <div style={{ fontSize: 12, color: 'var(--c-faintest)', marginTop: 4 }}>Try again later — market conditions change fast</div>
              </div>
            )}

          </div>
        )}

        {/* ══════════════════ CALCULATOR TAB ══════════════════ */}
        {tab === 'calc' && <RiskCalculator />}

        {/* ══════════════════ TRADES TAB ══════════════════ */}
        {tab === 'trades' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {trades.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--c-faint)', background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📒</div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>No trades logged yet</div>
                <div style={{ fontSize: 13 }}>Enter a trade from the Scanner tab and it will appear here.</div>
              </div>
            ) : (
              <>
                {/* Summary row */}
                {(() => {
                  const allTrades = trades;
                  const closed = allTrades.filter(t => t.status !== 'open');
                  const totalPnl = allTrades.reduce((s, t) => s + (t.pnlDollars ?? 0), 0);
                  const openCount = allTrades.filter(t => t.status === 'open').length;
                  // Tiered TP rates: count any trade (open or closed) that hit each milestone
                  const n = allTrades.length;
                  const tp1Count = allTrades.filter(t => t.tp1Hit || t.status === 'tp3').length;
                  const tp2Count = allTrades.filter(t => t.tp2Hit || t.status === 'tp3').length;
                  const tp3Count = allTrades.filter(t => t.status === 'tp3').length;
                  const slCount  = allTrades.filter(t => t.status === 'sl').length;
                  const pct = (c: number) => n ? `${Math.round(c / n * 100)}%` : '—';
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {/* Top row: totals */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                        {[
                          { label: 'Total', value: n, color: 'var(--c-text)' },
                          { label: 'Open', value: openCount, color: '#6366f1' },
                          { label: 'Closed', value: closed.length, color: 'var(--c-muted)' },
                          { label: 'Net P&L', value: `$${totalPnl.toFixed(0)}`, color: totalPnl >= 0 ? '#22c55e' : '#ef4444' },
                        ].map(({ label, value, color }) => (
                          <div key={label} style={{ padding: '10px 12px', background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 8, textAlign: 'center' }}>
                            <div style={{ color: 'var(--c-faint)', fontSize: 11 }}>{label}</div>
                            <div style={{ color, fontWeight: 700, fontSize: 16 }}>{value}</div>
                          </div>
                        ))}
                      </div>
                      {/* Tiered TP stats */}
                      {n > 0 && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                          {[
                            { label: 'TP1 Rate', value: pct(tp1Count), sub: `${tp1Count}/${n}`, color: '#4ade80' },
                            { label: 'TP2 Rate', value: pct(tp2Count), sub: `${tp2Count}/${n}`, color: '#22c55e' },
                            { label: 'TP3 (Full)', value: pct(tp3Count), sub: `${tp3Count}/${n}`, color: '#16a34a' },
                            { label: 'SL Rate', value: pct(slCount), sub: `${slCount}/${n}`, color: '#ef4444' },
                          ].map(({ label, value, sub, color }) => (
                            <div key={label} style={{ padding: '8px 10px', background: 'var(--c-card)', border: `1px solid ${color}33`, borderRadius: 8, textAlign: 'center' }}>
                              <div style={{ color: 'var(--c-faint)', fontSize: 10 }}>{label}</div>
                              <div style={{ color, fontWeight: 700, fontSize: 15 }}>{value}</div>
                              <div style={{ color: 'var(--c-faintest)', fontSize: 10 }}>{sub}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Open trades header */}
                {trades.some(t => t.status === 'open') && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#6366f1', letterSpacing: '0.08em' }}>OPEN POSITIONS</span>
                    <span style={{ fontSize: 10, color: liveRefreshing ? '#22c55e' : 'var(--c-faintest)' }}>
                      {liveRefreshing ? '● live' : '○ 8s refresh'}
                    </span>
                  </div>
                )}

                {/* Trade grid */}
                {(() => {
                  const CARD_ACCENT = ['#6366f1','#f59e0b','#06b6d4','#a855f7','#ec4899','#10b981','#f97316','#84cc16'];
                  return (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
                {trades.map((t, tIdx) => {
                  const accentColor = CARD_ACCENT[tIdx % CARD_ACCENT.length];
                  const dirColor = t.direction === 'LONG' ? '#22c55e' : '#ef4444';
                  const statusColor: Record<string, string> = { open: '#6366f1', tp3: '#22c55e', sl: '#ef4444', manual: 'var(--c-muted)' };
                  const isOpen = t.status === 'open';

                  // Live P&L calculations
                  const live = livePrices[t.symbol];
                  const currentPrice = live?.price ?? null;
                  const slDist = Math.abs(t.entry - t.stopLoss) / t.entry;
                  const riskAmt = accountSize * t.riskPct / 100;
                  const unrealizedR = currentPrice !== null
                    ? ((currentPrice - t.entry) / t.entry / slDist) * (t.direction === 'LONG' ? 1 : -1)
                    : null;
                  const unrealizedDollar = unrealizedR !== null ? unrealizedR * riskAmt : null;
                  const unrealizedPct = currentPrice !== null
                    ? ((currentPrice - t.entry) / t.entry * 100 * t.leverage) * (t.direction === 'LONG' ? 1 : -1)
                    : null;
                  const pnlColor = unrealizedDollar === null ? 'var(--c-faint)' : unrealizedDollar >= 0 ? '#22c55e' : '#ef4444';

                  // Breakeven price: entry ± round-trip fees (taker in 0.055% + maker out 0.020%)
                  const FEE_BE = 0.00075;
                  const bePrice = t.direction === 'LONG'
                    ? t.entry * (1 + FEE_BE)
                    : t.entry * (1 - FEE_BE);
                  const beDistFromCurrent = currentPrice !== null
                    ? (currentPrice - bePrice) / bePrice * (t.direction === 'LONG' ? 1 : -1)
                    : null;
                  const inProfitZone = beDistFromCurrent !== null && beDistFromCurrent > 0;

                  // Price bar: position from SL to TP3
                  const barMin = t.direction === 'LONG' ? t.stopLoss : t.tp3;
                  const barMax = t.direction === 'LONG' ? t.tp3 : t.stopLoss;
                  const priceBarPct = currentPrice !== null
                    ? Math.min(100, Math.max(0, (currentPrice - barMin) / (barMax - barMin) * 100))
                    : null;
                  // Level markers
                  const markerEntry = Math.min(100, Math.max(0, (t.entry - barMin) / (barMax - barMin) * 100));
                  const markerBE    = Math.min(100, Math.max(0, (bePrice  - barMin) / (barMax - barMin) * 100));
                  const markerTp1   = Math.min(100, Math.max(0, (t.tp1   - barMin) / (barMax - barMin) * 100));
                  const markerTp2   = Math.min(100, Math.max(0, (t.tp2   - barMin) / (barMax - barMin) * 100));

                  const secsAgo = live ? Math.round((Date.now() - live.updatedAt) / 1000) : null;

                  return (
                    <div key={t.id} style={{
                      padding: 12, background: 'var(--c-card)',
                      border: `1px solid ${accentColor}44`,
                      borderLeft: `4px solid ${accentColor}`,
                      borderRadius: 10,
                      boxShadow: isOpen ? `0 0 18px ${accentColor}18` : 'none',
                      minWidth: 0,
                    }}>
                      {/* Header row */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                        <div>
                          <span style={{ fontWeight: 800, fontSize: 15 }}>{t.symbol}</span>
                          <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: `${dirColor}22`, color: dirColor }}>
                            {t.direction === 'LONG' ? '▲' : '▼'} {t.direction}
                          </span>
                          <span style={{ marginLeft: 6, padding: '2px 8px', borderRadius: 4, fontSize: 11, background: 'var(--c-border)', color: 'var(--c-dim)' }}>
                            {t.mode.toUpperCase()} · {t.leverage}× · {t.bestSetup}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: `${statusColor[t.status]}22`, color: statusColor[t.status] }}>
                            {t.status.toUpperCase()}
                          </span>
                          <button onClick={() => deleteTrade(t.id)} style={{ background: 'none', border: 'none', color: 'var(--c-faintest)', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
                        </div>
                      </div>

                      {/* TP milestone badges */}
                      {(t.tp1Hit || t.tp2Hit || t.tp3Hit) && (
                        <div style={{ display: 'flex', gap: 5, marginBottom: 8, flexWrap: 'wrap' }}>
                          {t.tp1Hit && <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: '#4ade8022', color: '#4ade80', border: '1px solid #4ade8044' }}>✓ TP1</span>}
                          {t.tp2Hit && <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44' }}>✓ TP2</span>}
                          {t.tp3Hit && <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: '#16a34a22', color: '#16a34a', border: '1px solid #16a34a44' }}>✓ TP3 FULL</span>}
                        </div>
                      )}

                      {/* Live price + unrealized P&L (open trades only) */}
                      {isOpen && (
                        <div style={{ marginBottom: 12 }}>
                          {/* 2×2 stats grid */}
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginBottom: 10 }}>
                            {/* Live price */}
                            <div style={{ padding: '9px 10px', background: 'var(--c-inner)', borderRadius: 8 }}>
                              <div style={{ fontSize: 9, color: 'var(--c-faint)', marginBottom: 2 }}>
                                LIVE PRICE {secsAgo !== null && <span style={{ color: secsAgo < 15 ? '#22c55e' : 'var(--c-faint)' }}>{secsAgo}s</span>}
                              </div>
                              <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--c-text)' }}>
                                {currentPrice !== null ? `$${currentPrice.toFixed(currentPrice < 1 ? 6 : currentPrice < 100 ? 4 : 2)}` : '—'}
                              </div>
                            </div>
                            {/* Unrealized P&L */}
                            <div style={{ padding: '9px 10px', background: unrealizedDollar !== null ? `${pnlColor}11` : 'var(--c-inner)', borderRadius: 8, border: `1px solid ${unrealizedDollar !== null ? `${pnlColor}33` : 'transparent'}` }}>
                              <div style={{ fontSize: 9, color: 'var(--c-faint)', marginBottom: 2 }}>UNREALIZED P&L</div>
                              <div style={{ fontSize: 15, fontWeight: 800, color: pnlColor }}>
                                {unrealizedDollar !== null ? `${unrealizedDollar >= 0 ? '+' : ''}$${unrealizedDollar.toFixed(2)}` : '—'}
                              </div>
                              {unrealizedPct !== null && (
                                <div style={{ fontSize: 9, color: pnlColor, opacity: 0.8 }}>
                                  {unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(2)}%
                                </div>
                              )}
                            </div>
                            {/* R Multiple */}
                            <div style={{ padding: '9px 10px', background: 'var(--c-inner)', borderRadius: 8 }}>
                              <div style={{ fontSize: 9, color: 'var(--c-faint)', marginBottom: 2 }}>R MULTIPLE</div>
                              <div style={{ fontSize: 15, fontWeight: 800, color: unrealizedR !== null ? (unrealizedR >= 0 ? '#22c55e' : '#ef4444') : 'var(--c-faint)' }}>
                                {unrealizedR !== null ? `${unrealizedR >= 0 ? '+' : ''}${unrealizedR.toFixed(2)}R` : '—'}
                              </div>
                              <div style={{ fontSize: 9, color: 'var(--c-faintest)' }}>max {t.netRR.toFixed(1)}R</div>
                            </div>
                            {/* Breakeven */}
                            <div style={{ padding: '9px 10px', background: inProfitZone ? '#22c55e11' : 'var(--c-inner)', borderRadius: 8, border: `1px solid ${inProfitZone ? '#22c55e33' : 'var(--c-border)'}` }}>
                              <div style={{ fontSize: 9, color: 'var(--c-faint)', marginBottom: 2 }}>BREAKEVEN</div>
                              <div style={{ fontSize: 13, fontWeight: 800, color: inProfitZone ? '#22c55e' : 'var(--c-muted)' }}>
                                ${bePrice.toFixed(bePrice < 1 ? 6 : bePrice < 100 ? 4 : 2)}
                              </div>
                              <div style={{ fontSize: 9, marginTop: 2 }}>
                                {beDistFromCurrent !== null
                                  ? inProfitZone
                                    ? <span style={{ color: '#22c55e' }}>✓ {(beDistFromCurrent * 100).toFixed(3)}% past BE</span>
                                    : <span style={{ color: '#eab308' }}>{(Math.abs(beDistFromCurrent) * 100).toFixed(3)}% to BE</span>
                                  : <span style={{ color: 'var(--c-faintest)' }}>fees: 0.075%</span>}
                              </div>
                            </div>
                          </div>

                          {/* Price bar: SL ──── entry ─── current ──── TP1 ── TP2 ── TP3 */}
                          <div style={{ marginTop: 4 }}>
                            {/* Labels above bar */}
                            <div style={{ position: 'relative', height: 18, marginBottom: 3 }}>
                              <span style={{ position: 'absolute', left: 0, fontSize: 10, color: '#ef4444', fontWeight: 700 }}>SL</span>
                              <span style={{ position: 'absolute', left: `${markerEntry}%`, transform: 'translateX(-50%)', fontSize: 10, color: 'var(--c-muted)', fontWeight: 700 }}>ENTRY</span>
                              <span style={{ position: 'absolute', left: `${markerBE}%`, transform: 'translateX(-50%)', fontSize: 9, color: inProfitZone ? '#22c55e' : '#eab308', fontWeight: 700 }}>BE</span>
                              <span style={{ position: 'absolute', left: `${markerTp1}%`, transform: 'translateX(-50%)', fontSize: 10, color: '#4ade80', fontWeight: 700 }}>TP1</span>
                              <span style={{ position: 'absolute', left: `${markerTp2}%`, transform: 'translateX(-50%)', fontSize: 10, color: '#22c55e', fontWeight: 700 }}>TP2</span>
                              <span style={{ position: 'absolute', right: 0, fontSize: 10, color: '#16a34a', fontWeight: 700 }}>TP3</span>
                            </div>

                            {/* Bar */}
                            <div style={{ position: 'relative', height: 44, borderRadius: 8, overflow: 'hidden', background: 'var(--c-bg)' }}>
                              {/* Red zone: SL → entry */}
                              <div style={{ position: 'absolute', left: 0, right: `${100 - markerEntry}%`, top: 0, bottom: 0, background: 'linear-gradient(90deg, #ef444440 0%, #ef444414 100%)' }} />
                              {/* Green zone: entry → TP3 */}
                              <div style={{ position: 'absolute', left: `${markerEntry}%`, right: 0, top: 0, bottom: 0, background: 'linear-gradient(90deg, #22c55e18 0%, #22c55e38 100%)' }} />

                              {/* Progress fill: entry → current price */}
                              {priceBarPct !== null && (
                                <div style={{
                                  position: 'absolute',
                                  left: `${Math.min(markerEntry, priceBarPct)}%`,
                                  right: `${100 - Math.max(markerEntry, priceBarPct)}%`,
                                  top: '25%', bottom: '25%',
                                  background: pnlColor + '44',
                                  borderRadius: 4,
                                  transition: 'left 0.6s ease, right 0.6s ease',
                                }} />
                              )}

                              {/* SL edge bar */}
                              <div style={{ position: 'absolute', left: t.direction === 'LONG' ? 0 : undefined, right: t.direction === 'SHORT' ? 0 : undefined, top: 0, bottom: 0, width: 4, background: '#ef4444', borderRadius: '4px 0 0 4px' }} />
                              {/* Entry line */}
                              <div style={{ position: 'absolute', left: `${markerEntry}%`, top: 0, bottom: 0, width: 2, background: '#94a3b8cc' }} />
                              {/* BE line */}
                              <div style={{ position: 'absolute', left: `${markerBE}%`, top: 0, bottom: 0, width: 1.5, background: inProfitZone ? '#22c55eaa' : '#eab308aa', borderStyle: 'dashed' }} />
                              {/* TP1 line */}
                              <div style={{ position: 'absolute', left: `${markerTp1}%`, top: 0, bottom: 0, width: 2, background: '#4ade80aa' }} />
                              {/* TP2 line */}
                              <div style={{ position: 'absolute', left: `${markerTp2}%`, top: 0, bottom: 0, width: 2, background: '#22c55e77' }} />

                              {/* Current price dot */}
                              {priceBarPct !== null && (
                                <div style={{
                                  position: 'absolute', left: `${priceBarPct}%`,
                                  top: '50%', transform: 'translate(-50%, -50%)',
                                  width: 16, height: 16, borderRadius: '50%',
                                  background: pnlColor,
                                  boxShadow: `0 0 14px ${pnlColor}, 0 0 5px ${pnlColor}`,
                                  border: `2.5px solid var(--c-inner)`,
                                  transition: 'left 0.6s ease',
                                  zIndex: 10,
                                }} />
                              )}
                            </div>

                            {/* Distances below bar */}
                            {currentPrice !== null && (
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                                <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 700 }}>
                                  ↙ SL {(Math.abs(currentPrice - t.stopLoss) / currentPrice * 100).toFixed(2)}% away
                                </span>
                                <span style={{ fontSize: 10, color: 'var(--c-faint)' }}>
                                  ${currentPrice.toFixed(currentPrice < 1 ? 6 : currentPrice < 100 ? 4 : 2)}
                                </span>
                                <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 700 }}>
                                  TP1 {(Math.abs(currentPrice - t.tp1) / currentPrice * 100).toFixed(2)}% away ↗
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Levels + position grid */}
                      {(() => {
                        const MMR = 0.005;
                        const liqDist = Math.max(0, 1 / t.leverage - MMR);
                        const liqPrice = t.direction === 'LONG'
                          ? t.entry * (1 - liqDist)
                          : t.entry * (1 + liqDist);
                        const fmt = (v: number) => v < 1 ? v.toFixed(6) : v < 100 ? v.toFixed(4) : v.toFixed(2);
                        return (
                          <>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 6, fontSize: 12 }}>
                              {[
                                { label: 'Entry',    value: t.entry,    color: 'var(--c-text)' },
                                { label: 'Stop Loss', value: t.stopLoss, color: '#ef4444' },
                                { label: 'TP1',      value: t.tp1,      color: '#22c55e' },
                              ].map(({ label, value, color }) => (
                                <div key={label} style={{ padding: '6px 8px', background: 'var(--c-inner)', borderRadius: 6 }}>
                                  <div style={{ color: 'var(--c-faint)', fontSize: 10 }}>{label}</div>
                                  <div style={{ color, fontWeight: 600 }}>${fmt(value)}</div>
                                </div>
                              ))}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 10, fontSize: 12 }}>
                              <div style={{ padding: '6px 8px', background: 'var(--c-inner)', borderRadius: 6 }}>
                                <div style={{ color: 'var(--c-faint)', fontSize: 10 }}>Position</div>
                                <div style={{ color: 'var(--c-text)', fontWeight: 600 }}>
                                  {t.qty ? `${t.qty.toFixed(3)} ${t.symbol.replace('1000','').replace('USDT','')}` : '—'}
                                </div>
                                <div style={{ color: 'var(--c-faint)', fontSize: 10 }}>${t.positionNotional ? t.positionNotional.toFixed(0) : '—'} notional</div>
                              </div>
                              <div style={{ padding: '6px 8px', background: 'var(--c-inner)', borderRadius: 6 }}>
                                <div style={{ color: 'var(--c-faint)', fontSize: 10 }}>Margin Used</div>
                                <div style={{ color: '#818cf8', fontWeight: 600 }}>${t.marginUsed ? t.marginUsed.toFixed(2) : '—'}</div>
                                <div style={{ color: 'var(--c-faint)', fontSize: 10 }}>{t.leverage}× leverage</div>
                              </div>
                              <div style={{ padding: '6px 8px', background: '#ef444411', border: '1px solid #ef444422', borderRadius: 6 }}>
                                <div style={{ color: 'var(--c-faint)', fontSize: 10 }}>Liquidation</div>
                                <div style={{ color: '#ef4444', fontWeight: 600 }}>${fmt(liqPrice)}</div>
                                <div style={{ color: 'var(--c-faint)', fontSize: 10 }}>{(liqDist * 100).toFixed(1)}% from entry</div>
                              </div>
                            </div>
                          </>
                        );
                      })()}

                      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--c-faint)', marginBottom: isOpen ? 10 : 0, flexWrap: 'wrap' }}>
                        <span>Score {t.score}/100</span>
                        <span>R:R {t.netRR.toFixed(2)}×</span>
                        <span>Risk {t.riskPct}%</span>
                        {!isOpen && t.pnlDollars !== undefined && (
                          <span style={{ color: t.pnlDollars >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                            {t.pnlDollars >= 0 ? '+' : ''}${t.pnlDollars.toFixed(2)}
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto' }}>
                          {t.timestamp}{t.timezone ? ` ${t.timezone}` : ''}
                        </span>
                      </div>

                      {/* Close buttons for open trades — TPs are auto-detected, only manual overrides here */}
                      {isOpen && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <div style={{ width: '100%', fontSize: 10, color: 'var(--c-faintest)', marginBottom: 2 }}>
                            Auto-tracking TPs/SL · manual overrides:
                          </div>
                          <button onClick={() => updateTradeStatus(t.id, 'sl', t.stopLoss)} style={{
                            padding: '5px 12px', background: '#ef444422', border: '1px solid #ef444444',
                            borderRadius: 6, color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          }}>
                            Force SL (${t.stopLoss.toFixed(t.stopLoss < 1 ? 6 : t.stopLoss < 100 ? 4 : 2)})
                          </button>
                          <button onClick={() => updateTradeStatus(t.id, 'tp3', t.tp3)} style={{
                            padding: '5px 12px', background: '#16a34a22', border: '1px solid #16a34a44',
                            borderRadius: 6, color: '#16a34a', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          }}>
                            Force Close TP3 (${t.tp3.toFixed(t.tp3 < 1 ? 6 : t.tp3 < 100 ? 4 : 2)})
                          </button>
                          <button onClick={() => updateTradeStatus(t.id, 'manual')} style={{
                            padding: '5px 12px', background: 'var(--c-border)', border: '1px solid var(--c-border)',
                            borderRadius: 6, color: 'var(--c-dim)', cursor: 'pointer', fontSize: 12,
                          }}>
                            Manual Close
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
                  );
                })()}

                {/* Clear all */}
                <button onClick={() => { if (confirm('Clear all trade history?')) saveTrades([]); }} style={{
                  padding: '10px 0', background: 'none', border: '1px solid var(--c-border)',
                  borderRadius: 8, color: 'var(--c-faintest)', cursor: 'pointer', fontSize: 13,
                }}>
                  Clear all trades
                </button>
              </>
            )}
          </div>
        )}

        {/* ══════════════════ LOG TAB ══════════════════ */}
        {tab === 'log' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Sync status bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-dim)', letterSpacing: '0.06em' }}>SYNC</span>
              <span style={{
                fontSize: 11, fontWeight: 700,
                color: syncStatus === 'ok' ? '#22c55e' : syncStatus === 'syncing' ? '#eab308' : syncStatus === 'error' ? '#ef4444' : 'var(--c-faint)',
              }}>
                {syncStatus === 'ok' ? '✓ Synced' : syncStatus === 'syncing' ? '⟳ Syncing…' : syncStatus === 'error' ? '✗ Sync error' : '○ Not synced'}
              </span>
              <span style={{ fontSize: 10, color: 'var(--c-faintest)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Key: {syncKey || '—'}
              </span>
              <button onClick={() => { try { navigator.clipboard.writeText(syncKey); } catch { /* ignore */ } }} style={{
                padding: '3px 10px', borderRadius: 5, border: '1px solid var(--c-border)', background: 'var(--c-inner)',
                color: 'var(--c-dim)', cursor: 'pointer', fontSize: 11,
              }}>Copy</button>
            </div>

            {trades.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: 'var(--c-faint)', background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
                <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--c-text)' }}>No trades in log yet</div>
                <div style={{ fontSize: 13 }}>Enter trades from the Scanner tab — full analysis and price tracking appear here.</div>
              </div>
            ) : trades.map(t => {
              const fa = t.fullAnalysis;
              const isOpen = t.status === 'open';
              const dirColor = t.direction === 'LONG' ? '#22c55e' : '#ef4444';
              const statusColors: Record<string, string> = { open: '#6366f1', tp3: '#22c55e', sl: '#ef4444', manual: 'var(--c-muted)' };
              const statusColor = statusColors[t.status];
              const fmtP = (v: number) => v < 1 ? v.toFixed(6) : v < 100 ? v.toFixed(4) : v.toFixed(2);
              const pctFromEntry = (p: number) => ((p - t.entry) / t.entry * 100 * (t.direction === 'LONG' ? 1 : -1)).toFixed(2);
              const livePrice = livePrices[t.symbol]?.price ?? null;

              // H/L range calculations
              const high = t.highestPrice ?? t.entry;
              const low  = t.lowestPrice  ?? t.entry;
              const rangePct = high > low ? (high - low) / t.entry * 100 : 0;
              const highPct  = (high - t.entry) / t.entry * 100 * (t.direction === 'LONG' ? 1 : -1);
              const lowPct   = (low  - t.entry) / t.entry * 100 * (t.direction === 'LONG' ? 1 : -1);

              return (
                <div key={t.id} style={{ background: 'var(--c-card)', border: `1px solid var(--c-border)`, borderLeft: `4px solid ${dirColor}`, borderRadius: 10, overflow: 'hidden' }}>

                  {/* ── Card header ─── */}
                  <div style={{ padding: '12px 14px', borderBottom: `1px solid var(--c-border)`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--c-text)' }}>{t.symbol}</span>
                      <span style={{ padding: '2px 9px', borderRadius: 5, fontSize: 12, fontWeight: 700, background: `${dirColor}22`, color: dirColor }}>
                        {t.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'}
                      </span>
                      <span style={{ padding: '2px 9px', borderRadius: 5, fontSize: 11, fontWeight: 700, background: `${statusColor}22`, color: statusColor }}>
                        {t.status.toUpperCase()}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--c-faint)' }}>{t.leverage}× · {t.bestSetup} · {t.mode.toUpperCase()}</span>
                      {/* TP milestone badges */}
                      {t.tp1Hit && <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: '#4ade8022', color: '#4ade80', border: '1px solid #4ade8044' }}>✓ TP1</span>}
                      {t.tp2Hit && <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: '#22c55e22', color: '#22c55e', border: '1px solid #22c55e44' }}>✓ TP2</span>}
                      {t.tp3Hit && <span style={{ padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: '#16a34a22', color: '#16a34a', border: '1px solid #16a34a44' }}>✓ TP3</span>}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--c-faintest)' }}>{t.timestamp} {t.timezone}</span>
                  </div>

                  <div style={{ padding: '14px 14px 0' }}>

                    {/* ── Analysis snapshot ─── */}
                    {fa && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-dim)', letterSpacing: '0.08em', marginBottom: 8 }}>SIGNAL ANALYSIS AT ENTRY</div>

                        {/* Score row */}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                          {[
                            { l: 'Score',      v: `${fa.totalScore}/100`,                    c: fa.totalScore >= 80 ? '#22c55e' : fa.totalScore >= 60 ? '#eab308' : '#ef4444' },
                            { l: 'Confidence', v: `${fa.confidence}%`,                       c: fa.confidence >= 70 ? '#22c55e' : fa.confidence >= 50 ? '#eab308' : '#ef4444' },
                            { l: 'Alignment',  v: `${fa.alignmentScore}% ${fa.alignmentQuality}`, c: '#818cf8' },
                          ].map(({ l, v, c }) => (
                            <div key={l} style={{ padding: '6px 10px', background: 'var(--c-inner)', borderRadius: 6, border: '1px solid var(--c-border)' }}>
                              <div style={{ fontSize: 9, color: 'var(--c-faint)', marginBottom: 2 }}>{l}</div>
                              <div style={{ fontSize: 13, fontWeight: 800, color: c }}>{v}</div>
                            </div>
                          ))}
                        </div>

                        {/* ICT signals grid */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5, marginBottom: 8 }}>
                          {[
                            { l: 'BOS',   ok: fa.deep.hasBOS },
                            { l: 'OB',    ok: fa.deep.hasOB },
                            { l: 'FVG',   ok: fa.deep.hasFVG },
                            { l: 'Sweep', ok: fa.deep.hasSweep },
                            { l: 'ChoCH', ok: fa.deep.hasChoCH },
                            { l: 'MACD↑', ok: fa.deep.macdBull },
                            { l: 'MACD↓', ok: fa.deep.macdBear },
                            { l: 'VWAP↑', ok: fa.deep.vwapAbove },
                          ].map(({ l, ok }) => (
                            <div key={l} style={{
                              padding: '5px 6px', borderRadius: 5, textAlign: 'center', fontSize: 11, fontWeight: 700,
                              background: ok ? '#22c55e18' : 'var(--c-inner)',
                              color: ok ? '#22c55e' : 'var(--c-faintest)',
                              border: `1px solid ${ok ? '#22c55e33' : 'var(--c-border)'}`,
                            }}>{ok ? '✓' : '·'} {l}</div>
                          ))}
                        </div>

                        {/* RSI + Vol + Wyckoff */}
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                          <span style={{ fontSize: 11, padding: '3px 8px', background: 'var(--c-inner)', borderRadius: 5, color: fa.deep.rsi > 70 ? '#ef4444' : fa.deep.rsi < 30 ? '#22c55e' : 'var(--c-muted)' }}>
                            RSI {fa.deep.rsi?.toFixed(1)}
                          </span>
                          <span style={{ fontSize: 11, padding: '3px 8px', background: 'var(--c-inner)', borderRadius: 5, color: fa.deep.volRatio >= 1.2 ? '#22c55e' : fa.deep.volRatio < 0.8 ? '#ef4444' : 'var(--c-muted)' }}>
                            Vol {fa.deep.volRatio?.toFixed(2)}×
                          </span>
                          <span style={{ fontSize: 11, padding: '3px 8px', background: '#6366f118', borderRadius: 5, color: '#818cf8' }}>
                            {fa.deep.wyckoffPhase}
                          </span>
                        </div>

                        {/* Avg ranges */}
                        {fa.avgMoves && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                            {[
                              { l: 'Avg 4H', v: `±${fa.avgMoves.h4.toFixed(2)}%` },
                              { l: 'Avg 8H', v: `±${fa.avgMoves.h8.toFixed(2)}%` },
                              { l: 'Avg Day', v: `±${fa.avgMoves.daily.toFixed(2)}%` },
                            ].map(({ l, v }) => (
                              <div key={l} style={{ padding: '4px 8px', background: '#6366f111', borderRadius: 5, border: '1px solid #6366f122' }}>
                                <span style={{ fontSize: 10, color: 'var(--c-faint)' }}>{l} </span>
                                <span style={{ fontSize: 12, fontWeight: 700, color: '#818cf8' }}>{v}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Verdict snippet */}
                        <div style={{ fontSize: 11, color: 'var(--c-dim)', lineHeight: 1.6, padding: '8px 10px', background: 'var(--c-inner)', borderRadius: 6, borderLeft: `3px solid ${dirColor}` }}>
                          {fa.verdict?.slice(0, 280)}{(fa.verdict?.length ?? 0) > 280 ? '…' : ''}
                        </div>
                        {fa.leverageWarning && (
                          <div style={{ marginTop: 6, fontSize: 11, color: '#eab308', padding: '5px 8px', background: '#eab30811', borderRadius: 5 }}>{fa.leverageWarning}</div>
                        )}
                      </div>
                    )}

                    {/* ── Price levels ─── */}
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-dim)', letterSpacing: '0.08em', marginBottom: 8 }}>PRICE LEVELS</div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                        {[
                          { l: 'Stop Loss', v: t.stopLoss, c: '#ef4444', pct: pctFromEntry(t.stopLoss) },
                          { l: 'Entry',     v: t.entry,    c: 'var(--c-muted)', pct: null },
                          { l: 'TP1',       v: t.tp1,      c: '#22c55e', pct: pctFromEntry(t.tp1) },
                          { l: 'TP2',       v: t.tp2,      c: '#22c55e', pct: pctFromEntry(t.tp2) },
                          { l: 'TP3',       v: t.tp3,      c: '#16a34a', pct: pctFromEntry(t.tp3) },
                          t.exitPrice
                            ? { l: 'Exit', v: t.exitPrice, c: t.pnlDollars != null && t.pnlDollars >= 0 ? '#22c55e' : '#ef4444', pct: pctFromEntry(t.exitPrice) }
                            : livePrice ? { l: 'Live', v: livePrice, c: '#818cf8', pct: pctFromEntry(livePrice) }
                            : null,
                        ].filter((x): x is { l: string; v: number; c: string; pct: string | null } => x !== null).map(({ l, v, c, pct }) => (
                          <div key={l} style={{ padding: '7px 9px', background: 'var(--c-inner)', borderRadius: 6, border: '1px solid var(--c-border)' }}>
                            <div style={{ fontSize: 9, color: 'var(--c-faint)', marginBottom: 2 }}>{l}</div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: c }}>${fmtP(v)}</div>
                            {pct !== null && <div style={{ fontSize: 9, color: parseFloat(pct) >= 0 ? '#22c55e' : '#ef4444' }}>{parseFloat(pct) >= 0 ? '+' : ''}{pct}%</div>}
                          </div>
                        ))}
                      </div>

                      {/* P&L */}
                      {t.pnlDollars != null && (
                        <div style={{ marginTop: 8, padding: '8px 12px', background: t.pnlDollars >= 0 ? '#22c55e11' : '#ef444411', borderRadius: 6, border: `1px solid ${t.pnlDollars >= 0 ? '#22c55e33' : '#ef444433'}`, display: 'flex', gap: 16 }}>
                          <span style={{ fontSize: 13, fontWeight: 800, color: t.pnlDollars >= 0 ? '#22c55e' : '#ef4444' }}>
                            {t.pnlDollars >= 0 ? '+' : ''}${t.pnlDollars.toFixed(2)} P&L
                          </span>
                          <span style={{ fontSize: 12, color: 'var(--c-faint)' }}>
                            {(t.pnlDollars / (t.qty * t.entry) * 100).toFixed(2)}% on position
                          </span>
                        </div>
                      )}
                    </div>

                    {/* ── High / Low range since entry ─── */}
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-dim)', letterSpacing: '0.08em', marginBottom: 8 }}>
                        PRICE RANGE SINCE ENTRY {isOpen && livePrice ? `· Live $${fmtP(livePrice)}` : ''}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
                        <div style={{ padding: '8px 10px', background: '#22c55e11', borderRadius: 6, border: '1px solid #22c55e33' }}>
                          <div style={{ fontSize: 9, color: '#22c55e', fontWeight: 700, marginBottom: 2 }}>HIGHEST {isOpen ? '(running)' : ''}</div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: '#22c55e' }}>${fmtP(high)}</div>
                          <div style={{ fontSize: 10, color: '#22c55e', opacity: 0.8 }}>{highPct >= 0 ? '+' : ''}{highPct.toFixed(2)}% from entry</div>
                        </div>
                        <div style={{ padding: '8px 10px', background: 'var(--c-inner)', borderRadius: 6, border: '1px solid var(--c-border)', textAlign: 'center' }}>
                          <div style={{ fontSize: 9, color: 'var(--c-faint)', fontWeight: 700, marginBottom: 2 }}>ENTRY</div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--c-muted)' }}>${fmtP(t.entry)}</div>
                          <div style={{ fontSize: 10, color: 'var(--c-faintest)' }}>±{rangePct.toFixed(2)}% range</div>
                        </div>
                        <div style={{ padding: '8px 10px', background: '#ef444411', borderRadius: 6, border: '1px solid #ef444433' }}>
                          <div style={{ fontSize: 9, color: '#ef4444', fontWeight: 700, marginBottom: 2 }}>LOWEST {isOpen ? '(running)' : ''}</div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: '#ef4444' }}>${fmtP(low)}</div>
                          <div style={{ fontSize: 10, color: '#ef4444', opacity: 0.8 }}>{lowPct >= 0 ? '+' : ''}{lowPct.toFixed(2)}% from entry</div>
                        </div>
                      </div>

                      {/* Visual range bar */}
                      {(() => {
                        const barLow  = Math.min(low, t.stopLoss) * 0.999;
                        const barHigh = Math.max(high, t.tp1)    * 1.001;
                        const span = barHigh - barLow;
                        const pos = (p: number) => Math.min(100, Math.max(0, (p - barLow) / span * 100));
                        const markers = [
                          { p: t.stopLoss, c: '#ef4444', lbl: 'SL' },
                          { p: t.entry,    c: 'var(--c-muted)', lbl: 'EN' },
                          { p: t.tp1,      c: '#4ade80', lbl: 'T1' },
                          { p: t.tp2,      c: '#22c55e', lbl: 'T2' },
                          { p: t.tp3,      c: '#16a34a', lbl: 'T3' },
                          ...(livePrice != null ? [{ p: livePrice, c: '#818cf8', lbl: '●' }] : []),
                        ];
                        return (
                          <div style={{ position: 'relative', height: 28, background: 'var(--c-inner)', borderRadius: 6, overflow: 'visible' }}>
                            {/* Range band */}
                            <div style={{ position: 'absolute', left: `${pos(low)}%`, right: `${100 - pos(high)}%`, top: 0, bottom: 0, background: '#22c55e18', borderRadius: 4 }} />
                            {markers.map(({ p, c, lbl }) => (
                              <div key={lbl} style={{ position: 'absolute', left: `${pos(p)}%`, top: 0, bottom: 0, width: 2, background: c, transform: 'translateX(-50%)' }}>
                                <span style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', fontSize: 8, color: c, whiteSpace: 'nowrap', fontWeight: 700, marginBottom: 1 }}>{lbl}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>

                    {/* ── Hourly H/L table ─── */}
                    {(t.hourlyCandles?.length ?? 0) > 0 && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-dim)', letterSpacing: '0.08em', marginBottom: 8 }}>
                          HOURLY H/L ({t.hourlyCandles!.length} candles)
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid var(--c-border)' }}>
                                {['Hour (UTC)', 'Open', 'High', 'Low', 'Close', 'Δ Entry'].map(h => (
                                  <th key={h} style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--c-dim)', fontWeight: 700, fontSize: 10, ...(h === 'Hour (UTC)' ? { textAlign: 'left' } : {}) }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {[...t.hourlyCandles!].reverse().slice(0, 24).map((c, i) => {
                                const delta = (c.close - t.entry) / t.entry * 100 * (t.direction === 'LONG' ? 1 : -1);
                                const isGreen = c.close >= c.open;
                                return (
                                  <tr key={i} style={{ borderBottom: '1px solid var(--c-border)', background: i % 2 === 0 ? 'transparent' : 'var(--c-inner)' }}>
                                    <td style={{ padding: '5px 8px', color: 'var(--c-faint)', fontFamily: 'monospace' }}>{c.hour.slice(11, 16)}</td>
                                    <td style={{ padding: '5px 8px', textAlign: 'right', color: 'var(--c-muted)' }}>${fmtP(c.open)}</td>
                                    <td style={{ padding: '5px 8px', textAlign: 'right', color: '#22c55e', fontWeight: 700 }}>${fmtP(c.high)}</td>
                                    <td style={{ padding: '5px 8px', textAlign: 'right', color: '#ef4444', fontWeight: 700 }}>${fmtP(c.low)}</td>
                                    <td style={{ padding: '5px 8px', textAlign: 'right', color: isGreen ? '#22c55e' : '#ef4444', fontWeight: 600 }}>${fmtP(c.close)}</td>
                                    <td style={{ padding: '5px 8px', textAlign: 'right', color: delta >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>{delta >= 0 ? '+' : ''}{delta.toFixed(2)}%</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* ── Notes ─── */}
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-dim)', letterSpacing: '0.08em', marginBottom: 6 }}>TRADE NOTES</div>
                      <textarea
                        defaultValue={t.notes ?? ''}
                        onBlur={e => updateTradeNotes(t.id, e.target.value)}
                        placeholder="Add notes about this trade — entry rationale, what happened, lessons learned…"
                        rows={3}
                        style={{
                          width: '100%', padding: '9px 10px', background: 'var(--c-inner)', border: '1px solid var(--c-border)',
                          borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 12, lineHeight: 1.6,
                          resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
                        }}
                      />
                    </div>

                  </div>{/* end padded body */}
                </div>
              );
            })}
          </div>
        )}

        {/* ══════════════════ SETTINGS TAB ══════════════════ */}
        {tab === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* ── SYNC KEY ───────────────────────────────────── */}
            <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--c-muted)' }}>🔑 SYNC KEY</span>
                <span style={{ fontSize: 11, color: syncStatus === 'ok' ? '#22c55e' : syncStatus === 'error' ? '#ef4444' : syncStatus === 'syncing' ? '#eab308' : 'var(--c-dim)' }}>
                  {syncStatus === 'ok' ? '✓ Synced' : syncStatus === 'error' ? '✗ Sync error' : syncStatus === 'syncing' ? '⟳ Syncing…' : '● Local only'}
                </span>
              </div>
              <p style={{ fontSize: 12, color: 'var(--c-dim)', margin: '0 0 10px', lineHeight: 1.5 }}>
                Your trades sync across all devices that share this key. Copy it to another device to access the same trade log.
              </p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input
                  readOnly
                  value={syncKey}
                  style={{ flex: 1, padding: '8px 10px', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 12, fontFamily: 'monospace' }}
                />
                <button
                  onClick={() => { try { navigator.clipboard.writeText(syncKey); } catch { /* ignore */ } }}
                  style={{ padding: '8px 14px', background: '#6366f122', border: '1px solid #6366f144', borderRadius: 6, color: '#818cf8', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                >
                  Copy
                </button>
              </div>
              <div style={{ fontSize: 11, color: 'var(--c-faintest)', marginBottom: 8 }}>To use on another device, paste your key below and tap Load:</div>
              <SyncKeyInput onLoad={changeSyncKey} />
            </div>

            {/* ── CONFIG STATUS ──────────────────────────────── */}
            {(() => {
              const checks = [
                { label: 'Bybit API',      ok: !!(apiKey && apiSecret) || !!serverStatus?.bybit,  ok_text: (apiKey && apiSecret) ? 'Local keys configured' : 'Vercel env vars active',  bad_text: 'No keys — paper mode only' },
                { label: 'Trading mode',   ok: true,                           ok_text: liveMode ? '⚡ Live' : '📄 Paper', bad_text: '' },
                { label: 'Risk per trade', ok: riskPct <= 2,                   ok_text: `${riskPct}% (safe)`,    bad_text: `${riskPct}% — above 2% rec` },
                { label: 'Order type',     ok: orderType === 'Limit',          ok_text: 'Limit (saves fees)',    bad_text: 'Market — paying taker fees' },
                { label: 'AI provider',    ok: true,                           ok_text: aiProvider === 'claude' ? 'Claude (Haiku)' : aiProvider === 'openai' ? 'GPT-4o mini' : 'DeepSeek', bad_text: '' },
              ];
              const warnings = checks.filter(c => !c.ok).length;
              return (
                <div style={{ padding: 14, background: 'var(--c-card)', border: `1px solid ${warnings > 0 ? '#eab30833' : '#1e2e1e'}`, borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--c-muted)' }}>CONFIG STATUS</span>
                    <span style={{ fontSize: 11, color: warnings > 0 ? '#eab308' : '#22c55e', fontWeight: 700 }}>
                      {warnings > 0 ? `${warnings} item${warnings > 1 ? 's' : ''} need attention` : '✓ All good'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {checks.map(c => (
                      <div key={c.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', background: 'var(--c-inner)', borderRadius: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--c-dim)' }}>{c.label}</span>
                        <span style={{ fontSize: 12, fontWeight: 600, color: c.ok ? '#22c55e' : '#eab308' }}>
                          {c.ok ? c.ok_text : `⚠ ${c.bad_text}`}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* ── 1. TRADING MODE ────────────────────────────── */}
            <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--c-faint)', letterSpacing: '0.08em', marginBottom: 12 }}>1 · TRADING MODE</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {(['Paper', 'Live'] as const).map(mode => (
                  <button key={mode} onClick={() => setLiveMode(mode === 'Live')} style={{
                    flex: 1, padding: '13px 0', cursor: 'pointer', fontWeight: 800, fontSize: 14, borderRadius: 8,
                    background: (liveMode ? 'Live' : 'Paper') === mode
                      ? mode === 'Live' ? '#dc2626' : '#16a34a' : 'var(--c-inner)',
                    color: (liveMode ? 'Live' : 'Paper') === mode ? '#fff' : 'var(--c-faintest)',
                    border: `1px solid ${(liveMode ? 'Live' : 'Paper') === mode ? 'transparent' : 'var(--c-border)'}`,
                  }}>
                    {mode === 'Live' ? '⚡ Live Trading' : '📄 Paper Mode'}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 12, color: liveMode ? '#ef4444' : 'var(--c-faint)', padding: '8px 12px', background: 'var(--c-inner)', borderRadius: 6, lineHeight: 1.5 }}>
                {liveMode
                  ? '⚠ LIVE MODE active — real orders fire on Bybit with real money. Confirm API keys and risk limits below before trading.'
                  : 'Paper mode simulates every trade — no real funds used. Master the system here before switching live.'}
              </div>
            </div>

            {/* ── 1b. TIMEZONE ───────────────────────────────── */}
            <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--c-faint)', letterSpacing: '0.08em', marginBottom: 10 }}>1b · TIMEZONE</div>
              <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--c-dim)' }}>
                Used for trade timestamps and session times. Current time: <span style={{ color: 'var(--c-text)' }}>
                  {new Date().toLocaleTimeString('en', { timeZone: timezone, hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}
                </span>
              </div>
              <select
                value={timezone}
                onChange={e => setTimezone(e.target.value)}
                style={{
                  width: '100%', padding: '10px 12px', background: 'var(--c-inner)',
                  border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-text)',
                  fontSize: 13, outline: 'none', cursor: 'pointer',
                }}
              >
                {TIMEZONES.map(tz => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
            </div>

            {/* ── 2. BYBIT API KEYS ──────────────────────────── */}
            <div style={{ padding: 16, background: 'var(--c-card)', border: `1px solid ${serverStatus?.bybit ? '#22c55e33' : 'var(--c-border)'}`, borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--c-faint)', letterSpacing: '0.08em', marginBottom: 12 }}>2 · BYBIT API KEYS</div>

              {serverStatus?.bybit && !apiKey && (
                <div style={{ marginBottom: 12, padding: '9px 12px', background: '#16a34a18', border: '1px solid #22c55e33', borderRadius: 6, fontSize: 12, color: '#22c55e' }}>
                  ✓ Vercel environment variables active — no manual entry needed. Enter below only to override with different keys.
                </div>
              )}

              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 12, marginBottom: 4 }}>
                  API Key {serverStatus?.bybit ? <span style={{ color: 'var(--c-faint)', fontSize: 11 }}>(optional override)</span> : null}
                  {apiKey && <span style={{ color: '#22c55e', marginLeft: 8, fontSize: 11 }}>✓ set</span>}
                </label>
                <input value={apiKey} onChange={e => setApiKey(e.target.value)}
                  placeholder={serverStatus?.bybit ? 'Leave blank to use Vercel env var…' : 'Paste Bybit API key…'}
                  style={{ width: '100%', padding: '10px 12px', background: 'var(--c-inner)', border: `1px solid ${apiKey ? '#22c55e33' : 'var(--c-border)'}`, borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 12, marginBottom: 4 }}>
                  API Secret {serverStatus?.bybit ? <span style={{ color: 'var(--c-faint)', fontSize: 11 }}>(optional override)</span> : null}
                  {apiSecret && <span style={{ color: '#22c55e', marginLeft: 8, fontSize: 11 }}>✓ set</span>}
                </label>
                <div style={{ position: 'relative' }}>
                  <input type={showSecret ? 'text' : 'password'} value={apiSecret}
                    onChange={e => setApiSecret(e.target.value)}
                    placeholder={serverStatus?.bybit ? 'Leave blank to use Vercel env var…' : 'Paste Bybit API secret…'}
                    style={{ width: '100%', padding: '10px 42px 10px 12px', background: 'var(--c-inner)', border: `1px solid ${apiSecret ? '#22c55e33' : 'var(--c-border)'}`, borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                  <button onClick={() => setShowSecret(v => !v)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--c-faint)', cursor: 'pointer', fontSize: 16 }}>
                    {showSecret ? '🙈' : '👁'}
                  </button>
                </div>
              </div>

              <div style={{ padding: '8px 12px', background: 'var(--c-inner)', borderRadius: 6, fontSize: 11, color: 'var(--c-faintest)', lineHeight: 1.6 }}>
                Keys are stored in your browser only — never sent to any server except Bybit directly over HTTPS.
                On Bybit: Account → API Management → Create key with <strong style={{ color: 'var(--c-faint)' }}>Trade</strong> permission only. No withdrawal permission needed or wanted.
              </div>
            </div>

            {/* ── 3. ACCOUNT & RISK LIMITS ───────────────────── */}
            <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--c-faint)', letterSpacing: '0.08em', marginBottom: 12 }}>3 · ACCOUNT & RISK LIMITS</div>

              {/* Expected ROI per trade — top of section for visibility */}
              <div style={{ marginBottom: 14, padding: 12, background: '#0d0d16', border: '1px solid #6366f133', borderRadius: 8 }}>
                <label style={{ display: 'block', fontWeight: 700, fontSize: 12, color: '#818cf8', marginBottom: 8 }}>
                  Target spot move per trade (ROI %) — used in position math below
                </label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {[0.5, 0.75, 1, 1.5, 2, 3].map(p => (
                    <button key={p} onClick={() => setTargetSpotPct(p)} style={{
                      padding: '7px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                      background: targetSpotPct === p ? '#6366f1' : 'var(--c-card)',
                      color: targetSpotPct === p ? '#fff' : 'var(--c-faint)',
                    }}>{p}%</button>
                  ))}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 4 }}>
                    <span style={{ color: 'var(--c-faintest)', fontSize: 11 }}>custom:</span>
                    <input type="number" min={0.1} max={10} step={0.1} value={targetSpotPct}
                      onChange={e => setTargetSpotPct(parseFloat(e.target.value) || 1)}
                      style={{ width: 64, padding: '7px 8px', background: 'var(--c-card)', border: '1px solid #6366f133', borderRadius: 6, color: '#818cf8', outline: 'none', fontSize: 13, textAlign: 'center', fontWeight: 700 }} />
                    <span style={{ color: 'var(--c-faintest)', fontSize: 11 }}>%</span>
                  </div>
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--c-faint)' }}>
                  At 5× leverage: <span style={{ color: '#818cf8', fontWeight: 700 }}>{(targetSpotPct * 5).toFixed(1)}% ROI on margin</span>
                  {' '}· <span style={{ color: '#22c55e' }}>+${(accountSize * targetSpotPct * 5 / 100).toFixed(0)} gross</span>
                  {' '}per trade on ${accountSize.toLocaleString()} account
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                {/* Account size */}
                <div>
                  <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 3 }}>
                    Account size (USDT) <span style={{ color: 'var(--c-faintest)' }}>· your balance</span>
                  </label>
                  <input type="number" min={100} value={accountSize} onChange={e => setAccountSize(+e.target.value || 2000)}
                    style={{ width: '100%', padding: '9px 10px', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                </div>

                {/* Risk per trade */}
                <div>
                  <label style={{ display: 'block', fontSize: 11, marginBottom: 3 }}>
                    <span style={{ color: 'var(--c-dim)' }}>Risk per trade (%)</span>
                    <span style={{ marginLeft: 6, fontSize: 10, color: riskPct <= 1 ? '#22c55e' : riskPct <= 2 ? '#eab308' : '#ef4444', fontWeight: 700 }}>
                      {riskPct <= 1 ? '✓ conservative' : riskPct <= 2 ? '⚠ moderate' : '✗ high risk'}
                    </span>
                  </label>
                  <input type="number" min={0.1} max={10} step={0.1} value={riskPct} onChange={e => setRiskPct(parseFloat(e.target.value) || 1)}
                    style={{ width: '100%', padding: '9px 10px', background: 'var(--c-inner)', border: `1px solid ${riskPct <= 2 ? 'var(--c-border)' : '#ef444444'}`, borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                </div>

                {/* Daily loss limit */}
                <div>
                  <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 3 }}>
                    Daily loss limit ($) <span style={{ color: 'var(--c-faintest)' }}>· rec: ${(accountSize * 0.04).toFixed(0)}</span>
                  </label>
                  <input type="number" min={10} value={dailyLossLimit} onChange={e => setDailyLossLimit(+e.target.value || 80)}
                    style={{ width: '100%', padding: '9px 10px', background: 'var(--c-inner)', border: '1px solid #ef444433', borderRadius: 6, color: '#ef4444', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                </div>

                {/* Daily profit target */}
                <div>
                  <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 3 }}>
                    Daily profit target ($) <span style={{ color: 'var(--c-faintest)' }}>· rec: ${(accountSize * 0.05).toFixed(0)}</span>
                  </label>
                  <input type="number" min={10} value={dailyTarget} onChange={e => setDailyTarget(+e.target.value || 100)}
                    style={{ width: '100%', padding: '9px 10px', background: 'var(--c-inner)', border: '1px solid #22c55e33', borderRadius: 6, color: '#22c55e', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              </div>

              {/* Max trades per day */}
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', color: 'var(--c-dim)', fontSize: 11, marginBottom: 6 }}>
                  Max trades per day <span style={{ color: 'var(--c-faintest)' }}>· rec: 3–5 quality setups only</span>
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[3, 4, 5, 7, 10].map(n => (
                    <button key={n} onClick={() => setMaxTrades(n)} style={{
                      padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                      background: maxTrades === n ? (n <= 5 ? '#22c55e22' : '#ef444422') : 'var(--c-inner)',
                      color: maxTrades === n ? (n <= 5 ? '#22c55e' : '#ef4444') : 'var(--c-faintest)',
                    }}>{n}</button>
                  ))}
                </div>
              </div>

              {/* Live P&L math */}
              {(() => {
                const effLev = 5;
                const position = accountSize * effLev;
                const takerFee = 0.00055;
                const makerFee = 0.00020;
                const entryFee = position * (orderType === 'Limit' ? makerFee : takerFee);
                const exitFee  = position * takerFee;
                const grossProfit = position * (targetSpotPct / 100);
                const netProfit = grossProfit - entryFee - exitFee;
                const riskAmt = accountSize * riskPct / 100;
                const rr = netProfit / riskAmt;
                const tradesNeeded = netProfit > 0 ? Math.ceil(dailyTarget / netProfit) : '∞';
                return (
                  <div style={{ background: 'var(--c-inner)', borderRadius: 8, padding: '12px 14px' }}>
                    <div style={{ fontWeight: 700, fontSize: 11, color: 'var(--c-faintest)', marginBottom: 8, letterSpacing: '0.06em' }}>LIVE MATH AT {effLev}× · {targetSpotPct}% MOVE</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 10px', fontSize: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--c-faint)' }}>Position</span>
                        <span style={{ color: 'var(--c-text)', fontWeight: 700 }}>${position.toLocaleString()}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--c-faint)' }}>Risk amount</span>
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>−${riskAmt.toFixed(0)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--c-faint)' }}>Gross profit</span>
                        <span style={{ color: 'var(--c-muted)' }}>+${grossProfit.toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--c-faint)' }}>Fees (round trip)</span>
                        <span style={{ color: '#eab308' }}>−${(entryFee + exitFee).toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>Net profit</span>
                        <span style={{ color: netProfit > 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>+${netProfit.toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--c-faint)' }}>ROI on margin</span>
                        <span style={{ color: '#818cf8', fontWeight: 700 }}>{((netProfit / accountSize) * 100).toFixed(2)}%</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--c-faint)' }}>Net R:R</span>
                        <span style={{ color: rr >= 2 ? '#22c55e' : rr >= 1 ? '#eab308' : '#ef4444', fontWeight: 700 }}>{rr.toFixed(2)}×</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--c-faint)' }}>Wins to hit ${dailyTarget}</span>
                        <span style={{ color: typeof tradesNeeded === 'number' && tradesNeeded <= maxTrades ? '#22c55e' : '#eab308', fontWeight: 700 }}>{tradesNeeded} trades</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--c-faint)' }}>Liq. distance</span>
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>−{Math.max(0, (1/effLev - 0.005)*100).toFixed(1)}% spot</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--c-faint)' }}>Max loss today</span>
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>−${dailyLossLimit} hard stop</span>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* ── 4. EXECUTION DEFAULTS ──────────────────────── */}
            <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--c-faint)', letterSpacing: '0.08em', marginBottom: 12 }}>4 · EXECUTION DEFAULTS</div>

              {/* Order type */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ color: 'var(--c-dim)', fontSize: 12 }}>Default order type</label>
                  <span style={{ fontSize: 11, color: orderType === 'Limit' ? '#22c55e' : '#eab308' }}>
                    {orderType === 'Limit' ? '✓ Limit saves 0.035% fees per trade' : '⚠ Market pays taker fees — more expensive'}
                  </span>
                </div>
                <div style={{ display: 'flex', background: 'var(--c-inner)', border: '1px solid var(--c-border)', borderRadius: 8, overflow: 'hidden' }}>
                  {(['Limit', 'Market'] as const).map(t => (
                    <button key={t} onClick={() => setOrderType(t)} style={{
                      flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                      background: orderType === t ? (t === 'Limit' ? '#22c55e22' : '#ef444422') : 'transparent',
                      color: orderType === t ? (t === 'Limit' ? '#22c55e' : '#ef4444') : 'var(--c-faintest)',
                    }}>
                      {t === 'Limit' ? '📋 Limit (maker 0.02%)' : '⚡ Market (taker 0.055%)'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Leverage note */}
              <div style={{ marginBottom: 14, padding: 12, background: '#6366f111', border: '1px solid #6366f133', borderRadius: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#818cf8', marginBottom: 3 }}>Leverage — set freely per trade</div>
                <div style={{ fontSize: 11, color: 'var(--c-faint)', lineHeight: 1.5 }}>
                  Set your preferred leverage in the trade entry panel. The engine recommends a leverage per signal — you can override it up to 200×. Bybit enforces pair-specific limits server-side.
                </div>
              </div>

              {/* Force override */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: 'var(--c-inner)', borderRadius: 6 }}>
                <div>
                  <div style={{ fontSize: 13, color: forceTrade ? '#eab308' : 'var(--c-dim)', fontWeight: 600 }}>
                    {forceTrade ? '⚠ Funding rate check bypassed' : 'Funding rate gate: ON'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--c-faintest)', marginTop: 2 }}>
                    When ON, trades are blocked if funding rate exceeds ±0.10% (squeeze risk)
                  </div>
                </div>
                <button onClick={() => setForceTrade(v => !v)} style={{
                  padding: '7px 16px', marginLeft: 12, flexShrink: 0, borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 12,
                  background: forceTrade ? '#eab30822' : 'var(--c-inner)',
                  border: `1px solid ${forceTrade ? '#eab30844' : 'var(--c-border)'}`,
                  color: forceTrade ? '#eab308' : 'var(--c-faint)',
                }}>
                  {forceTrade ? 'BYPASS' : 'CHECK'}
                </button>
              </div>
            </div>

            {/* ── 5. AI ANALYSIS PROVIDER ────────────────────── */}
            <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--c-faint)', letterSpacing: '0.08em', marginBottom: 12 }}>5 · AI ANALYSIS PROVIDER</div>

              {/* Provider selector */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                {([
                  { id: 'claude',   label: 'Claude',   sub: 'Haiku 4.5',  color: '#d97706', cost: '~$0.003/req' },
                  { id: 'openai',   label: 'GPT-4o',   sub: 'mini',       color: '#10b981', cost: '~$0.002/req' },
                  { id: 'deepseek', label: 'DeepSeek', sub: 'Chat',       color: '#6366f1', cost: '~$0.0003/req' },
                ] as { id: AiProvider; label: string; sub: string; color: string; cost: string }[]).map(p => (
                  <button key={p.id} onClick={() => setAiProvider(p.id)} style={{
                    flex: 1, padding: '10px 8px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                    background: aiProvider === p.id ? `${p.color}18` : 'var(--c-inner)',
                    border: `1px solid ${aiProvider === p.id ? p.color : 'var(--c-border)'}`,
                    color: aiProvider === p.id ? p.color : 'var(--c-faintest)',
                  }}>
                    <div style={{ fontWeight: 800, fontSize: 13 }}>{p.label}</div>
                    <div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>{p.sub} · {p.cost}</div>
                  </button>
                ))}
              </div>

              {/* API key inputs — paste your keys here, no Vercel setup needed */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--c-dim)' }}>AI Provider API Keys</span>
                <button onClick={() => setShowAiKeys(v => !v)} style={{
                  padding: '3px 10px', background: 'none', border: '1px solid var(--c-border)',
                  borderRadius: 5, color: 'var(--c-faint)', cursor: 'pointer', fontSize: 11,
                }}>
                  {showAiKeys ? 'Hide' : 'Show'} keys
                </button>
              </div>

              {([
                { id: 'claude',   label: 'Anthropic (Claude)',  value: anthropicKey, set: setAnthropicKey, placeholder: 'sk-ant-…',  color: '#d97706', ok: !!anthropicKey, serverOk: !!serverStatus?.anthropic },
                { id: 'openai',   label: 'OpenAI (GPT-4o)',     value: openaiKey,    set: setOpenaiKey,    placeholder: 'sk-…',       color: '#10b981', ok: !!openaiKey,    serverOk: !!serverStatus?.openai    },
                { id: 'deepseek', label: 'DeepSeek',            value: deepseekKey,  set: setDeepseekKey,  placeholder: 'sk-…',       color: '#6366f1', ok: !!deepseekKey,  serverOk: !!serverStatus?.deepseek  },
              ] as { id: string; label: string; value: string; set: (v: string) => void; placeholder: string; color: string; ok: boolean; serverOk: boolean }[]).map(p => (
                <div key={p.id} style={{ marginBottom: 8 }}>
                  <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                    <span style={{ color: aiProvider === p.id ? p.color : 'var(--c-faint)', fontWeight: aiProvider === p.id ? 700 : 400 }}>
                      {p.label}{aiProvider === p.id ? ' ← active' : ''}
                    </span>
                    {p.ok
                      ? <span style={{ color: '#22c55e' }}>✓ local key set</span>
                      : p.serverOk
                        ? <span style={{ color: '#22c55e' }}>✓ Vercel env var active</span>
                        : null
                    }
                  </label>
                  <input
                    type={showAiKeys ? 'text' : 'password'}
                    value={p.value}
                    onChange={e => p.set(e.target.value)}
                    placeholder={p.serverOk && !p.ok ? 'Leave blank — using Vercel env var' : p.placeholder}
                    style={{
                      width: '100%', padding: '8px 12px', background: 'var(--c-inner)',
                      border: `1px solid ${p.ok ? `${p.color}44` : p.serverOk ? '#22c55e22' : 'var(--c-border)'}`,
                      borderRadius: 6, color: 'var(--c-text)', outline: 'none', fontSize: 12,
                      boxSizing: 'border-box', fontFamily: 'monospace',
                    }}
                  />
                </div>
              ))}

              <div style={{ padding: '8px 12px', background: 'var(--c-inner)', borderRadius: 6, fontSize: 11, color: 'var(--c-faintest)', lineHeight: 1.6, marginTop: 4 }}>
                Local keys (entered above) override Vercel env vars. Leave blank to use server-side keys.
                Get keys: <span style={{ color: 'var(--c-faint)' }}>console.anthropic.com · platform.openai.com · platform.deepseek.com</span>
              </div>
            </div>

            {/* ── SAVE ───────────────────────────────────────── */}
            <button onClick={saveSettings} style={{
              width: '100%', padding: '14px 0',
              background: settingsSaved ? '#16a34a' : '#6366f1',
              color: '#fff', border: 'none', borderRadius: 10,
              cursor: 'pointer', fontWeight: 800, fontSize: 15,
              transition: 'background 0.2s',
              boxShadow: settingsSaved ? '0 4px 16px #16a34a44' : '0 4px 16px #6366f144',
            }}>
              {settingsSaved ? '✓ All Settings Saved' : 'Save All Settings'}
            </button>

            {/* ── 6. RISK MANAGEMENT STRATEGIES ─────────────── */}
            <div style={{ padding: 16, background: 'var(--c-card)', border: '1px solid var(--c-border)', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--c-faint)', letterSpacing: '0.08em', marginBottom: 14 }}>6 · RISK MANAGEMENT STRATEGIES</div>

              {/* Strategy: Position Sizing */}
              {(() => {
                const effLev = 5;
                const riskAmt = accountSize * riskPct / 100;
                const position = accountSize * effLev;
                const stopDistPct = 1; // typical 1% stop for alts
                const positionByRisk = riskAmt / (stopDistPct / 100);
                return (
                  <div style={{ marginBottom: 12, padding: 12, background: 'var(--c-inner)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: '#818cf8', marginBottom: 8 }}>POSITION SIZING — Never Risk More Than Your Limit</div>
                    <div style={{ fontSize: 12, color: 'var(--c-faint)', lineHeight: 1.7, marginBottom: 8 }}>
                      Formula: <span style={{ color: 'var(--c-text)' }}>Risk $ ÷ Stop Distance % = Max Position Size</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12 }}>
                      <div style={{ padding: '6px 10px', background: 'var(--c-card)', borderRadius: 6 }}>
                        <div style={{ color: 'var(--c-faint)', fontSize: 10, marginBottom: 2 }}>Max risk this trade</div>
                        <div style={{ color: '#ef4444', fontWeight: 700 }}>${riskAmt.toFixed(0)} ({riskPct}% of ${accountSize.toLocaleString()})</div>
                      </div>
                      <div style={{ padding: '6px 10px', background: 'var(--c-card)', borderRadius: 6 }}>
                        <div style={{ color: 'var(--c-faint)', fontSize: 10, marginBottom: 2 }}>Position at {effLev}×</div>
                        <div style={{ color: '#818cf8', fontWeight: 700 }}>${position.toLocaleString()}</div>
                      </div>
                      <div style={{ padding: '6px 10px', background: 'var(--c-card)', borderRadius: 6 }}>
                        <div style={{ color: 'var(--c-faint)', fontSize: 10, marginBottom: 2 }}>Risk-sized at 1% stop</div>
                        <div style={{ color: 'var(--c-text)', fontWeight: 700 }}>${positionByRisk.toLocaleString()}</div>
                      </div>
                      <div style={{ padding: '6px 10px', background: 'var(--c-card)', borderRadius: 6 }}>
                        <div style={{ color: 'var(--c-faint)', fontSize: 10, marginBottom: 2 }}>Liquidation distance</div>
                        <div style={{ color: '#ef4444', fontWeight: 700 }}>−{Math.max(0,(1/effLev-0.005)*100).toFixed(1)}% spot</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--c-faintest)' }}>
                      Your SL must be further than {Math.max(0,(1/effLev-0.005)*100).toFixed(1)}% from entry to avoid liquidation at {effLev}× leverage.
                    </div>
                  </div>
                );
              })()}

              {/* Strategy: Partial Exit Plan */}
              {(() => {
                const effLev = 5;
                const position = accountSize * effLev;
                const takerFee = 0.00055;
                const makerFee = 0.00020;
                const spotMove = targetSpotPct / 100;
                const tp1Profit = position * 0.5 * spotMove - position * 0.5 * (orderType === 'Limit' ? makerFee : takerFee) - position * 0.5 * takerFee;
                const tp2Profit = position * 0.25 * (spotMove * 1.5);
                const tp3Profit = position * 0.25 * (spotMove * 2.5);
                return (
                  <div style={{ marginBottom: 12, padding: 12, background: 'var(--c-inner)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: '#22c55e', marginBottom: 8 }}>PARTIAL EXIT STRATEGY — Lock Profits, Let Rest Run</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {[
                        { label: 'TP1 — Close 50%', pct: `${targetSpotPct}% move`, profit: tp1Profit, color: '#22c55e', note: 'Move SL to breakeven after TP1 hit — house money trade' },
                        { label: 'TP2 — Close 25%', pct: `${(targetSpotPct*1.5).toFixed(1)}% move`, profit: tp2Profit, color: '#4ade80', note: 'Trail stop to TP1 level — guaranteed profit on remaining' },
                        { label: 'TP3 — Close 25%', pct: `${(targetSpotPct*2.5).toFixed(1)}% move`, profit: tp3Profit, color: '#86efac', note: 'Let this run — if market extends you capture the full move' },
                      ].map(t => (
                        <div key={t.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: 'var(--c-card)', borderRadius: 6 }}>
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: t.color }}>{t.label} ({t.pct})</div>
                            <div style={{ fontSize: 10, color: 'var(--c-faintest)', marginTop: 1 }}>{t.note}</div>
                          </div>
                          <div style={{ fontSize: 13, fontWeight: 800, color: t.color }}>+${t.profit.toFixed(2)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Strategy: Daily Session Rules */}
              {(() => {
                const effLev = 5;
                const netPerTrade = accountSize * effLev * (targetSpotPct/100) - accountSize * effLev * 0.00075;
                const tradesNeeded = netPerTrade > 0 ? Math.ceil(dailyTarget / netPerTrade) : '∞';
                return (
                  <div style={{ marginBottom: 12, padding: 12, background: 'var(--c-inner)', borderRadius: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 12, color: '#eab308', marginBottom: 8 }}>SESSION RULES — Discipline Beats Intelligence</div>
                    {[
                      { icon: '🔴', rule: `Stop at −$${dailyLossLimit}`,           detail: `${Math.ceil(dailyLossLimit / (accountSize * riskPct / 100))} consecutive losses. Log off. No revenge trades.` },
                      { icon: '🟢', rule: `Walk away at +$${dailyTarget}`,          detail: `Est. ${tradesNeeded} winning trades at current settings. Lock it in.` },
                      { icon: '⏱',  rule: `Max ${maxTrades} trades/day`,            detail: 'Each trade needs a valid A/B+ setup. No FOMO entries.' },
                      { icon: '💧', rule: 'Close before funding (00/08/16 UTC)',     detail: 'Holding through funding at high leverage destroys edge over time.' },
                      { icon: '📊', rule: 'Score ≥ 75 + alignment ≥ 70% only',      detail: 'Autoscan filters this for you. Manual entries must meet same standard.' },
                      { icon: '₿',  rule: 'BTC divergence = half size or skip',     detail: 'If BTC trends opposite your trade direction, reduce size by 50%.' },
                    ].map(({ icon, rule, detail }) => (
                      <div key={rule} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--c-border)', alignItems: 'flex-start' }}>
                        <span style={{ fontSize: 14, marginTop: 1 }}>{icon}</span>
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--c-text)' }}>{rule}</div>
                          <div style={{ fontSize: 11, color: 'var(--c-faint)', marginTop: 2 }}>{detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {/* Strategy: ICT Entry Checklist */}
              <div style={{ padding: 12, background: 'var(--c-inner)', borderRadius: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--c-muted)', marginBottom: 8 }}>ICT ENTRY CHECKLIST — All Must Be True</div>
                {[
                  ['BOS or CHoCH confirmed on 15m or 1h', 'Structure must have shifted in your direction'],
                  ['Price in OB or FVG zone', 'Do not chase — wait for price to return to value'],
                  ['VWAP aligned with direction', 'Long above VWAP, short below VWAP'],
                  ['Score ≥ 75 / Confidence ≥ 70%', 'Engine confirms multi-timeframe alignment'],
                  ['BTC not diverging', 'Macro filter — check BTC panel in scan results'],
                  ['Volume ≥ 1.0× average at entry', 'Institutional participation required'],
                  ['RSI not extreme (not >75 for longs, not <25 for shorts)', 'Avoid entering exhausted moves'],
                  ['SL placed below OB/FVG bottom (long) or above (short)', 'Technical stop, not arbitrary %'],
                ].map(([check, reason]) => (
                  <div key={check} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--c-border)', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--c-faintest)', fontSize: 14, marginTop: 0 }}>□</span>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--c-dim)' }}>{check}</div>
                      <div style={{ fontSize: 10, color: '#1e3a2e', marginTop: 1 }}>{reason}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
