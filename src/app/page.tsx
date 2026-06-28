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

export default function Home() {
  // Scan state
  const [symbol, setSymbol] = useState('ETHUSDT');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [autoScan, setAutoScan] = useState<AutoScanResult | null>(null);

  // Settings state
  const [showSettings, setShowSettings] = useState(false);
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
    try {
      const res = await fetch(`/api/scan?symbol=${sym.toUpperCase()}`);
      const data = await res.json() as ScanResult;
      setResult(data);
      // Pre-fill leverage from engine recommendation
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
          // Pass API credentials from client storage
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

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px' }}>
            🚀 4SCANS
          </h1>
          <p style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
            Bybit perpetuals · ICT + Wyckoff signal engine
          </p>
        </div>
        <button
          onClick={() => setShowSettings(v => !v)}
          style={{
            padding: '8px 14px', background: '#111118',
            border: `1px solid ${showSettings ? '#6366f1' : '#1e1e2e'}`,
            borderRadius: 8, color: showSettings ? '#818cf8' : '#64748b',
            cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}
        >
          ⚙️ Settings
        </button>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <div style={{ padding: 16, background: '#111118', border: '1px solid #6366f144', borderRadius: 10, marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#818cf8', marginBottom: 14 }}>API & TRADING SETTINGS</div>

          {/* Live / Paper toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <span style={{ color: '#94a3b8', fontSize: 13, minWidth: 110 }}>Trading Mode</span>
            <div style={{ display: 'flex', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 8, overflow: 'hidden' }}>
              {(['Paper', 'Live'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setLiveMode(mode === 'Live')}
                  style={{
                    padding: '6px 16px', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                    background: (liveMode ? 'Live' : 'Paper') === mode
                      ? mode === 'Live' ? '#ef444422' : '#16a34a22'
                      : 'transparent',
                    color: (liveMode ? 'Live' : 'Paper') === mode
                      ? mode === 'Live' ? '#ef4444' : '#22c55e'
                      : '#475569',
                  }}
                >
                  {mode === 'Live' ? '⚡ Live' : '📄 Paper'}
                </button>
              ))}
            </div>
            {liveMode && (
              <span style={{ fontSize: 11, color: '#ef4444', background: '#ef444422', padding: '3px 8px', borderRadius: 4 }}>
                REAL MONEY
              </span>
            )}
          </div>

          {/* API Key */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Bybit API Key</label>
            <input
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="Enter your Bybit API key"
              style={{
                width: '100%', padding: '9px 12px', background: '#0a0a0f',
                border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0',
                outline: 'none', fontSize: 13, boxSizing: 'border-box',
              }}
            />
          </div>

          {/* API Secret */}
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Bybit API Secret</label>
            <div style={{ position: 'relative' }}>
              <input
                type={showSecret ? 'text' : 'password'}
                value={apiSecret}
                onChange={e => setApiSecret(e.target.value)}
                placeholder="Enter your Bybit API secret"
                style={{
                  width: '100%', padding: '9px 40px 9px 12px', background: '#0a0a0f',
                  border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0',
                  outline: 'none', fontSize: 13, boxSizing: 'border-box',
                }}
              />
              <button
                onClick={() => setShowSecret(v => !v)}
                style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', color: '#475569', cursor: 'pointer', fontSize: 14,
                }}
              >
                {showSecret ? '🙈' : '👁'}
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>
              Keys are stored in your browser only and sent over HTTPS with each trade request.
            </div>
          </div>

          <button
            onClick={saveSettings}
            style={{
              padding: '8px 18px', background: settingsSaved ? '#16a34a' : '#6366f1',
              color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
              fontWeight: 600, fontSize: 13, transition: 'background 0.2s',
            }}
          >
            {settingsSaved ? '✓ Saved' : 'Save Settings'}
          </button>
        </div>
      )}

      {/* Search */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          value={symbol}
          onChange={e => setSymbol(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && scan()}
          placeholder="e.g. ETHUSDT"
          style={{
            flex: 1, padding: '10px 14px', background: '#111118',
            border: '1px solid #1e1e2e', borderRadius: 8, color: '#e2e8f0',
            outline: 'none',
          }}
        />
        <button
          onClick={() => scan()}
          disabled={loading}
          style={{
            padding: '10px 20px', background: '#6366f1', color: '#fff',
            border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600,
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      {/* Quick picks */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 24 }}>
        {POPULAR.map(s => (
          <button
            key={s}
            onClick={() => { setSymbol(s); scan(s); }}
            style={{
              padding: '4px 10px', background: '#111118',
              border: '1px solid #1e1e2e', borderRadius: 6,
              color: '#94a3b8', cursor: 'pointer', fontSize: 12,
            }}
          >
            {s.replace('USDT', '')}
          </button>
        ))}
      </div>

      {/* Autoscan panel */}
      <div style={{ padding: 14, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: '#94a3b8' }}>⚡ AUTOSCAN</span>
          <span style={{ fontSize: 11, color: '#475569' }}>every 15 min · score ≥ 80</span>
        </div>
        {!autoScan || !autoScan.ok ? (
          <div style={{ color: '#475569', fontSize: 13 }}>
            {autoScan?.message ?? 'Waiting for first cron scan…'}
          </div>
        ) : (
          <>
            <div style={{ color: '#475569', fontSize: 11, marginBottom: 8 }}>
              {autoScan.timestamp} · {autoScan.scanned} pairs · {((autoScan.elapsed ?? 0) / 1000).toFixed(1)}s
            </div>
            {autoScan.alerts && autoScan.alerts.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {autoScan.alerts.map(a => (
                  <button
                    key={a.symbol}
                    onClick={() => { setSymbol(a.symbol); scan(a.symbol); }}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 12px', background: '#0a0a0f', border: '1px solid #1e1e2e',
                      borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                    }}
                  >
                    <span style={{ fontWeight: 700, color: '#e2e8f0' }}>{a.symbol}</span>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ color: a.direction === 'LONG' ? '#22c55e' : '#ef4444', fontSize: 12, fontWeight: 600 }}>
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
        <div style={{ padding: 16, background: '#ef444422', border: '1px solid #ef444444', borderRadius: 8, color: '#ef4444' }}>
          {result.error}
        </div>
      )}

      {/* Result card */}
      {result?.ok && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Symbol + price */}
          <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontWeight: 800, fontSize: 18 }}>{result.symbol}</span>
                <span style={{ color: '#64748b', marginLeft: 8, fontSize: 13 }}>PERP</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 700, fontSize: 18 }}>${result.price.toFixed(4)}</div>
                <div style={{ fontSize: 12, color: result.change24h >= 0 ? '#22c55e' : '#ef4444' }}>
                  {result.change24h >= 0 ? '+' : ''}{result.change24h.toFixed(2)}% 24h
                </div>
              </div>
            </div>
          </div>

          {/* Direction + score */}
          <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{
                padding: '4px 14px', borderRadius: 20, fontWeight: 800, fontSize: 16,
                background: `${dirColor}22`, color: dirColor, border: `1px solid ${dirColor}44`,
              }}>
                {result.direction === 'LONG' ? '▲' : result.direction === 'SHORT' ? '▼' : '—'} {result.direction}
              </span>
              <span style={{ color: '#64748b', fontSize: 13 }}>{result.bestSetup} · {result.alignmentQuality}</span>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: '#64748b', fontSize: 12 }}>Signal Score</span>
                <span style={{ color: '#64748b', fontSize: 12 }}>Confidence {result.confidence}%</span>
              </div>
              <ScoreBar score={result.totalScore} />
            </div>
            <div style={{ marginBottom: 4 }}>
              <div style={{ color: '#64748b', fontSize: 12, marginBottom: 4 }}>Alignment {result.alignmentScore.toFixed(0)}%</div>
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
                { label: 'TP1', value: result.masterSignal.tp1, color: '#22c55e' },
                { label: 'TP2', value: result.masterSignal.tp2, color: '#22c55e' },
                { label: 'TP3', value: result.masterSignal.tp3, color: '#22c55e' },
                { label: `Leverage ${result.masterSignal.leverage}×`, value: null, color: '#6366f1' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ padding: '8px 12px', background: '#0a0a0f', borderRadius: 6 }}>
                  <div style={{ color: '#64748b', fontSize: 11 }}>{label}</div>
                  <div style={{ color, fontWeight: 700 }}>
                    {value !== null ? `$${value.toFixed(4)}` : `Net R:R ${result.masterSignal.netRR.toFixed(2)}×`}
                  </div>
                </div>
              ))}
            </div>
            {result.masterSignal.leverageWarning && (
              <div style={{ marginTop: 10, padding: 8, background: '#eab30822', borderRadius: 6, color: '#eab308', fontSize: 12 }}>
                {result.masterSignal.leverageWarning}
              </div>
            )}
          </div>

          {/* Structure badges */}
          <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: '#94a3b8' }}>STRUCTURE</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <Badge ok={result.deep.hasBOS}   label="BOS" />
              <Badge ok={result.deep.hasOB}    label="Order Block" />
              <Badge ok={result.deep.hasFVG}   label="FVG" />
              <Badge ok={result.deep.hasChoCH} label="CHoCH" />
              <Badge ok={result.deep.hasSweep} label="Liq. Sweep" />
              <Badge ok={result.deep.macdBull || result.deep.macdBear} label="MACD signal" />
              <Badge ok={result.deep.vwapAbove === (result.direction === 'LONG')} label="VWAP aligned" />
              <Badge ok={result.deep.volRatio >= 1.5} label={`Vol ${result.deep.volRatio.toFixed(1)}×`} />
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 16, fontSize: 13 }}>
              <div>
                <span style={{ color: '#64748b' }}>RSI </span>
                <span style={{ color: result.deep.rsi > 70 ? '#ef4444' : result.deep.rsi < 30 ? '#22c55e' : '#e2e8f0', fontWeight: 600 }}>
                  {result.deep.rsi.toFixed(1)}
                </span>
              </div>
              <div>
                <span style={{ color: '#64748b' }}>Wyckoff </span>
                <span style={{ fontWeight: 600 }}>{result.deep.wyckoffPhase}</span>
              </div>
            </div>
          </div>

          {/* ── TRADE EXECUTION PANEL ───────────────────────────────────── */}
          {canTrade && (
            <div style={{
              padding: 16, borderRadius: 10,
              background: result.direction === 'LONG' ? '#16a34a11' : '#ef444411',
              border: `1px solid ${result.direction === 'LONG' ? '#16a34a44' : '#ef444444'}`,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 14, fontSize: 13, color: dirColor }}>
                {result.direction === 'LONG' ? '▲' : '▼'} ENTER {result.direction}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                {/* Risk % */}
                <div>
                  <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>
                    Risk % of balance
                  </label>
                  <input
                    type="number"
                    min={0.1} max={10} step={0.1}
                    value={riskPct}
                    onChange={e => setRiskPct(parseFloat(e.target.value) || 1)}
                    style={{
                      width: '100%', padding: '8px 10px', background: '#0a0a0f',
                      border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0',
                      outline: 'none', fontSize: 13, boxSizing: 'border-box',
                    }}
                  />
                </div>

                {/* Leverage */}
                <div>
                  <label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>
                    Leverage (rec: {result.masterSignal.leverage}×)
                  </label>
                  <input
                    type="number"
                    min={1} max={100}
                    value={userLeverage}
                    onChange={e => setUserLeverage(parseInt(e.target.value) || '')}
                    placeholder={String(result.masterSignal.leverage)}
                    style={{
                      width: '100%', padding: '8px 10px', background: '#0a0a0f',
                      border: '1px solid #1e1e2e', borderRadius: 6, color: '#e2e8f0',
                      outline: 'none', fontSize: 13, boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>

              {/* Order type toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ color: '#64748b', fontSize: 12, minWidth: 80 }}>Order type</span>
                <div style={{ display: 'flex', background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: 6, overflow: 'hidden' }}>
                  {(['Limit', 'Market'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setOrderType(t)}
                      style={{
                        padding: '5px 14px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                        background: orderType === t ? '#6366f133' : 'transparent',
                        color: orderType === t ? '#818cf8' : '#475569',
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                {orderType === 'Limit' && (
                  <span style={{ fontSize: 11, color: '#22c55e' }}>saves ~0.035% fees</span>
                )}
              </div>

              {/* Force funding checkbox */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={forceTrade}
                  onChange={e => setForceTrade(e.target.checked)}
                  style={{ accentColor: '#6366f1' }}
                />
                <span style={{ color: '#64748b', fontSize: 12 }}>
                  Force trade (override funding rate check)
                </span>
              </label>

              {/* Mode indicator */}
              <div style={{ marginBottom: 12, padding: '6px 10px', borderRadius: 6, fontSize: 12,
                background: liveMode ? '#ef444422' : '#16a34a22',
                color: liveMode ? '#ef4444' : '#22c55e',
                border: `1px solid ${liveMode ? '#ef444444' : '#16a34a44'}`,
              }}>
                {liveMode
                  ? '⚡ LIVE MODE — real order will be placed on Bybit'
                  : '📄 PAPER MODE — simulated order, no real execution'}
                {!liveMode && <span style={{ color: '#475569', marginLeft: 6 }}>(change in ⚙️ Settings)</span>}
              </div>

              {/* Enter trade button */}
              <button
                onClick={enterTrade}
                disabled={tradeLoading}
                style={{
                  width: '100%', padding: '12px 0', border: 'none', borderRadius: 8,
                  fontWeight: 700, fontSize: 15, cursor: tradeLoading ? 'not-allowed' : 'pointer',
                  background: tradeLoading ? '#1e1e2e' : result.direction === 'LONG' ? '#16a34a' : '#dc2626',
                  color: tradeLoading ? '#475569' : '#fff',
                  transition: 'opacity 0.2s',
                }}
              >
                {tradeLoading
                  ? 'Placing order…'
                  : `${result.direction === 'LONG' ? '▲ BUY' : '▼ SELL'} ${result.symbol} — ${liveMode ? 'LIVE' : 'PAPER'}`}
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
                color: tradeResult.error ? '#ef4444' : tradeResult.rejected ? '#eab308' : '#22c55e',
              }}>
                {tradeResult.error ? '✗ Trade Error' : tradeResult.rejected ? '⚠ Trade Rejected' : tradeResult.paper ? '📄 Paper Trade' : '✓ Order Placed'}
              </div>

              {tradeResult.message && (
                <div style={{ color: '#cbd5e1', fontSize: 13, marginBottom: 8 }}>{tradeResult.message}</div>
              )}
              {tradeResult.error && (
                <div style={{ color: '#ef4444', fontSize: 13 }}>{tradeResult.error}</div>
              )}
              {tradeResult.leverageWarning && (
                <div style={{ color: '#eab308', fontSize: 12, marginBottom: 6 }}>{tradeResult.leverageWarning}</div>
              )}

              {/* Paper / live details */}
              {(tradeResult.paper || tradeResult.success) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#94a3b8' }}>
                  {tradeResult.orderId && <div>Order ID: <span style={{ color: '#e2e8f0' }}>{tradeResult.orderId}</span></div>}
                  {tradeResult.qty && <div>Qty: <span style={{ color: '#e2e8f0' }}>{tradeResult.qty}</span></div>}
                  {tradeResult.balance && <div>Balance: <span style={{ color: '#e2e8f0' }}>${tradeResult.balance}</span></div>}
                  {tradeResult.riskAmt && <div>Risk amount: <span style={{ color: '#e2e8f0' }}>${tradeResult.riskAmt}</span></div>}
                  {tradeResult.feeEstimate && (
                    <div>Est. fees: <span style={{ color: '#e2e8f0' }}>${tradeResult.feeEstimate.totalFee}</span>
                      {tradeResult.feeEstimate.note && <span style={{ color: '#475569' }}> · {tradeResult.feeEstimate.note}</span>}
                    </div>
                  )}
                  {tradeResult.simulated && (
                    <div style={{ marginTop: 4 }}>
                      <span style={{ color: '#475569' }}>Simulated · </span>
                      {tradeResult.simulated.symbol} {tradeResult.simulated.direction} @{' '}
                      ${tradeResult.simulated.entry} · {tradeResult.simulated.leverage}× · {tradeResult.simulated.riskPct}% risk
                    </div>
                  )}
                </div>
              )}

              {/* Retry with force */}
              {tradeResult.rejected && !forceTrade && (
                <button
                  onClick={() => { setForceTrade(true); }}
                  style={{
                    marginTop: 8, padding: '6px 14px', background: '#eab30822',
                    border: '1px solid #eab30844', borderRadius: 6, color: '#eab308',
                    cursor: 'pointer', fontSize: 12, fontWeight: 600,
                  }}
                >
                  Enable force override and retry
                </button>
              )}
            </div>
          )}

          {/* Verdict */}
          <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
            <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 13, color: '#94a3b8' }}>VERDICT</div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.7, color: '#cbd5e1' }}>
              {result.verdict}
            </pre>
          </div>

          {/* Raw signal toggle */}
          <button
            onClick={() => setShowRaw(v => !v)}
            style={{
              padding: '8px 0', background: 'none', border: '1px solid #1e1e2e',
              borderRadius: 8, color: '#64748b', cursor: 'pointer',
            }}
          >
            {showRaw ? 'Hide' : 'Show'} raw signal text
          </button>

          {showRaw && (
            <div style={{ padding: 16, background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.7, color: '#94a3b8' }}>
                {result.masterSignal.signalText}
              </pre>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
