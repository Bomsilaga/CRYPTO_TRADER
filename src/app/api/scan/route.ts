import { NextRequest, NextResponse } from "next/server";
import { scanPair } from "@/lib/scanner";
import { STYLE, type Style } from "@/lib/history";
export const maxDuration = 60;
export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams,
      symbol = (q.get("symbol") ?? "ETHUSDT").toUpperCase();
    const style = (q.get("style") ?? "INTRADAY") as Style;
    if (!/^[A-Z0-9]{2,25}USDT$/.test(symbol) || !Object.hasOwn(STYLE, style))
      throw new Error("Invalid symbol or style");
    const preferences = {
      style,
      capital: Number(q.get("capital") ?? 5000),
      riskPct: Number(q.get("riskPct") ?? 1),
      leverage: Number(q.get("leverage") ?? 3),
    };
    if (
      !Number.isFinite(preferences.capital) ||
      preferences.capital <= 0 ||
      !Number.isFinite(preferences.riskPct) ||
      preferences.riskPct <= 0 ||
      preferences.riskPct > 100 ||
      !Number.isFinite(preferences.leverage) ||
      preferences.leverage < 1 ||
      preferences.leverage > 100
    )
      throw new Error("Invalid account settings");
    return NextResponse.json(await scanPair(symbol, preferences));
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 400 });
  }
}
