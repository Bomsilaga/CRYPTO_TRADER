/**
 * risk/riskModel.ts — deterministic account math shared by UI, AI prompt and execution.
 * The AI never does this arithmetic; it reads the result.
 */
export interface RiskInputs {
  capital: number;
  riskPct: number;
  entry: number;
  stopLoss: number;
  tp1: number; tp2: number; tp3: number;
  direction: 'LONG' | 'SHORT';
  leverage: number;
  orderType: 'Limit' | 'Market';
  tpSplit?: [number, number, number];
  takerFee?: number; makerFee?: number;
  slippageBps?: number;
  fundingRate8h?: number | null;
  expectedHoldHours?: number;
  marginOverride?: number;        // when the user fixes margin instead of risk
  mmr?: number;                   // maintenance margin rate
}

export interface RiskModel {
  capital: number; riskPct: number; riskAmount: number;
  direction: 'LONG' | 'SHORT'; entry: number; stopLoss: number; tp1: number; tp2: number; tp3: number;
  stopDistancePct: number; tp1DistancePct: number; tp2DistancePct: number; tp3DistancePct: number;
  rMultiples: { tp1: number; tp2: number; tp3: number };
  qty: number; notional: number; leverage: number;
  margin: { atLeverage: number; x2: number; x3: number; x5: number };
  liquidation: { price: number; distancePct: number; stopToLiqPct: number; safetyBufferPct: number; safe: boolean; maxSafeLeverage: number; basis: 'estimate' | 'exchange' };
  fees: { entry: number; stopExit: number; tp1Exit: number; tp2Exit: number; tp3Exit: number; takerFee: number; makerFee: number };
  slippage: { entry: number; stop: number; totalIfStopped: number };
  funding: { rate8h: number | null; estimate: number; hours: number };
  net: { stop: number; tp1Full: number; tp2Full: number; tp3Full: number; staged: number; stagedR: number };
  gross: { stop: number; tp1Full: number; tp2Full: number; tp3Full: number; staged: number };
  warnings: string[];
}

const DEFAULTS = { takerFee: 0.00055, makerFee: 0.0002, slippageBps: 5, mmr: 0.005, tpSplit: [0.5, 0.25, 0.25] as [number, number, number] };

