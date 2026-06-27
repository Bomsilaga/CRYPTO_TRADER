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
