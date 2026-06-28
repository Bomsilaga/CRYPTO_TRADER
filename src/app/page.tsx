'use client';

import { useState, useEffect } from 'react';

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

const POPULAR = ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT'];

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

export default function Home() {
  const [symbol, setSymbol] = useState('ETHUSDT');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [autoScan, setAutoScan] = useState<AutoScanResult | null>(null);

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
    try {
      const res = await fetch(`/api/scan?symbol=${sym.toUpperCase()}`);
      const data = await res.json() as ScanResult;
      setResult(data);
    } catch (e) {
      setResult({ ok: false, error: String(e) } as ScanResult);
    } finally {
      setLoading(false);
    }
  }

  const dirColor = result?.direction === 'LONG' ? '#22c55e' : result?.direction === 'SHORT' ? '#ef4444' : '#94a3b8';

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: '24px 16px' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.5px' }}>
          🚀 4SCANS
        </h1>
        <p style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>
          Bybit perpetuals · ICT + Wyckoff signal engine
        </p>
      </div>

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
