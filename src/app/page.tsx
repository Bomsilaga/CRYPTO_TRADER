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
  score: number;
  confidence: number;
  bestSetup: string;
  netRR: number;
  status: 'open' | 'tp1' | 'tp2' | 'tp3' | 'sl' | 'manual';
  exitPrice?: number;
  pnlDollars?: number;
  orderId?: string;
}

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
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #0f0f17' }}>
      <span style={{ color: '#64748b', fontSize: 12 }}>{label}</span>
      <span style={{ color: color ?? '#e2e8f0', fontSize: 12, fontWeight: 600 }}>{value}</span>
    </div>
  );

  return (
    <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8', marginBottom: 14 }}>📐 POSITION CALCULATOR</div>

      {/* Inputs */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <div>
          <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 3 }}>Account size (USDT)</label>
          <input type="number" value={accountSize} onChange={e => setAccountSize(+e.target.value || 0)}
            style={{ width: '100%', padding: '7px 10px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 3 }}>Daily profit target ($)</label>
          <input type="number" value={dailyTarget} onChange={e => setDailyTarget(+e.target.value || 0)}
            style={{ width: '100%', padding: '7px 10px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 3 }}>Risk per trade (%)</label>
          <input type="number" min={0.1} max={10} step={0.1} value={riskPct} onChange={e => setRiskPct(+e.target.value || 1)}
            style={{ width: '100%', padding: '7px 10px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 3 }}>Spot move target (%)</label>
          <input type="number" min={0.1} max={10} step={0.1} value={spotTargetPct} onChange={e => setSpotTargetPct(+e.target.value || 1)}
            style={{ width: '100%', padding: '7px 10px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
        </div>
      </div>

      {/* Leverage selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ color: '#64748b', fontSize: 11, minWidth: 60 }}>Leverage</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {[3, 5, 10, 20].map(lv => (
            <button key={lv} onClick={() => setLeverage(lv)}
              style={{ padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                background: leverage === lv ? '#6366f133' : '#0a0a0f',
                color: leverage === lv ? '#818cf8' : '#475569',
              }}>
              {lv}×
            </button>
          ))}
          <input type="number" min={1} max={100} value={leverage} onChange={e => setLeverage(+e.target.value || 1)}
            style={{ width: 52, padding: '4px 8px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#94a3b8', outline: 'none', fontSize: 12, textAlign: 'center' }} />
        </div>
      </div>

      {/* Order type */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ color: '#64748b', fontSize: 11, minWidth: 60 }}>Order type</span>
        <div style={{ display: 'flex', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, overflow: 'hidden' }}>
          {(['limit', 'market'] as const).map(t => (
            <button key={t} onClick={() => setOrderTypeCalc(t)}
              style={{ padding: '4px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: orderTypeCalc === t ? '#6366f133' : 'transparent',
                color: orderTypeCalc === t ? '#818cf8' : '#475569',
              }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div style={{ background: '#0a0a0f', borderRadius: 8, padding: '10px 14px' }}>
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

      <div style={{ marginTop: 10, fontSize: 11, color: '#334155', lineHeight: 1.6 }}>
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

/* ─── Constants ──────────────────────────────────────────────────────────── */

const POPULAR = [
  // Core L1
  'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'ATOMUSDT',
  // High-volatility memes / alts
  'DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'WIFUSDT', 'BOMEUSDT', 'FLOKIUSDT',
  // L2 / rollups
  'ARBUSDT', 'OPUSDT', 'STRKUSDT', 'MATICUSDT',
  // Ecosystem tokens
  'SUIUSDT', 'APTUSDT', 'INJUSDT', 'NEARUSDT', 'SEIUSDT', 'TIAUSDT', 'TONUSDT',
  // DeFi blue chips
  'LINKUSDT', 'AAVEUSDT', 'UNIUSDT', 'LDOUSDT', 'GRTUSDT',
  // AI / infra / RWA
  'RENDERUSDT', 'FETUSDT', 'WLDUSDT',
  // Solana ecosystem
  'JUPUSDT', 'PYTHUSDT', 'JTOUSDT',
  // Bitcoin ecosystem
  'ORDIUSDT', 'LTCUSDT',
  // Other vol plays
  'FILUSDT', 'GMXUSDT', 'KASUSDT',
];

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

function ScoreBar({ score }: { score: number }) {
  const color = score >= 80 ? '#22c55e' : score >= 60 ? '#eab308' : '#ef4444';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: '#1e1e2e', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.5s' }} />
      </div>
      <span style={{ color, fontWeight: 700, minWidth: 36 }}>{score}</span>
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────────────────────── */

type Tab = 'scan' | 'calc' | 'trades' | 'settings';
const MAX_LEVERAGE = 5; // hard cap — override engine recommendations

export default function Home() {
  const [tab, setTab] = useState<Tab>('scan');

  // Scan state
  const [symbol, setSymbol] = useState('ETHUSDT');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [autoScan, setAutoScan] = useState<AutoScanResult | null>(null);

  // Settings state
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Account & risk
  const [accountSize, setAccountSize] = useState(2000);
  const [dailyLossLimit, setDailyLossLimit] = useState(80);
  const [dailyTarget, setDailyTarget] = useState(100);
  const [maxTrades, setMaxTrades] = useState(5);
  const [targetSpotPct, setTargetSpotPct] = useState(1); // expected spot move % per trade

  // Trade state
  const [riskPct, setRiskPct] = useState(1);
  const [orderType, setOrderType] = useState<'Market' | 'Limit'>('Limit');
  const [userLeverage, setUserLeverage] = useState<number | ''>('');
  const [forceTrade, setForceTrade] = useState(false);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeResult, setTradeResult] = useState<TradeResult | null>(null);
  const [capAt5x, setCapAt5x] = useState(true);

  // Trade journal
  const [trades, setTrades] = useState<TradeEntry[]>([]);

  // BTC comparison
  const [btcResult, setBtcResult] = useState<ScanResult | null>(null);

  // AI explanation
  const [aiLoading, setAiLoading] = useState(false);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiProvider, setAiProvider] = useState<AiProvider>('claude');

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
        if (typeof s.capAt5x === 'boolean') setCapAt5x(s.capAt5x);
        if (s.aiProvider) setAiProvider(s.aiProvider as AiProvider);
        if (s.accountSize)    setAccountSize(s.accountSize);
        if (s.dailyLossLimit) setDailyLossLimit(s.dailyLossLimit);
        if (s.dailyTarget)    setDailyTarget(s.dailyTarget);
        if (s.maxTrades)      setMaxTrades(s.maxTrades);
        if (s.targetSpotPct)  setTargetSpotPct(s.targetSpotPct);
      }
    } catch { /* ignore */ }
  }, []);

  function saveSettings() {
    try {
      localStorage.setItem('4scans-settings', JSON.stringify({
        apiKey, apiSecret, liveMode, riskPct, orderType, capAt5x, aiProvider,
        accountSize, dailyLossLimit, dailyTarget, maxTrades, targetSpotPct,
      }));
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch { /* ignore */ }
  }

  // Load trade journal
  useEffect(() => {
    try {
      const saved = localStorage.getItem('4scans-trades');
      if (saved) setTrades(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  function saveTrades(updated: TradeEntry[]) {
    setTrades(updated);
    try { localStorage.setItem('4scans-trades', JSON.stringify(updated)); } catch { /* ignore */ }
  }

  function updateTradeStatus(id: string, status: TradeEntry['status'], exitPrice?: number) {
    const updated = trades.map(t => {
      if (t.id !== id) return t;
      const pnlDollars = exitPrice
        ? (t.direction === 'LONG' ? exitPrice - t.entry : t.entry - exitPrice)
          / t.entry * t.entry * t.leverage * (t.riskPct / 100) / ((Math.abs(t.entry - t.stopLoss) / t.entry) * t.leverage)
        : undefined;
      return { ...t, status, exitPrice, pnlDollars };
    });
    saveTrades(updated);
  }

  function deleteTrade(id: string) {
    saveTrades(trades.filter(t => t.id !== id));
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

  async function scan(sym = symbol) {
    setLoading(true);
    setResult(null);
    setBtcResult(null);
    setTradeResult(null);
    setAiExplanation(null);
    setAiWarnings([]);
    setTab('scan');
    try {
      const upperSym = sym.toUpperCase();
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
        setUserLeverage(capAt5x ? Math.min(data.masterSignal.leverage, MAX_LEVERAGE) : data.masterSignal.leverage);
      }
    } catch (e) {
      setResult({ ok: false, error: String(e) } as ScanResult);
    } finally {
      setLoading(false);
    }
  }

  async function getAiExplain() {
    if (!result?.ok) return;
    setAiLoading(true);
    setAiExplanation(null);
    setAiWarnings([]);
    try {
      const res = await fetch('/api/ai-explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...result,
          provider: aiProvider,
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

    // Apply leverage cap
    const rawLev = typeof userLeverage === 'number' ? userLeverage : result.masterSignal.leverage;
    const effectiveLev = capAt5x ? Math.min(rawLev, MAX_LEVERAGE) : rawLev;

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
        const entry: TradeEntry = {
          id: Date.now().toString(),
          symbol: result.symbol,
          direction: result.direction as 'LONG' | 'SHORT',
          entry: result.masterSignal.entry,
          stopLoss: result.masterSignal.stopLoss,
          tp1: result.masterSignal.tp1,
          tp2: result.masterSignal.tp2,
          tp3: result.masterSignal.tp3,
          leverage: effectiveLev,
          riskPct,
          orderType,
          mode: liveMode ? 'live' : 'paper',
          timestamp: new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }),
          score: result.totalScore,
          confidence: result.confidence,
          bestSetup: result.bestSetup,
          netRR: result.masterSignal.netRR,
          status: 'open',
          orderId: data.orderId,
        };
        saveTrades([entry, ...trades]);
      }
    } catch (e) {
      setTradeResult({ error: String(e) });
    } finally {
      setTradeLoading(false);
    }
  }

  const dirColor = result?.direction === 'LONG' ? '#22c55e' : result?.direction === 'SHORT' ? '#ef4444' : '#94a3b8';
  const canTrade = result?.ok && result.direction !== 'NEUTRAL';

  const TAB_STYLE = (active: boolean) => ({
    flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer',
    fontWeight: 700, fontSize: 13,
    background: active ? '#111118' : 'transparent',
    color: active ? '#e2e8f0' : '#475569',
    borderBottom: active ? '2px solid #6366f1' : '2px solid transparent',
    transition: 'all 0.15s',
  });

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '0 0 40px' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={{ padding: '20px 16px 0', marginBottom: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px', margin: 0 }}>
              🚀 4SCANS
            </h1>
            <p style={{ color: '#64748b', fontSize: 12, marginTop: 3, marginBottom: 0 }}>
              Bybit perpetuals · ICT + Wyckoff · {liveMode ? <span style={{ color: '#ef4444', fontWeight: 700 }}>⚡ LIVE</span> : <span style={{ color: '#22c55e' }}>📄 PAPER</span>}
            </p>
          </div>
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

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid #1e1e2e', marginBottom: 0 }}>
          <button style={TAB_STYLE(tab === 'scan')} onClick={() => setTab('scan')}>📡 Scanner</button>
          <button style={TAB_STYLE(tab === 'calc')} onClick={() => setTab('calc')}>📐 Calc</button>
          <button style={TAB_STYLE(tab === 'trades')} onClick={() => setTab('trades')}>
            📒 Trades{trades.length > 0 ? ` (${trades.length})` : ''}
          </button>
          <button style={TAB_STYLE(tab === 'settings')} onClick={() => setTab('settings')}>⚙️</button>
        </div>
      </div>

      <div style={{ padding: '20px 16px 0' }}>

        {/* ══════════════════ SCAN TAB ══════════════════ */}
        {tab === 'scan' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Search row */}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={symbol}
                onChange={e => setSymbol(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && scan()}
                placeholder="e.g. ETHUSDT"
                style={{
                  flex: 1, padding: '11px 14px', background: '#111118',
                  border: '1px solid #1e1e2e', borderRadius: 8, color: '#e2e8f0', outline: 'none', fontSize: 14,
                }}
              />
              <button onClick={() => scan()} disabled={loading} style={{
                padding: '11px 22px', background: loading ? '#3730a3' : '#6366f1', color: '#fff',
                border: 'none', borderRadius: 8, cursor: loading ? 'not-allowed' : 'pointer',
                fontWeight: 700, fontSize: 14, minWidth: 90,
              }}>
                {loading ? '…' : 'Scan'}
              </button>
            </div>

            {/* Quick picks */}
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {POPULAR.map(s => (
                <button key={s} onClick={() => { setSymbol(s); scan(s); }} style={{
                  padding: '5px 10px', background: symbol === s ? '#1e1b4b' : '#111118',
                  border: `1px solid ${symbol === s ? '#6366f1' : '#1e1e2e'}`,
                  borderRadius: 6, color: symbol === s ? '#818cf8' : '#64748b',
                  cursor: 'pointer', fontSize: 12, fontWeight: symbol === s ? 700 : 400,
                }}>
                  {s.replace('USDT', '')}
                </button>
              ))}
            </div>

            {/* Autoscan panel */}
            <div style={{ padding: 14, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8' }}>⚡ AUTOSCAN</span>
                <span style={{ fontSize: 11, color: '#475569' }}>every 15 min · score ≥ 80</span>
              </div>
              {!autoScan || !autoScan.ok ? (
                <div style={{ color: '#475569', fontSize: 13 }}>{autoScan?.message ?? 'Waiting for first cron scan…'}</div>
              ) : (
                <>
                  <div style={{ color: '#475569', fontSize: 11, marginBottom: 8 }}>
                    {autoScan.timestamp} · {autoScan.scanned} pairs · {((autoScan.elapsed ?? 0) / 1000).toFixed(1)}s
                    {autoScan.timedOut && <span style={{ color: '#eab308', marginLeft: 6 }}>⚠ timed out</span>}
                  </div>
                  {autoScan.alerts && autoScan.alerts.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {autoScan.alerts.map(a => (
                        <button key={a.symbol} onClick={() => { setSymbol(a.symbol); scan(a.symbol); }} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '9px 12px', background: '#0a0a0f', border: '1px solid #1e1e2e',
                          borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                        }}>
                          <span style={{ fontWeight: 700, color: '#e2e8f0' }}>{a.symbol}</span>
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
                    <div style={{ color: '#475569', fontSize: 13 }}>No signals above 80 in last scan</div>
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
                <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontWeight: 800, fontSize: 20 }}>{result.symbol}</span>
                      <span style={{ color: '#475569', marginLeft: 8, fontSize: 13 }}>PERP</span>
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
                <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                    <span style={{
                      padding: '5px 16px', borderRadius: 20, fontWeight: 800, fontSize: 16,
                      background: `${dirColor}22`, color: dirColor, border: `1px solid ${dirColor}44`,
                    }}>
                      {result.direction === 'LONG' ? '▲' : result.direction === 'SHORT' ? '▼' : '—'} {result.direction}
                    </span>
                    <span style={{ color: '#64748b', fontSize: 12 }}>{result.bestSetup} · {result.alignmentQuality}</span>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span style={{ color: '#64748b', fontSize: 12 }}>Signal Score</span>
                      <span style={{ color: '#64748b', fontSize: 12 }}>Confidence {result.confidence}%</span>
                    </div>
                    <ScoreBar score={result.totalScore} />
                  </div>
                  <div>
                    <div style={{ color: '#64748b', fontSize: 12, marginBottom: 5 }}>Alignment {result.alignmentScore.toFixed(0)}%</div>
                    <ScoreBar score={result.alignmentScore} />
                  </div>
                </div>

                {/* BTC Trend Comparison */}
                {btcResult?.ok && (
                  (() => {
                    const btcDir = btcResult.direction;
                    const btcAligned = btcDir === result.direction || btcDir === 'NEUTRAL';
                    const divs = detectBtcDivergences(result, btcResult);
                    const btcDirColor = btcDir === 'LONG' ? '#22c55e' : btcDir === 'SHORT' ? '#ef4444' : '#94a3b8';
                    return (
                      <div style={{
                        padding: 14, background: '#111118',
                        border: `1px solid ${btcAligned ? '#1e3a2e' : '#3a1e1e'}`,
                        borderRadius: 10,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: divs.length > 0 ? 10 : 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontWeight: 700, fontSize: 12, color: '#94a3b8' }}>₿ BTC TREND</span>
                            <span style={{
                              padding: '2px 10px', borderRadius: 4, fontSize: 12, fontWeight: 700,
                              background: `${btcDirColor}22`, color: btcDirColor, border: `1px solid ${btcDirColor}44`,
                            }}>
                              {btcDir === 'LONG' ? '▲' : btcDir === 'SHORT' ? '▼' : '—'} {btcDir}
                            </span>
                            <span style={{ fontSize: 11, color: '#475569' }}>
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
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {divs.map((d, i) => (
                              <div key={i} style={{ padding: '5px 9px', background: '#dc262611', border: '1px solid #dc262633', borderRadius: 5, color: '#fca5a5', fontSize: 11 }}>
                                ⚠ {d}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()
                )}

                {/* Trade levels */}
                <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 13, color: '#94a3b8' }}>TRADE LEVELS</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {[
                      { label: 'Entry', value: result.masterSignal.entry, color: '#e2e8f0' },
                      { label: 'Stop Loss', value: result.masterSignal.stopLoss, color: '#ef4444' },
                      { label: 'TP1 (50%)', value: result.masterSignal.tp1, color: '#22c55e' },
                      { label: 'TP2 (25%)', value: result.masterSignal.tp2, color: '#22c55e' },
                      { label: 'TP3 (25%)', value: result.masterSignal.tp3, color: '#22c55e' },
                      { label: `Rec. Leverage ${result.masterSignal.leverage}×`, value: null, color: '#6366f1' },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{ padding: '8px 12px', background: '#0a0a0f', borderRadius: 6 }}>
                        <div style={{ color: '#475569', fontSize: 11 }}>{label}</div>
                        <div style={{ color, fontWeight: 700, fontSize: 14 }}>
                          {value !== null ? `$${value.toFixed(4)}` : `Net R:R ${result.masterSignal.netRR.toFixed(2)}×`}
                        </div>
                      </div>
                    ))}
                  </div>
                  {result.masterSignal.leverageWarning && (
                    <div style={{ marginTop: 10, padding: 10, background: '#eab30822', borderRadius: 6, color: '#eab308', fontSize: 12 }}>
                      {result.masterSignal.leverageWarning}
                    </div>
                  )}
                </div>

                {/* Structure */}
                <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: '#94a3b8' }}>STRUCTURE</div>
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
                      <span style={{ color: '#64748b' }}>RSI </span>
                      <span style={{ color: result.deep.rsi > 70 ? '#ef4444' : result.deep.rsi < 30 ? '#22c55e' : '#e2e8f0', fontWeight: 700 }}>
                        {result.deep.rsi.toFixed(1)}
                        {result.deep.rsi > 70 ? ' ⚠ Overbought' : result.deep.rsi < 30 ? ' ⚠ Oversold' : ''}
                      </span>
                    </div>
                    <div>
                      <span style={{ color: '#64748b' }}>Wyckoff </span>
                      <span style={{ fontWeight: 600 }}>{result.deep.wyckoffPhase}</span>
                    </div>
                  </div>
                </div>

                {/* ── AI DEEP ANALYSIS ────────────────────────────────── */}
                <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8' }}>🤖 AI DEEP ANALYSIS</span>
                    <button onClick={getAiExplain} disabled={aiLoading} style={{
                      padding: '6px 16px', background: aiLoading ? '#1e1e2e' : '#6366f122',
                      border: '1px solid #6366f144', borderRadius: 6,
                      color: aiLoading ? '#475569' : '#818cf8',
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
                        background: aiProvider === p.id ? `${p.color}22` : '#0a0a0f',
                        color: aiProvider === p.id ? p.color : '#334155',
                        border: `1px solid ${aiProvider === p.id ? `${p.color}55` : '#1e1e2e'}`,
                      }}>
                        {p.label}
                      </button>
                    ))}
                    <span style={{ fontSize: 10, color: '#334155', marginLeft: 4, alignSelf: 'center' }}>
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
                    <div style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {aiExplanation}
                    </div>
                  )}
                </div>

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

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                      <div>
                        <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 4 }}>Risk % of balance</label>
                        <input type="number" min={0.1} max={10} step={0.1} value={riskPct}
                          onChange={e => setRiskPct(parseFloat(e.target.value) || 1)}
                          style={{ width: '100%', padding: '9px 10px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 14, boxSizing: 'border-box' }} />
                      </div>
                      <div>
                        <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 4 }}>
                          Leverage
                          {capAt5x
                            ? <span style={{ color: '#22c55e', marginLeft: 6 }}>capped at {MAX_LEVERAGE}× ✓</span>
                            : <span style={{ color: '#ef4444', marginLeft: 6 }}>cap OFF — engine rec: {result.masterSignal.leverage}×</span>}
                        </label>
                        <input type="number" min={1} max={capAt5x ? MAX_LEVERAGE : 100}
                          value={capAt5x ? Math.min(typeof userLeverage === 'number' ? userLeverage : MAX_LEVERAGE, MAX_LEVERAGE) : userLeverage}
                          onChange={e => {
                            const v = parseInt(e.target.value) || 1;
                            setUserLeverage(capAt5x ? Math.min(v, MAX_LEVERAGE) : v);
                          }}
                          placeholder={String(capAt5x ? Math.min(result.masterSignal.leverage, MAX_LEVERAGE) : result.masterSignal.leverage)}
                          style={{ width: '100%', padding: '9px 10px', background: '#0a0a0f',
                            border: `1px solid ${capAt5x ? '#16a34a44' : '#ef444444'}`,
                            borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 14, boxSizing: 'border-box' }} />
                      </div>
                    </div>

                    {/* Order type + force */}
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, overflow: 'hidden' }}>
                        {(['Limit', 'Market'] as const).map(t => (
                          <button key={t} onClick={() => setOrderType(t)} style={{
                            padding: '6px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                            background: orderType === t ? '#6366f133' : 'transparent',
                            color: orderType === t ? '#818cf8' : '#475569',
                          }}>{t}</button>
                        ))}
                      </div>
                      {orderType === 'Limit' && <span style={{ fontSize: 11, color: '#22c55e' }}>saves ~0.035% fees</span>}
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>
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
                      {!liveMode && <span style={{ color: '#334155', marginLeft: 6 }}>Switch in Settings tab</span>}
                    </div>

                    {/* BIG BUTTON */}
                    <button onClick={enterTrade} disabled={tradeLoading} style={{
                      width: '100%', padding: '14px 0', border: 'none', borderRadius: 8,
                      fontWeight: 800, fontSize: 16, letterSpacing: '0.5px',
                      cursor: tradeLoading ? 'not-allowed' : 'pointer',
                      background: tradeLoading ? '#1e1e2e'
                        : result.direction === 'LONG' ? 'linear-gradient(135deg, #16a34a, #15803d)'
                        : 'linear-gradient(135deg, #dc2626, #b91c1c)',
                      color: tradeLoading ? '#475569' : '#fff',
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
                    {tradeResult.message && <div style={{ color: '#cbd5e1', fontSize: 13, marginBottom: 6 }}>{tradeResult.message}</div>}
                    {tradeResult.error && <div style={{ color: '#ef4444', fontSize: 13 }}>{tradeResult.error}</div>}
                    {tradeResult.leverageWarning && <div style={{ color: '#eab308', fontSize: 12, marginBottom: 6 }}>{tradeResult.leverageWarning}</div>}
                    {(tradeResult.paper || tradeResult.success) && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#94a3b8' }}>
                        {tradeResult.orderId && <div>Order ID: <span style={{ color: '#e2e8f0' }}>{tradeResult.orderId}</span></div>}
                        {tradeResult.qty !== undefined && <div>Qty: <span style={{ color: '#e2e8f0' }}>{tradeResult.qty}</span></div>}
                        {tradeResult.balance && <div>Balance: <span style={{ color: '#e2e8f0' }}>${tradeResult.balance}</span></div>}
                        {tradeResult.riskAmt && <div>Risk amt: <span style={{ color: '#ef4444' }}>${tradeResult.riskAmt}</span></div>}
                        {tradeResult.feeEstimate && <div>Fees: <span style={{ color: '#eab308' }}>${tradeResult.feeEstimate.totalFee}</span>
                          {tradeResult.feeEstimate.note && <span style={{ color: '#334155' }}> · {tradeResult.feeEstimate.note}</span>}</div>}
                        {tradeResult.simulated && (
                          <div style={{ marginTop: 4, color: '#475569' }}>
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
                <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: '#94a3b8' }}>VERDICT</div>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.8, color: '#cbd5e1', margin: 0 }}>
                    {result.verdict}
                  </pre>
                </div>

                {/* Raw signal toggle */}
                <button onClick={() => setShowRaw(v => !v)} style={{
                  padding: '9px 0', background: 'none', border: '1px solid #1e1e2e',
                  borderRadius: 8, color: '#475569', cursor: 'pointer', fontSize: 13,
                }}>
                  {showRaw ? '▲ Hide' : '▼ Show'} raw signal text
                </button>

                {showRaw && (
                  <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
                    <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, color: '#64748b', margin: 0 }}>
                      {result.masterSignal.signalText}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ══════════════════ CALCULATOR TAB ══════════════════ */}
        {tab === 'calc' && <RiskCalculator />}

        {/* ══════════════════ TRADES TAB ══════════════════ */}
        {tab === 'trades' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {trades.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: '#475569', background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📒</div>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>No trades logged yet</div>
                <div style={{ fontSize: 13 }}>Enter a trade from the Scanner tab and it will appear here.</div>
              </div>
            ) : (
              <>
                {/* Summary row */}
                {(() => {
                  const closed = trades.filter(t => t.status !== 'open');
                  const wins = closed.filter(t => ['tp1','tp2','tp3'].includes(t.status)).length;
                  const totalPnl = trades.reduce((s, t) => s + (t.pnlDollars ?? 0), 0);
                  const openCount = trades.filter(t => t.status === 'open').length;
                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                      {[
                        { label: 'Total', value: trades.length },
                        { label: 'Open', value: openCount, color: '#6366f1' },
                        { label: 'Win rate', value: closed.length ? `${Math.round(wins/closed.length*100)}%` : '—', color: '#22c55e' },
                        { label: 'Net P&L', value: `$${totalPnl.toFixed(0)}`, color: totalPnl >= 0 ? '#22c55e' : '#ef4444' },
                      ].map(({ label, value, color }) => (
                        <div key={label} style={{ padding: '10px 12px', background: '#111118', border: '1px solid #1e1e2e', borderRadius: 8, textAlign: 'center' }}>
                          <div style={{ color: '#475569', fontSize: 11 }}>{label}</div>
                          <div style={{ color: color ?? '#e2e8f0', fontWeight: 700, fontSize: 16 }}>{value}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {/* Trade list */}
                {trades.map(t => {
                  const dirColor = t.direction === 'LONG' ? '#22c55e' : '#ef4444';
                  const statusColor: Record<string, string> = { open: '#6366f1', tp1: '#22c55e', tp2: '#22c55e', tp3: '#22c55e', sl: '#ef4444', manual: '#94a3b8' };
                  const isOpen = t.status === 'open';
                  return (
                    <div key={t.id} style={{ padding: 14, background: '#111118', border: `1px solid ${isOpen ? '#1e2e4e' : '#1e1e2e'}`, borderRadius: 10 }}>
                      {/* Header row */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                        <div>
                          <span style={{ fontWeight: 800, fontSize: 15 }}>{t.symbol}</span>
                          <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: `${dirColor}22`, color: dirColor }}>
                            {t.direction === 'LONG' ? '▲' : '▼'} {t.direction}
                          </span>
                          <span style={{ marginLeft: 6, padding: '2px 8px', borderRadius: 4, fontSize: 11, background: '#1e1e2e', color: '#64748b' }}>
                            {t.mode.toUpperCase()} · {t.leverage}× · {t.bestSetup}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, background: `${statusColor[t.status]}22`, color: statusColor[t.status] }}>
                            {t.status.toUpperCase()}
                          </span>
                          <button onClick={() => deleteTrade(t.id)} style={{ background: 'none', border: 'none', color: '#334155', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
                        </div>
                      </div>

                      {/* Levels */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 10, fontSize: 12 }}>
                        {[
                          { label: 'Entry', value: t.entry, color: '#e2e8f0' },
                          { label: 'SL', value: t.stopLoss, color: '#ef4444' },
                          { label: 'TP1', value: t.tp1, color: '#22c55e' },
                        ].map(({ label, value, color }) => (
                          <div key={label} style={{ padding: '6px 8px', background: '#0a0a0f', borderRadius: 6 }}>
                            <div style={{ color: '#475569', fontSize: 10 }}>{label}</div>
                            <div style={{ color, fontWeight: 600 }}>${value.toFixed(4)}</div>
                          </div>
                        ))}
                      </div>

                      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: '#475569', marginBottom: isOpen ? 10 : 0 }}>
                        <span>Score {t.score}/100</span>
                        <span>R:R {t.netRR.toFixed(2)}×</span>
                        <span>Risk {t.riskPct}%</span>
                        {t.pnlDollars !== undefined && (
                          <span style={{ color: t.pnlDollars >= 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>
                            {t.pnlDollars >= 0 ? '+' : ''}${t.pnlDollars.toFixed(2)}
                          </span>
                        )}
                        <span style={{ marginLeft: 'auto' }}>{t.timestamp}</span>
                      </div>

                      {/* Close buttons for open trades */}
                      {isOpen && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {(['tp1', 'tp2', 'tp3'] as const).map(tp => (
                            <button key={tp} onClick={() => updateTradeStatus(t.id, tp, t[tp])} style={{
                              padding: '5px 12px', background: '#16a34a22', border: '1px solid #16a34a44',
                              borderRadius: 6, color: '#22c55e', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                            }}>
                              Hit {tp.toUpperCase()} (${t[tp].toFixed(3)})
                            </button>
                          ))}
                          <button onClick={() => updateTradeStatus(t.id, 'sl', t.stopLoss)} style={{
                            padding: '5px 12px', background: '#ef444422', border: '1px solid #ef444444',
                            borderRadius: 6, color: '#ef4444', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                          }}>
                            Stopped Out (${t.stopLoss.toFixed(3)})
                          </button>
                          <button onClick={() => updateTradeStatus(t.id, 'manual')} style={{
                            padding: '5px 12px', background: '#1e1e2e', border: '1px solid #1e1e2e',
                            borderRadius: 6, color: '#64748b', cursor: 'pointer', fontSize: 12,
                          }}>
                            Manual Close
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Clear all */}
                <button onClick={() => { if (confirm('Clear all trade history?')) saveTrades([]); }} style={{
                  padding: '10px 0', background: 'none', border: '1px solid #1e1e2e',
                  borderRadius: 8, color: '#334155', cursor: 'pointer', fontSize: 13,
                }}>
                  Clear all trades
                </button>
              </>
            )}
          </div>
        )}

        {/* ══════════════════ SETTINGS TAB ══════════════════ */}
        {tab === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* ── CONFIG STATUS ──────────────────────────────── */}
            {(() => {
              const checks = [
                { label: 'Bybit API',      ok: !!(apiKey && apiSecret),       ok_text: 'Keys configured',       bad_text: 'No keys — paper mode only' },
                { label: 'Trading mode',   ok: true,                           ok_text: liveMode ? '⚡ Live' : '📄 Paper', bad_text: '' },
                { label: 'Leverage cap',   ok: capAt5x,                        ok_text: `Hard cap at ${MAX_LEVERAGE}×`, bad_text: 'Cap OFF — high risk' },
                { label: 'Risk per trade', ok: riskPct <= 2,                   ok_text: `${riskPct}% (safe)`,    bad_text: `${riskPct}% — above 2% rec` },
                { label: 'Order type',     ok: orderType === 'Limit',          ok_text: 'Limit (saves fees)',    bad_text: 'Market — paying taker fees' },
                { label: 'AI provider',    ok: true,                           ok_text: aiProvider === 'claude' ? 'Claude (Haiku)' : aiProvider === 'openai' ? 'GPT-4o mini' : 'DeepSeek', bad_text: '' },
              ];
              const warnings = checks.filter(c => !c.ok).length;
              return (
                <div style={{ padding: 14, background: '#111118', border: `1px solid ${warnings > 0 ? '#eab30833' : '#1e2e1e'}`, borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8' }}>CONFIG STATUS</span>
                    <span style={{ fontSize: 11, color: warnings > 0 ? '#eab308' : '#22c55e', fontWeight: 700 }}>
                      {warnings > 0 ? `${warnings} item${warnings > 1 ? 's' : ''} need attention` : '✓ All good'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    {checks.map(c => (
                      <div key={c.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 8px', background: '#0a0a0f', borderRadius: 6 }}>
                        <span style={{ fontSize: 12, color: '#64748b' }}>{c.label}</span>
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
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#475569', letterSpacing: '0.08em', marginBottom: 12 }}>1 · TRADING MODE</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {(['Paper', 'Live'] as const).map(mode => (
                  <button key={mode} onClick={() => setLiveMode(mode === 'Live')} style={{
                    flex: 1, padding: '13px 0', cursor: 'pointer', fontWeight: 800, fontSize: 14, borderRadius: 8,
                    background: (liveMode ? 'Live' : 'Paper') === mode
                      ? mode === 'Live' ? '#dc2626' : '#16a34a' : '#0a0a0f',
                    color: (liveMode ? 'Live' : 'Paper') === mode ? '#fff' : '#334155',
                    border: `1px solid ${(liveMode ? 'Live' : 'Paper') === mode ? 'transparent' : '#1e1e2e'}`,
                  }}>
                    {mode === 'Live' ? '⚡ Live Trading' : '📄 Paper Mode'}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 12, color: liveMode ? '#ef4444' : '#475569', padding: '8px 12px', background: '#0a0a0f', borderRadius: 6, lineHeight: 1.5 }}>
                {liveMode
                  ? '⚠ LIVE MODE active — real orders fire on Bybit with real money. Confirm API keys and risk limits below before trading.'
                  : 'Paper mode simulates every trade — no real funds used. Master the system here before switching live.'}
              </div>
            </div>

            {/* ── 2. BYBIT API KEYS ──────────────────────────── */}
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#475569', letterSpacing: '0.08em', marginBottom: 12 }}>2 · BYBIT API KEYS</div>

              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>
                  API Key
                  {apiKey && <span style={{ color: '#22c55e', marginLeft: 8, fontSize: 11 }}>✓ set</span>}
                </label>
                <input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Paste Bybit API key…"
                  style={{ width: '100%', padding: '10px 12px', background: '#0a0a0f', border: `1px solid ${apiKey ? '#22c55e33' : '#1e1e2e'}`, borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>
                  API Secret
                  {apiSecret && <span style={{ color: '#22c55e', marginLeft: 8, fontSize: 11 }}>✓ set</span>}
                </label>
                <div style={{ position: 'relative' }}>
                  <input type={showSecret ? 'text' : 'password'} value={apiSecret}
                    onChange={e => setApiSecret(e.target.value)} placeholder="Paste Bybit API secret…"
                    style={{ width: '100%', padding: '10px 42px 10px 12px', background: '#0a0a0f', border: `1px solid ${apiSecret ? '#22c55e33' : '#1e1e2e'}`, borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                  <button onClick={() => setShowSecret(v => !v)} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 16 }}>
                    {showSecret ? '🙈' : '👁'}
                  </button>
                </div>
              </div>

              <div style={{ padding: '8px 12px', background: '#0a0a0f', borderRadius: 6, fontSize: 11, color: '#334155', lineHeight: 1.6 }}>
                Keys are stored in your browser only — never sent to any server except Bybit directly over HTTPS.
                On Bybit: Account → API Management → Create key with <strong style={{ color: '#475569' }}>Trade</strong> permission only. No withdrawal permission needed or wanted.
              </div>
            </div>

            {/* ── 3. ACCOUNT & RISK LIMITS ───────────────────── */}
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#475569', letterSpacing: '0.08em', marginBottom: 12 }}>3 · ACCOUNT & RISK LIMITS</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
                {/* Account size */}
                <div>
                  <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 3 }}>
                    Account size (USDT) <span style={{ color: '#334155' }}>· your balance</span>
                  </label>
                  <input type="number" min={100} value={accountSize} onChange={e => setAccountSize(+e.target.value || 2000)}
                    style={{ width: '100%', padding: '9px 10px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                </div>

                {/* Risk per trade */}
                <div>
                  <label style={{ display: 'block', fontSize: 11, marginBottom: 3 }}>
                    <span style={{ color: '#64748b' }}>Risk per trade (%)</span>
                    <span style={{ marginLeft: 6, fontSize: 10, color: riskPct <= 1 ? '#22c55e' : riskPct <= 2 ? '#eab308' : '#ef4444', fontWeight: 700 }}>
                      {riskPct <= 1 ? '✓ conservative' : riskPct <= 2 ? '⚠ moderate' : '✗ high risk'}
                    </span>
                  </label>
                  <input type="number" min={0.1} max={10} step={0.1} value={riskPct} onChange={e => setRiskPct(parseFloat(e.target.value) || 1)}
                    style={{ width: '100%', padding: '9px 10px', background: '#0a0a0f', border: `1px solid ${riskPct <= 2 ? '#1e1e2e' : '#ef444444'}`, borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                </div>

                {/* Daily loss limit */}
                <div>
                  <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 3 }}>
                    Daily loss limit ($) <span style={{ color: '#334155' }}>· rec: ${(accountSize * 0.04).toFixed(0)}</span>
                  </label>
                  <input type="number" min={10} value={dailyLossLimit} onChange={e => setDailyLossLimit(+e.target.value || 80)}
                    style={{ width: '100%', padding: '9px 10px', background: '#0a0a0f', border: '1px solid #ef444433', borderRadius: 6, color: '#ef4444', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                </div>

                {/* Daily profit target */}
                <div>
                  <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 3 }}>
                    Daily profit target ($) <span style={{ color: '#334155' }}>· rec: ${(accountSize * 0.05).toFixed(0)}</span>
                  </label>
                  <input type="number" min={10} value={dailyTarget} onChange={e => setDailyTarget(+e.target.value || 100)}
                    style={{ width: '100%', padding: '9px 10px', background: '#0a0a0f', border: '1px solid #22c55e33', borderRadius: 6, color: '#22c55e', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              </div>

              {/* Max trades per day */}
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', color: '#64748b', fontSize: 11, marginBottom: 6 }}>
                  Max trades per day <span style={{ color: '#334155' }}>· rec: 3–5 quality setups only</span>
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[3, 4, 5, 7, 10].map(n => (
                    <button key={n} onClick={() => setMaxTrades(n)} style={{
                      padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                      background: maxTrades === n ? (n <= 5 ? '#22c55e22' : '#ef444422') : '#0a0a0f',
                      color: maxTrades === n ? (n <= 5 ? '#22c55e' : '#ef4444') : '#334155',
                    }}>{n}</button>
                  ))}
                </div>
              </div>

              {/* Expected spot move / ROI per trade */}
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 11, marginBottom: 6 }}>
                  <span style={{ color: '#64748b' }}>Expected spot move per trade (%)</span>
                  <span style={{ color: '#334155', marginLeft: 6 }}>· rec: 0.5–1.5% realistic target</span>
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {[0.5, 0.75, 1, 1.5, 2].map(p => (
                    <button key={p} onClick={() => setTargetSpotPct(p)} style={{
                      padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                      background: targetSpotPct === p ? '#6366f133' : '#0a0a0f',
                      color: targetSpotPct === p ? '#818cf8' : '#334155',
                    }}>{p}%</button>
                  ))}
                  <input type="number" min={0.1} max={10} step={0.1} value={targetSpotPct}
                    onChange={e => setTargetSpotPct(parseFloat(e.target.value) || 1)}
                    style={{ width: 58, padding: '6px 8px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#94a3b8', outline: 'none', fontSize: 12, textAlign: 'center' }} />
                </div>
              </div>

              {/* Live P&L math */}
              {(() => {
                const effLev = capAt5x ? Math.min(MAX_LEVERAGE, 5) : 5;
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
                  <div style={{ background: '#0a0a0f', borderRadius: 8, padding: '12px 14px' }}>
                    <div style={{ fontWeight: 700, fontSize: 11, color: '#334155', marginBottom: 8, letterSpacing: '0.06em' }}>LIVE MATH AT {effLev}× · {targetSpotPct}% MOVE</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px 10px', fontSize: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#475569' }}>Position</span>
                        <span style={{ color: '#e2e8f0', fontWeight: 700 }}>${position.toLocaleString()}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#475569' }}>Risk amount</span>
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>−${riskAmt.toFixed(0)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#475569' }}>Gross profit</span>
                        <span style={{ color: '#94a3b8' }}>+${grossProfit.toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#475569' }}>Fees (round trip)</span>
                        <span style={{ color: '#eab308' }}>−${(entryFee + exitFee).toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#22c55e', fontWeight: 700 }}>Net profit</span>
                        <span style={{ color: netProfit > 0 ? '#22c55e' : '#ef4444', fontWeight: 700 }}>+${netProfit.toFixed(2)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#475569' }}>ROI on margin</span>
                        <span style={{ color: '#818cf8', fontWeight: 700 }}>{((netProfit / accountSize) * 100).toFixed(2)}%</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#475569' }}>Net R:R</span>
                        <span style={{ color: rr >= 2 ? '#22c55e' : rr >= 1 ? '#eab308' : '#ef4444', fontWeight: 700 }}>{rr.toFixed(2)}×</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#475569' }}>Wins to hit ${dailyTarget}</span>
                        <span style={{ color: typeof tradesNeeded === 'number' && tradesNeeded <= maxTrades ? '#22c55e' : '#eab308', fontWeight: 700 }}>{tradesNeeded} trades</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#475569' }}>Liq. distance</span>
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>−{Math.max(0, (1/effLev - 0.005)*100).toFixed(1)}% spot</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: '#475569' }}>Max loss today</span>
                        <span style={{ color: '#ef4444', fontWeight: 700 }}>−${dailyLossLimit} hard stop</span>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* ── 4. EXECUTION DEFAULTS ──────────────────────── */}
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#475569', letterSpacing: '0.08em', marginBottom: 12 }}>4 · EXECUTION DEFAULTS</div>

              {/* Order type */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ color: '#64748b', fontSize: 12 }}>Default order type</label>
                  <span style={{ fontSize: 11, color: orderType === 'Limit' ? '#22c55e' : '#eab308' }}>
                    {orderType === 'Limit' ? '✓ Limit saves 0.035% fees per trade' : '⚠ Market pays taker fees — more expensive'}
                  </span>
                </div>
                <div style={{ display: 'flex', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 8, overflow: 'hidden' }}>
                  {(['Limit', 'Market'] as const).map(t => (
                    <button key={t} onClick={() => setOrderType(t)} style={{
                      flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
                      background: orderType === t ? (t === 'Limit' ? '#22c55e22' : '#ef444422') : 'transparent',
                      color: orderType === t ? (t === 'Limit' ? '#22c55e' : '#ef4444') : '#334155',
                    }}>
                      {t === 'Limit' ? '📋 Limit (maker 0.02%)' : '⚡ Market (taker 0.055%)'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Leverage cap */}
              <div style={{ marginBottom: 14, padding: 12, background: capAt5x ? '#16a34a11' : '#ef444411', border: `1px solid ${capAt5x ? '#16a34a33' : '#ef444433'}`, borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: capAt5x ? '#22c55e' : '#ef4444', marginBottom: 3 }}>
                      {capAt5x ? `✓ Leverage hard cap: ${MAX_LEVERAGE}× max` : '⚠ Leverage cap OFF'}
                    </div>
                    <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.5 }}>
                      {capAt5x
                        ? `Any engine recommendation above ${MAX_LEVERAGE}× is automatically reduced. Strongly recommended for accounts under $10,000.`
                        : 'Engine leverages apply directly — up to 100×. Only disable if you are an experienced trader.'}
                    </div>
                  </div>
                  <button onClick={() => setCapAt5x(v => !v)} style={{
                    padding: '8px 20px', marginLeft: 14, flexShrink: 0, borderRadius: 7, cursor: 'pointer', fontWeight: 800, fontSize: 13,
                    background: capAt5x ? '#16a34a' : '#0a0a0f',
                    border: `1px solid ${capAt5x ? '#16a34a' : '#ef444444'}`,
                    color: capAt5x ? '#fff' : '#ef4444',
                  }}>
                    {capAt5x ? 'ON' : 'OFF'}
                  </button>
                </div>
              </div>

              {/* Force override */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#0a0a0f', borderRadius: 6 }}>
                <div>
                  <div style={{ fontSize: 13, color: forceTrade ? '#eab308' : '#64748b', fontWeight: 600 }}>
                    {forceTrade ? '⚠ Funding rate check bypassed' : 'Funding rate gate: ON'}
                  </div>
                  <div style={{ fontSize: 11, color: '#334155', marginTop: 2 }}>
                    When ON, trades are blocked if funding rate exceeds ±0.10% (squeeze risk)
                  </div>
                </div>
                <button onClick={() => setForceTrade(v => !v)} style={{
                  padding: '7px 16px', marginLeft: 12, flexShrink: 0, borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 12,
                  background: forceTrade ? '#eab30822' : '#0a0a0f',
                  border: `1px solid ${forceTrade ? '#eab30844' : '#1e1e2e'}`,
                  color: forceTrade ? '#eab308' : '#475569',
                }}>
                  {forceTrade ? 'BYPASS' : 'CHECK'}
                </button>
              </div>
            </div>

            {/* ── 5. AI ANALYSIS PROVIDER ────────────────────── */}
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#475569', letterSpacing: '0.08em', marginBottom: 12 }}>5 · AI ANALYSIS PROVIDER</div>

              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                {([
                  { id: 'claude',   label: 'Claude',   sub: 'Haiku 4.5',  color: '#d97706', envVar: 'ANTHROPIC_API_KEY',  cost: '~$0.003' },
                  { id: 'openai',   label: 'GPT-4o',   sub: 'mini',       color: '#10b981', envVar: 'OPENAI_API_KEY',      cost: '~$0.002' },
                  { id: 'deepseek', label: 'DeepSeek', sub: 'Chat',       color: '#6366f1', envVar: 'DEEPSEEK_API_KEY',    cost: '~$0.0003' },
                ] as { id: AiProvider; label: string; sub: string; color: string; envVar: string; cost: string }[]).map(p => (
                  <button key={p.id} onClick={() => setAiProvider(p.id)} style={{
                    flex: 1, padding: '10px 8px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                    background: aiProvider === p.id ? `${p.color}18` : '#0a0a0f',
                    border: `1px solid ${aiProvider === p.id ? p.color : '#1e1e2e'}`,
                    color: aiProvider === p.id ? p.color : '#334155',
                  }}>
                    <div style={{ fontWeight: 800, fontSize: 13 }}>{p.label}</div>
                    <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{p.sub} · {p.cost}/req</div>
                  </button>
                ))}
              </div>

              {/* Env var hint for selected provider */}
              {(() => {
                const info: Record<AiProvider, { envVar: string; cost: string; note: string }> = {
                  claude:   { envVar: 'ANTHROPIC_API_KEY',  cost: '~$0.003/req', note: 'Fastest, most concise. Best for quick signal checks.' },
                  openai:   { envVar: 'OPENAI_API_KEY',     cost: '~$0.002/req', note: 'GPT-4o mini — balanced quality and speed.' },
                  deepseek: { envVar: 'DEEPSEEK_API_KEY',   cost: '~$0.0003/req', note: 'Cheapest option. Good quality, slightly slower.' },
                };
                const p = info[aiProvider];
                return (
                  <div style={{ padding: '10px 12px', background: '#0a0a0f', borderRadius: 6, fontSize: 11, lineHeight: 1.7 }}>
                    <div style={{ color: '#94a3b8', marginBottom: 4 }}>
                      Required Vercel env var: <code style={{ color: '#818cf8', background: '#1e1e2e', padding: '1px 6px', borderRadius: 3 }}>{p.envVar}</code>
                    </div>
                    <div style={{ color: '#475569' }}>Cost: {p.cost} · {p.note}</div>
                    <div style={{ color: '#334155', marginTop: 4 }}>
                      Add in Vercel → Project → Settings → Environment Variables → Redeploy
                    </div>
                  </div>
                );
              })()}
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

            {/* ── 6. RISK MANAGEMENT RULES ───────────────────── */}
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: '#475569', letterSpacing: '0.08em', marginBottom: 12 }}>6 · RISK RULES REFERENCE</div>
              {[
                { rule: 'Max risk/trade',      rec: '1–2%',           current: `${riskPct}%`, ok: riskPct <= 2,        detail: `= $${(accountSize * riskPct / 100).toFixed(0)} on your $${accountSize} account` },
                { rule: 'Daily loss limit',    rec: '4% of account',  current: `$${dailyLossLimit}`, ok: dailyLossLimit <= accountSize * 0.05, detail: `Stop trading immediately at −$${dailyLossLimit}` },
                { rule: 'Daily target',        rec: '5% of account',  current: `$${dailyTarget}`, ok: true,             detail: `Walk away after hitting +$${dailyTarget} — protect gains` },
                { rule: 'Max trades/day',      rec: '3–5',            current: String(maxTrades),   ok: maxTrades <= 5,  detail: 'Quality > quantity. Overtrading kills accounts.' },
                { rule: 'Leverage',            rec: '3–5× max',       current: capAt5x ? `Cap ${MAX_LEVERAGE}× ✓` : 'Cap OFF', ok: capAt5x, detail: 'Above 5× liquidation risk becomes severe on alts' },
                { rule: 'Order type',          rec: 'Limit',          current: orderType,           ok: orderType === 'Limit', detail: 'Saves ~$3 per $6k position round-trip vs Market' },
                { rule: 'Funding rate',        rec: 'Check before entry', current: forceTrade ? 'Bypassed' : 'Gated', ok: !forceTrade, detail: 'Longs pay when > +0.10%, shorts pay when < −0.10%' },
                { rule: 'Stop loss',           rec: 'Always set',     current: '✓ Auto-attached',   ok: true,            detail: 'SL is required for every entry. No exceptions.' },
                { rule: 'BTC correlation',     rec: 'Check alignment', current: '✓ Auto-scanned',   ok: true,            detail: 'Alts with BTC divergence carry extra reversal risk' },
                { rule: 'Funding windows',     rec: 'Close before',   current: '8hr timestamps',    ok: true,            detail: 'Never hold through 00:00 08:00 16:00 UTC funding' },
              ].map(({ rule, rec, current, ok, detail }) => (
                <div key={rule} style={{ padding: '9px 0', borderBottom: '1px solid #0f0f17', display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'start' }}>
                  <div>
                    <div style={{ color: '#64748b', fontSize: 11, fontWeight: 700 }}>{rule}</div>
                    <div style={{ color: '#334155', fontSize: 10, marginTop: 1 }}>Rec: {rec}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: ok ? '#22c55e' : '#eab308', marginBottom: 2 }}>
                      {ok ? '✓' : '⚠'} {current}
                    </div>
                    <div style={{ fontSize: 11, color: '#334155', lineHeight: 1.4 }}>{detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
