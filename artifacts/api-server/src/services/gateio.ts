import crypto from "crypto";
import { logger } from "../lib/logger";

const BASE_URL = "https://api.gateio.ws/api/v4";

function sign(
  method: string,
  path: string,
  query: string,
  body: string,
  timestamp: string
): string {
  const bodyHash = crypto.createHash("sha512").update(body).digest("hex");
  const payload = `${method}\n${path}\n${query}\n${bodyHash}\n${timestamp}`;
  const secret = process.env.GATEIO_API_SECRET ?? "";
  return crypto.createHmac("sha512", secret).update(payload).digest("hex");
}

async function request<T>(
  method: string,
  path: string,
  params?: Record<string, string>,
  body?: unknown
): Promise<T> {
  const apiKey = process.env.GATEIO_API_KEY ?? "";
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const query = params ? new URLSearchParams(params).toString() : "";
  const bodyStr = body ? JSON.stringify(body) : "";

  const signature = sign(method.toUpperCase(), path, query, bodyStr, timestamp);

  const url = `${BASE_URL}${path}${query ? "?" + query : ""}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "KEY": apiKey,
      "SIGN": signature,
      "Timestamp": timestamp,
    },
    ...(bodyStr ? { body: bodyStr } : {}),
  });

  const text = await res.text();

  if (!res.ok) {
    logger.error({ status: res.status, body: text, path }, "Gate.io API error");
    throw new Error(`Gate.io ${res.status}: ${text}`);
  }

  return JSON.parse(text) as T;
}

export interface SpotAccount {
  currency: string;
  available: string;
  locked: string;
}

export async function getSpotAccounts(): Promise<SpotAccount[]> {
  return request<SpotAccount[]>("GET", "/spot/accounts");
}

export async function getUsdtBalance(): Promise<number> {
  const accounts = await getSpotAccounts();
  const usdt = accounts.find((a) => a.currency === "USDT");
  return usdt ? parseFloat(usdt.available) : 0;
}

export interface SpotOrder {
  id: string;
  status: string;
  currency_pair: string;
  side: string;
  amount: string;
  price: string;
  avg_deal_price: string;
  filled_amount: string;
  create_time_ms: string;
}

export async function placeSpotOrder(params: {
  currencyPair: string;
  side: "buy" | "sell";
  amount: string;
  price?: string;
  type?: "limit" | "market";
}): Promise<SpotOrder> {
  const body: Record<string, string> = {
    currency_pair: params.currencyPair,
    side: params.side,
    amount: params.amount,
    type: params.type ?? "market",
    account: "spot",
    time_in_force: "ioc",
  };

  if (params.type === "limit" && params.price) {
    body.price = params.price;
    body.time_in_force = "gtc";
  }

  return request<SpotOrder>("POST", "/spot/orders", undefined, body);
}

export interface PriceTriggeredOrder {
  id: number;
  status: string;
  reason: string;
}

export async function placePriceTriggeredOrder(params: {
  currencyPair: string;
  triggerPrice: string;
  triggerRule: ">=" | "<=";
  side: "buy" | "sell";
  amount: string;
  orderPrice: string;
}): Promise<PriceTriggeredOrder> {
  const body = {
    trigger: {
      price: params.triggerPrice,
      rule: params.triggerRule,
      expiration: 86400 * 7,
    },
    put: {
      type: "limit",
      side: params.side,
      price: params.orderPrice,
      amount: params.amount,
      account: "normal",
      time_in_force: "gtc",
    },
    market: params.currencyPair,
  };

  return request<PriceTriggeredOrder>("POST", "/spot/price_orders", undefined, body);
}

export async function cancelPriceTriggeredOrder(orderId: number, currencyPair: string): Promise<void> {
  await request("DELETE", `/spot/price_orders/${orderId}`, { market: currencyPair });
}

export async function cancelSpotOrder(orderId: string, currencyPair: string): Promise<void> {
  await request("DELETE", `/spot/orders/${orderId}`, { currency_pair: currencyPair });
}

export async function getSpotOrder(orderId: string, currencyPair: string): Promise<SpotOrder> {
  return request<SpotOrder>("GET", `/spot/orders/${orderId}`, { currency_pair: currencyPair });
}

export function toGateSymbol(tvSymbol: string): string {
  const quotes = ["USDT", "USDC", "BTC", "ETH", "BNB"];
  for (const q of quotes) {
    if (tvSymbol.endsWith(q)) {
      const base = tvSymbol.slice(0, -q.length);
      return `${base}_${q}`;
    }
  }
  return tvSymbol.replace(/([A-Z]+)([A-Z]{3,4})$/, "$1_$2");
}
