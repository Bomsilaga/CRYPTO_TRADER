/**
 * history/types.ts — shared types for the independent historical engine.
 *
 * Everything in this module is derived from exchange market data, never from
 * user journal entries. The journal is a *secondary* realized-performance layer.
 */
import type { RawCandle } from '@/lib/bybit';
import type { Direction, SetupStyle } from '@/types';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export const TF_ORDER: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

export interface StoredCandle extends RawCandle {
  turnover?: number;
}

export interface FundingPoint {
  time: number;   // funding settlement timestamp (ms)
  rate: number;   // e.g. 0.0001 = 0.01%
}

export interface SyncState {
  symbol: string;
  timeframe: Timeframe;
  firstTime: number;
  lastTime: number;
  count: number;
  updatedAt: string;
}

export type VolRegime = 'LOW' | 'NORMAL' | 'HIGH';
export type TrendRegime = 'BULL' | 'BEAR' | 'RANGE';
export type VolumeRegime = 'THIN' | 'NORMAL' | 'HEAVY';

/**
 * Feature snapshot — the state of the market as the live engine would have
 * known it at the decision timestamp. Every field is computed only from
 * candles whose close time is <= the decision time (look-ahead safe).
 */
export interface FeatureSnapshot {
  symbol: string;
  time: number;                 // decision time (ms) = close time of the decision candle
  direction: 'LONG' | 'SHORT';
  score: number;                // engine Setup Quality score at T
  confidence: number;
  setupStyle: SetupStyle;
  trend1m: string;
  trend5m: string;
  trend15m: string;
  trend1h: string;
  trend4h: string;
  trend1d: string;
  alignment: number;
  rsi: number;
  macdLine: number;
  macdSignal: number;
  macdHist: number;
  atr: number;
  atrPct: number;               // ATR / price
  atrPercentile: number;        // 0..100 vs trailing ATR% distribution (past only)
  bbWidth: number;
  volRegime: VolRegime;
  trendRegime: TrendRegime;
  volumeRatio: number;
  volumeRegime: VolumeRegime;
  vwapDistPct: number;          // (price - vwap) / price * 100
  pocDistPct: number;
  swingHighDistPct: number;
  swingLowDistPct: number;
  bos: boolean;
  choch: boolean;
  orderBlock: boolean;
  fvg: boolean;
  sweep: boolean;
  inOTE: boolean;
  wyckoff: string;
  fundingRate: number | null;
  change24hPct: number;
  btcRegime: TrendRegime | 'UNKNOWN';
  btcTrend1h: string;
  btcTrend4h: string;
  btcVolRegime: VolRegime | 'UNKNOWN';
  tfCoverage: string;           // e.g. "5m,15m,1h,4h,1d" — which TFs had data at T
}

export type FirstOutcome = 'TP1' | 'TP2' | 'TP3' | 'STOP' | 'TIMEOUT';

export interface BacktestTrade {
  symbol: string;
  time: number;
  direction: 'LONG' | 'SHORT';
  setupStyle: SetupStyle;
  score: number;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  stopDistancePct: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  stopHit: boolean;
  firstOutcome: FirstOutcome;
  finalExit: 'TP3' | 'STOP' | 'BREAKEVEN' | 'TIMEOUT';
  mfePct: number;
  maePct: number;
  mfeR: number;
  maeR: number;
  timeToTP1: number | null;     // ms from decision time
  timeToTP2: number | null;
  timeToTP3: number | null;
  timeToStop: number | null;
  holdMs: number;
  grossR: number;
  netR: number;
  feesR: number;
  fundingR: number;
  slippageR: number;
  ambiguousCandles: number;     // candles where TP and SL both touched, resolved by lower TF or conservatively
  ambiguityResolvedBy: 'lower-tf' | 'conservative' | 'none';
  regimeKey: string;
  features: FeatureSnapshot;
}

export interface ExecutionProfile {
  name: 'conservative' | 'base';
  entryFee: number;     // fraction of notional
  stopFee: number;
  tpFee: number;
  timeoutFee: number;
  slippageBps: number;  // applied to taker fills (entry if taker, stop, timeout)
  entryIsTaker: boolean;
}

export const EXECUTION_PROFILES: Record<ExecutionProfile['name'], ExecutionProfile> = {
  conservative: { name: 'conservative', entryFee: 0.00055, stopFee: 0.00055, tpFee: 0.0002, timeoutFee: 0.00055, slippageBps: 5, entryIsTaker: true },
  base:         { name: 'base',         entryFee: 0.0002,  stopFee: 0.00055, tpFee: 0.0002, timeoutFee: 0.00055, slippageBps: 2, entryIsTaker: false },
};

