import crypto from "node:crypto";
export type Params = Record<string, string | number | boolean>;
export type ExchangeResult = {
  retCode: number;
  retMsg: string;
  result: {
    list?: Record<string, string>[];
    orderId?: string;
    [key: string]: unknown;
  };
};
export function signedPayload(method: "GET" | "POST", params: Params) {
  return method === "GET"
    ? new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ).toString()
    : JSON.stringify(params);
}
export async function privateRequest(
  method: "GET" | "POST",
  path: string,
  params: Params = {},
): Promise<ExchangeResult> {
  const key = process.env.BYBIT_API_KEY,
    secret = process.env.BYBIT_API_SECRET;
  if (!key || !secret) throw new Error("Bybit credentials not configured");
  const payload = signedPayload(method, params),
    timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", secret)
    .update(timestamp + key + "5000" + payload)
    .digest("hex");
  const base =
    process.env.BYBIT_TESTNET === "true"
      ? "https://api-testnet.bybit.com"
      : "https://api.bybit.com";
  const response = await fetch(
    base + path + (method === "GET" && payload ? "?" + payload : ""),
    {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": key,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": "5000",
        "X-BAPI-SIGN": signature,
      },
      body: method === "POST" ? payload : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`);
  const data = await response.json();
  if (
    data.retCode !== 0 &&
    !(path === "/v5/position/set-leverage" && data.retCode === 110043)
  )
    throw new Error(`Bybit ${path}: ${data.retCode} ${data.retMsg}`);
  return data;
}
