import type { SweepEvent, SweepManagement } from '@/lib/indicators';

export type Direction = 'LONG' | 'SHORT' | 'NEUTRAL';
export type SetupStyle = 'SCALP' | 'INTRADAY' | 'SWING';
export type AlignmentQuality = 'EXCELLENT' | 'STRONG' | 'MODERATE' | 'POOR';

export interface StyleSignal {
  style: SetupStyle;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  tp4?: number;
  grossRR: number;
  netRR: number;
  leverage: number;
  leverageOptions: number[];
  leverageReasoning: string;
  leverageWarning?: string;
  confidence: number;
  entryTiming: 'READY' | 'WAIT_PULLBACK' | 'WAIT_RETEST';
  signalText: string;
  // Structural entry (levels.ts). `structural` is false when the ATR fallback was used.
  entryMode: 'MARKET' | 'LIMIT';
  entryStatus: 'NOW' | 'WAIT_PULLBACK' | 'WAIT_RETEST';
  entryZone: [number, number];
  entryBasis: string;
  entryKinds: string[];
  entryTfs: string[];
  confluence: number;
  confirmation: { pattern: string; tf: string } | null;
  stopBasis: string;
  targetBasis: [string, string, string];
  structural: boolean;
  maxWaitBars: number;
}

export interface DeepAnalysis {
  wyckoffPhase: string;
  rsi: number;
  bbWidth: number;
  volRatio: number;
  vwapAbove: boolean;
  poc: number;
  oteZone: { low: number; high: number };
  amdBias: 'ACCUMULATION' | 'DISTRIBUTION' | 'MANIPULATION' | 'UNCLEAR';
  fibLevels: { label: string; price: number }[];
  hasBOS: boolean;
  hasOB: boolean;
  hasFVG: boolean;
  hasSweep: boolean;
  hasChoCH: boolean;
  macdBull: boolean;
  macdBear: boolean;
  orderbookImbalance: 'BID_HEAVY' | 'ASK_HEAVY' | 'BALANCED';
  sweeps: Omit<SweepEvent, 'candle'>[];
  sweepManagement: SweepManagement;
}
