import { fetchHistory, fetchTicker } from "./bybit";
import {
  buildRecords,
  STYLE,
  MODEL_VERSION,
  type Style,
  type RecordTrade,
} from "./history";
import { runEngine, type Preferences } from "./signalEngine";
import { readRecords, saveRecords, journal, persistentStore } from "./store";
import type { RawCandle } from "./bybit";
export async function scanPair(symbol: string, preferences: Preferences) {
  const style: Style = preferences.style,
    key = `${MODEL_VERSION}-${symbol}-${style}`;
  let cached = await readRecords<{
    updated: number;
    candles: RawCandle[];
    records: RecordTrade[];
  }>(key);
  if (!cached || Date.now() - cached.updated > STYLE[style].ms) {
    const candles = await fetchHistory(symbol, STYLE[style].tf);
    cached = {
      updated: Date.now(),
      candles,
      records: buildRecords(symbol, style, candles),
    };
    await saveRecords(key, cached);
  }
  const ticker = await fetchTicker(symbol);
  const result = runEngine(
    symbol,
    ticker.price,
    cached.candles,
    cached.records,
    preferences,
  );
  await journal("signals", result);
  return {
    ok: true,
    change24h: ticker.change24h,
    ...result,
    storage: persistentStore
      ? "persistent"
      : "ephemeral; configure TRADING_DATA_DIR for durable history and journals",
  };
}