export interface BacktestConfig {
  decisionTf: Timeframe;              // '1h'
  profile: ExecutionProfile['name'];
  tpSplit: [number, number, number];  // [0.5, 0.25, 0.25]
  moveStopToBreakevenAfterTP1: boolean;
  timeoutBarsByStyle: Record<SetupStyle, number>;
  oneAtATime: boolean;                // realistic: no overlapping replays
  minSetupScore: number;              // default population filter for stats
  warmupBars: number;                 // bars before first decision
  liveLimits: Partial<Record<Timeframe, number>>; // candle counts the live engine sees
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  decisionTf: '1h',
  profile: 'conservative',
  tpSplit: [0.5, 0.25, 0.25],
  moveStopToBreakevenAfterTP1: true,
  timeoutBarsByStyle: { SCALP: 12, INTRADAY: 72, SWING: 240 },
  oneAtATime: true,
  minSetupScore: 60,
  warmupBars: 210,
  liveLimits: { '1m': 80, '5m': 100, '15m': 100, '1h': 200, '4h': 100, '1d': 100 },
};

export interface WilsonInterval { low: number; high: number }

export type SampleQuality = 'INSUFFICIENT' | 'VERY LOW EVIDENCE' | 'LOW EVIDENCE' | 'MODERATE' | 'GOOD' | 'STRONGER EVIDENCE';

export interface RateStat { rate: number; hits: number; n: number; ci95: WilsonInterval }

export interface StatBlock {
  label: string;
  n: number;
  quality: SampleQuality;
  winRate: RateStat;          // netR > 0
  tp1: RateStat;              // TP1 before stop
  tp2: RateStat;
  tp3: RateStat;
  stopFirst: RateStat;
  timeout: RateStat;
  avgWinR: number;
  avgLossR: number;
  expectancyR: number;
  medianR: number;
  profitFactor: number;
  avgMfeR: number;
  avgMaeR: number;
  maxDrawdownR: number;
  maxDrawdownPct: number;      // vs peak cumulative R, as % of peak (0 if peak<=0)
  maxConsecutiveLosses: number;
  avgHoldMs: number;
  medianHoldMs: number;
  netCumulativeR: number;
  grossCumulativeR: number;
  firstTime: number | null;
  lastTime: number | null;
  regimeConcentration: { key: string; share: number } | null;
}

export interface WalkForwardFold {
  trainFrom: number; trainTo: number; testFrom: number; testTo: number;
  chosenMinScore: number;
  candidates: { minScore: number; trainExpectancyR: number; trainN: number }[];
  inSample: StatBlock;
  validation: StatBlock;
}

export interface WalkForwardResult {
  method: string;
  folds: WalkForwardFold[];
  inSample: StatBlock;         // pooled train windows (note: overlapping)
  outOfSample: StatBlock;      // pooled validation months
  degradationR: number;        // inSample.expectancy - outOfSample.expectancy
  warnings: string[];
}

export interface DecayResult {
  last20: StatBlock; last50: StatBlock; last90d: StatBlock; longTerm: StatBlock;
  status: 'STABLE' | 'EDGE WEAKENING' | 'EDGE NEGATIVE' | 'INSUFFICIENT';
  note: string;
}

export interface BtcSplitResult {
  withBtcAligned: StatBlock;
  withBtcOpposed: StatBlock;
  withBtcRange: StatBlock;
  differenceR: number;                   // aligned - opposed expectancy
  evidenceSupportsSizingRule: boolean;   // only true when both samples are adequate and the gap is material
  note: string;
}

export interface FeatureNorm { mean: number; std: number }

export interface BacktestRun {
  symbol: string;
  version: number;
  builtAt: string;
  config: BacktestConfig;
  coverage: Record<string, { from: number; to: number; count: number }>;
  decisions: number;
  neutralDecisions: number;
  skippedWhileOpen: number;
  trades: BacktestTrade[];
  featureNorms: Record<string, FeatureNorm>;
  stats: {
    all: StatBlock;
    LONG: StatBlock;
    SHORT: StatBlock;
    byRegime: Record<string, StatBlock>;
    walkForward: { LONG: WalkForwardResult; SHORT: WalkForwardResult; all: WalkForwardResult };
    decay: { LONG: DecayResult; SHORT: DecayResult };
    btcSplit: { LONG: BtcSplitResult; SHORT: BtcSplitResult };
  };
}

export type CandleMap = Partial<Record<Timeframe, StoredCandle[]>>;
export type EngineDirection = Direction;
