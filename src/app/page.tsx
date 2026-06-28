'use client';

import { useState, useEffect } from 'react';

/* ─── Types ──────────────────────────────────────────────────────────────── */

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
  const liquidationPct = (100 / leverage).toFixed(1);
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

/* ─── Constants ──────────────────────────────────────────────────────────── */

const POPULAR = [
  'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT',
  'LINKUSDT', 'NEARUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT', 'APTUSDT', 'INJUSDT', 'ATOMUSDT',
  'LTCUSDT', 'TONUSDT', 'PEPEUSDT', 'WIFUSDT', 'SEIUSDT', 'TIAUSDT', 'FILUSDT', 'MATICUSDT',
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

type Tab = 'scan' | 'calc' | 'settings';

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

  // Trade state
  const [riskPct, setRiskPct] = useState(1);
  const [orderType, setOrderType] = useState<'Market' | 'Limit'>('Limit');
  const [userLeverage, setUserLeverage] = useState<number | ''>('');
  const [forceTrade, setForceTrade] = useState(false);
  const [tradeLoading, setTradeLoading] = useState(false);
  const [tradeResult, setTradeResult] = useState<TradeResult | null>(null);

  // Load settings from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('4scans-settings');
      if (saved) {
        const s = JSON.parse(saved);
        if (s.apiKey) setApiKey(s.apiKey);
        if (s.apiSecret) setApiSecret(s.apiSecret);
        if (typeof s.liveMode === 'boolean') setLiveMode(s.liveMode);
        if (s.riskPct) setRiskPct(s.riskPct);
        if (s.orderType) setOrderType(s.orderType);
      }
    } catch { /* ignore */ }
  }, []);

  function saveSettings() {
    try {
      localStorage.setItem('4scans-settings', JSON.stringify({ apiKey, apiSecret, liveMode, riskPct, orderType }));
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch { /* ignore */ }
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
    setTradeResult(null);
    setTab('scan');
    try {
      const res = await fetch(`/api/scan?symbol=${sym.toUpperCase()}`);
      const data = await res.json() as ScanResult;
      setResult(data);
      if (data?.masterSignal?.leverage) setUserLeverage(data.masterSignal.leverage);
    } catch (e) {
      setResult({ ok: false, error: String(e) } as ScanResult);
    } finally {
      setLoading(false);
    }
  }

  async function enterTrade() {
    if (!result?.ok || result.direction === 'NEUTRAL') return;
    setTradeLoading(true);
    setTradeResult(null);
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
          leverage: typeof userLeverage === 'number' ? userLeverage : result.masterSignal.leverage,
          riskPct,
          style: result.bestSetup,
          orderType,
          force: forceTrade,
          userLeverage: typeof userLeverage === 'number' ? userLeverage : undefined,
          ...(apiKey && { apiKey }),
          ...(apiSecret && { apiSecret }),
          liveMode,
        }),
      });
      const data = await res.json() as TradeResult;
      setTradeResult(data);
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
          <button style={TAB_STYLE(tab === 'calc')} onClick={() => setTab('calc')}>📐 Calculator</button>
          <button style={TAB_STYLE(tab === 'settings')} onClick={() => setTab('settings')}>⚙️ Settings</button>
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
                          Leverage (engine rec: {result.masterSignal.leverage}×)
                        </label>
                        <input type="number" min={1} max={100} value={userLeverage}
                          onChange={e => setUserLeverage(parseInt(e.target.value) || '')}
                          placeholder={String(result.masterSignal.leverage)}
                          style={{ width: '100%', padding: '9px 10px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 14, boxSizing: 'border-box' }} />
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

        {/* ══════════════════ SETTINGS TAB ══════════════════ */}
        {tab === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Live / Paper */}
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8', marginBottom: 14 }}>TRADING MODE</div>
              <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                {(['Paper', 'Live'] as const).map(mode => (
                  <button key={mode} onClick={() => setLiveMode(mode === 'Live')} style={{
                    flex: 1, padding: '12px 0', border: 'none', cursor: 'pointer',
                    fontWeight: 700, fontSize: 14, borderRadius: 8,
                    background: (liveMode ? 'Live' : 'Paper') === mode
                      ? mode === 'Live' ? '#dc2626' : '#16a34a'
                      : '#0a0a0f',
                    color: (liveMode ? 'Live' : 'Paper') === mode ? '#fff' : '#475569',
                    border: `1px solid ${(liveMode ? 'Live' : 'Paper') === mode ? 'transparent' : '#1e1e2e'}`,
                  }}>
                    {mode === 'Live' ? '⚡ Live Trading' : '📄 Paper Mode'}
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 12, color: liveMode ? '#ef4444' : '#475569', padding: '8px 12px', background: '#0a0a0f', borderRadius: 6 }}>
                {liveMode
                  ? '⚠ LIVE MODE: Real orders will be placed on Bybit with real money. Ensure your API keys are correct and risk settings are conservative.'
                  : 'Paper mode simulates trades without touching real funds. Use this while learning the system.'}
              </div>
            </div>

            {/* Default trade params */}
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8', marginBottom: 14 }}>DEFAULT TRADE PARAMS</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Default risk % per trade</label>
                  <input type="number" min={0.1} max={10} step={0.1} value={riskPct}
                    onChange={e => setRiskPct(parseFloat(e.target.value) || 1)}
                    style={{ width: '100%', padding: '9px 10px', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Default order type</label>
                  <div style={{ display: 'flex', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, overflow: 'hidden' }}>
                    {(['Limit', 'Market'] as const).map(t => (
                      <button key={t} onClick={() => setOrderType(t)} style={{
                        flex: 1, padding: '9px 0', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                        background: orderType === t ? '#6366f133' : 'transparent',
                        color: orderType === t ? '#818cf8' : '#475569',
                      }}>{t}</button>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#334155', padding: '6px 10px', background: '#0a0a0f', borderRadius: 6 }}>
                Limit orders cost 0.02% (maker) vs 0.055% (taker) — saves $2–3 per $6k position. Always use Limit unless urgency requires Market.
              </div>
            </div>

            {/* API Keys */}
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8', marginBottom: 14 }}>BYBIT API KEYS</div>

              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>API Key</label>
                <input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Paste your Bybit API key" style={{
                  width: '100%', padding: '10px 12px', background: '#0a0a0f',
                  border: `1px solid ${apiKey ? '#6366f144' : '#1e1e2e'}`,
                  borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box',
                }} />
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>API Secret</label>
                <div style={{ position: 'relative' }}>
                  <input type={showSecret ? 'text' : 'password'} value={apiSecret}
                    onChange={e => setApiSecret(e.target.value)} placeholder="Paste your Bybit API secret"
                    style={{
                      width: '100%', padding: '10px 42px 10px 12px', background: '#0a0a0f',
                      border: `1px solid ${apiSecret ? '#6366f144' : '#1e1e2e'}`,
                      borderRadius: 6, color: '#e2e8f0', outline: 'none', fontSize: 13, boxSizing: 'border-box',
                    }} />
                  <button onClick={() => setShowSecret(v => !v)} style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 16,
                  }}>{showSecret ? '🙈' : '👁'}</button>
                </div>
              </div>

              <div style={{ padding: '8px 12px', background: '#0a0a0f', borderRadius: 6, fontSize: 11, color: '#334155', marginBottom: 14 }}>
                Keys are stored in your browser (localStorage) and sent over HTTPS with each trade. They are never stored server-side.
                On Bybit, create a key with <strong style={{ color: '#475569' }}>Trade</strong> permission only — no withdrawal permission needed.
              </div>

              <button onClick={saveSettings} style={{
                width: '100%', padding: '12px 0',
                background: settingsSaved ? '#16a34a' : '#6366f1',
                color: '#fff', border: 'none', borderRadius: 8,
                cursor: 'pointer', fontWeight: 700, fontSize: 14,
                transition: 'background 0.2s',
              }}>
                {settingsSaved ? '✓ Settings Saved' : 'Save Settings'}
              </button>
            </div>

            {/* Risk rules */}
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8', marginBottom: 12 }}>RISK MANAGEMENT RULES</div>
              {[
                ['Max risk per trade', '1–2% of balance ($20–40 on $2,000)'],
                ['Daily loss limit', 'Stop trading at −$80 loss. No exceptions.'],
                ['Daily profit target', '$100 average — some days less, some more'],
                ['Leverage', '3× to 5× maximum. Ignore engine recommendations above 5×.'],
                ['Order type', 'Limit orders always — avoid paying taker fees'],
                ['Position sizing', 'Risk $ ÷ Stop distance % = position size'],
                ['Funding rate', 'Do not hold positions through 8hr funding timestamps'],
                ['Max trades/day', '3–5 quality setups only. No overtrading.'],
                ['Stop loss', 'Always set before entering. No exceptions.'],
                ['BTC', 'Excluded — too volatile for rules-based stop placement'],
              ].map(([rule, detail]) => (
                <div key={rule} style={{ display: 'flex', gap: 10, padding: '7px 0', borderBottom: '1px solid #0f0f17' }}>
                  <span style={{ color: '#6366f1', fontWeight: 700, fontSize: 12, minWidth: 130, flexShrink: 0 }}>{rule}</span>
                  <span style={{ color: '#64748b', fontSize: 12 }}>{detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