export function computeRiskModel(i: RiskInputs): RiskModel {
  const taker = i.takerFee ?? DEFAULTS.takerFee, maker = i.makerFee ?? DEFAULTS.makerFee;
  const slipF = (i.slippageBps ?? DEFAULTS.slippageBps) / 10_000;
  const mmr = i.mmr ?? DEFAULTS.mmr;
  const split = i.tpSplit ?? DEFAULTS.tpSplit;
  const warnings: string[] = [];
  const dir = i.direction === 'LONG' ? 1 : -1;
  const stopDist = Math.abs(i.entry - i.stopLoss);
  const stopDistancePct = i.entry > 0 ? stopDist / i.entry : 0;
  if (stopDist <= 0) throw new Error('Stop equals entry');
  if ((i.direction === 'LONG' && i.stopLoss >= i.entry) || (i.direction === 'SHORT' && i.stopLoss <= i.entry)) throw new Error('Stop on wrong side of entry');

  let riskAmount = i.capital * (i.riskPct / 100);
  const qty = i.marginOverride && i.marginOverride > 0 ? (i.marginOverride * i.leverage) / i.entry : riskAmount / stopDist;
  const notional = qty * i.entry;
  if (i.marginOverride && i.marginOverride > 0) { riskAmount = qty * stopDist; warnings.push(`Margin override active: risk at stop is ${riskAmount.toFixed(2)} (${((riskAmount / i.capital) * 100).toFixed(2)}% of capital).`); }
  const margin = { atLeverage: notional / i.leverage, x2: notional / 2, x3: notional / 3, x5: notional / 5 };
  if (margin.atLeverage > i.capital * 0.9) warnings.push(`Margin ${margin.atLeverage.toFixed(0)} exceeds 90% of capital — size will be capped at execution.`);

  const liqDist = Math.max(0, 1 / i.leverage - mmr);
  const liqPrice = i.direction === 'LONG' ? i.entry * (1 - liqDist) : i.entry * (1 + liqDist);
  const stopToLiqPct = Math.max(0, liqDist - stopDistancePct);
  const maxSafeLeverage = Math.max(1, Math.floor(1 / (stopDistancePct * 1.5 + mmr)));
  const liqSafe = liqDist > stopDistancePct * 1.5;
  if (!liqSafe) warnings.push(`Liquidation buffer too thin at ${i.leverage}× (liq ${(liqDist * 100).toFixed(2)}% vs stop ${(stopDistancePct * 100).toFixed(2)}%). Max safe leverage ${maxSafeLeverage}×.`);

  const entryFeeRate = i.orderType === 'Limit' ? maker : taker;
  const fees = {
    entry: notional * entryFeeRate,
    stopExit: qty * i.stopLoss * taker,
    tp1Exit: qty * i.tp1 * maker, tp2Exit: qty * i.tp2 * maker, tp3Exit: qty * i.tp3 * maker,
    takerFee: taker, makerFee: maker,
  };
  const slippage = { entry: i.orderType === 'Market' ? notional * slipF : 0, stop: qty * i.stopLoss * slipF, totalIfStopped: 0 };
  slippage.totalIfStopped = slippage.entry + slippage.stop;
  const hours = i.expectedHoldHours ?? 8;
  const fundingEst = i.fundingRate8h != null ? notional * i.fundingRate8h * (hours / 8) * dir : 0;

  const grossAt = (p: number, frac = 1) => qty * frac * (p - i.entry) * dir;
  const netFull = (p: number, exitFee: number, extraSlip = 0) => grossAt(p) - fees.entry - exitFee - slippage.entry - extraSlip - fundingEst;
  const gross = { stop: grossAt(i.stopLoss), tp1Full: grossAt(i.tp1), tp2Full: grossAt(i.tp2), tp3Full: grossAt(i.tp3), staged: grossAt(i.tp1, split[0]) + grossAt(i.tp2, split[1]) + grossAt(i.tp3, split[2]) };
  const stagedFees = fees.entry + fees.tp1Exit * split[0] + fees.tp2Exit * split[1] + fees.tp3Exit * split[2];
  const net = {
    stop: netFull(i.stopLoss, fees.stopExit, slippage.stop),
    tp1Full: netFull(i.tp1, fees.tp1Exit), tp2Full: netFull(i.tp2, fees.tp2Exit), tp3Full: netFull(i.tp3, fees.tp3Exit),
    staged: gross.staged - stagedFees - slippage.entry - fundingEst,
    stagedR: 0,
  };
  net.stagedR = riskAmount > 0 ? net.staged / Math.abs(net.stop) : 0;
  const rr = (p: number) => Math.abs(p - i.entry) / stopDist;
  return {
    capital: i.capital, riskPct: i.riskPct, riskAmount,
    direction: i.direction, entry: i.entry, stopLoss: i.stopLoss, tp1: i.tp1, tp2: i.tp2, tp3: i.tp3,
    stopDistancePct, tp1DistancePct: Math.abs(i.tp1 - i.entry) / i.entry, tp2DistancePct: Math.abs(i.tp2 - i.entry) / i.entry, tp3DistancePct: Math.abs(i.tp3 - i.entry) / i.entry,
    rMultiples: { tp1: rr(i.tp1), tp2: rr(i.tp2), tp3: rr(i.tp3) },
    qty, notional, leverage: i.leverage, margin,
    liquidation: { price: liqPrice, distancePct: liqDist * 100, stopToLiqPct: stopToLiqPct * 100, safetyBufferPct: stopDistancePct > 0 ? (liqDist / stopDistancePct) * 100 : 0, safe: liqSafe, maxSafeLeverage, basis: 'estimate' },
    fees, slippage,
    funding: { rate8h: i.fundingRate8h ?? null, estimate: fundingEst, hours },
    net, gross, warnings,
  };
}
