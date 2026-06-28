/**
 * Simple in-memory scan result cache shared across the process lifetime.
 * On serverless this lives as long as the function container is warm (~minutes).
 * Good enough for showing "last scan" in the UI without a database.
 */

export interface ScanAlert {
  symbol: string;
  score: number;
  direction: string;
  tier: string;
}

export interface LastScanResult {
  timestamp: string;
  scanned: number;
  elapsed: number;
  alerts: ScanAlert[];
  timedOut: boolean;
}

// Module-level cache — survives across requests within the same container
let lastScan: LastScanResult | null = null;

export function setLastScan(result: LastScanResult) {
  lastScan = result;
}

export function getLastScan(): LastScanResult | null {
  return lastScan;
}
