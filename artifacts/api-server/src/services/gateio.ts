import crypto from "crypto";
import { logger } from "../lib/logger";

const BASE = "https://api.gateio.ws";
const API_PATH_PREFIX = "/api/v4";

function sign(
  method: string,
  fullPath: string,
  query: string,
  body: string,
  timestamp: string
): string {
  const bodyHash = crypto.createHash("sha512").update(body).digest("hex");
  const payload = `${method}\n${fullPath}\n${query}\n${bodyHash}\n${timestamp}`;
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

  // Gate.io signature requires the full path including /api/v4 prefix
  const fullPath = `${API_PATH_PREFIX}${path}`;
  const signature = sign(method.toUpperCase(), fullPath, query, bodyStr, timestamp);

  const url = `${BASE}${fullPath}${query ? "?" + query : ""}`;

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

export interface ApiKeyDetail {
  user_id: number;
  ip_whitelist: string[];
  currency_pairs: string[];  // trading pair allowlist (empty = no restriction)
}

export async function getApiKeyDetail(): Promise<ApiKeyDetail> {
  return request<ApiKeyDetail>("GET", "/account/detail");
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

export interface SpotTicker {
  currency_pair: string;
  last: string;
  high_24h: string;
  low_24h: string;
  change_percentage: string;
}

export async function getSpotTicker(currencyPair: string): Promise<SpotTicker> {
  const [ticker] = await request<SpotTicker[]>("GET", "/spot/tickers", {
    currency_pair: currencyPair,
  });
  if (!ticker) throw new Error(`No ticker data for ${currencyPair}`);
  return ticker;
}

export async function getLivePrice(currencyPair: string): Promise<number> {
  const ticker = await getSpotTicker(currencyPair);
  const price = parseFloat(ticker.last);
  if (!price || isNaN(price)) throw new Error(`Invalid price for ${currencyPair}`);
  return price;
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

export interface PriceTriggeredOrderDetail {
  id: number;
  status: "open" | "cancelled" | "finish" | "failed" | "expired";
  reason: string;
  put: {
    filled_total: string;
    amount: string;
    price: string;
    avg_deal_price: string;
    left: string;
  };
  trigger: {
    price: string;
    rule: ">=" | "<=";
  };
  market: string;
}

export async function getPriceTriggeredOrder(orderId: number, currencyPair: string): Promise<PriceTriggeredOrderDetail> {
  return request<PriceTriggeredOrderDetail>("GET", `/spot/price_orders/${orderId}`, { market: currencyPair });
}

export async function placePriceTriggeredOrder(params: {
  currencyPair: string;
  triggerPrice: string;
  triggerRule: ">=" | "<=";
  side: "buy" | "sell";
  amount: string;
  orderPrice: string;
  /** "market" guarantees fill even when price gaps through the trigger level (recommended for SL) */
  orderType?: "limit" | "market";
}): Promise<PriceTriggeredOrder> {
  const isMarket = params.orderType === "market";
  const body = {
    trigger: {
      price: params.triggerPrice,
      rule: params.triggerRule,
      expiration: 86400 * 7,
    },
    put: {
      type: isMarket ? "market" : "limit",
      side: params.side,
      // Gate.io requires price="0" for market put orders
      price: isMarket ? "0" : params.orderPrice,
      amount: params.amount,
      account: "normal",
      time_in_force: isMarket ? "ioc" : "gtc",
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

/**
 * Format a price for Gate.io API calls.
 * Gate.io enforces per-pair decimal precision — exceeding it causes INVALID_PARAM_VALUE.
 * This adapts to price magnitude to stay within safe limits for all liquid USDT pairs.
 */
export function fmtGatePrice(price: number): string {
  if (price >= 10000) return price.toFixed(1);
  if (price >= 1000)  return price.toFixed(2);
  if (price >= 100)   return price.toFixed(3);
  if (price >= 10)    return price.toFixed(4);
  if (price >= 1)     return price.toFixed(5);
  if (price >= 0.1)   return price.toFixed(6);
  return price.toFixed(8);
}

/**
 * Format a base-currency amount for Gate.io API calls.
 * 4 decimal places covers all major pairs; tiny amounts get more precision.
 */
export function fmtGateAmount(amount: number): string {
  if (amount >= 100)  return amount.toFixed(2);
  if (amount >= 1)    return amount.toFixed(4);
  if (amount >= 0.01) return amount.toFixed(5);
  return amount.toFixed(6);
}

// ── Pair-aware precision helpers ─────────────────────────────────────────────
// Gate.io exposes per-pair `precision` (price decimal places) and
// `amount_precision` (base-amount decimal places) via a public REST endpoint.
// Results are cached for the lifetime of the server process.
interface GatePairInfo { precision: number; amount_precision: number; }
const pairInfoCache = new Map<string, GatePairInfo>();

async function fetchPairInfo(currencyPair: string): Promise<GatePairInfo> {
  const cached = pairInfoCache.get(currencyPair);
  if (cached) return cached;
  const res = await fetch(`${BASE}${API_PATH_PREFIX}/spot/currency_pairs/${currencyPair}`);
  if (!res.ok) throw new Error(`Pair info fetch failed: ${res.status}`);
  const data = await res.json() as { precision: number; amount_precision: number };
  const info: GatePairInfo = { precision: data.precision, amount_precision: data.amount_precision };
  pairInfoCache.set(currencyPair, info);
  return info;
}

/**
 * Pair-aware formatter: fetches (and caches) Gate.io's per-pair decimal limits,
 * then formats price and amount to exactly the allowed number of decimal places.
 * Falls back to static heuristics if the pair-info fetch fails.
 */
export async function fmtForPair(
  currencyPair: string,
  price: number,
  amount: number
): Promise<{ price: string; amount: string }> {
  try {
    const info = await fetchPairInfo(currencyPair);
    return {
      price:  price.toFixed(info.precision),
      amount: amount.toFixed(info.amount_precision),
    };
  } catch {
    logger.warn({ currencyPair }, "gateio: could not fetch pair precision — using static fallback");
    return { price: fmtGatePrice(price), amount: fmtGateAmount(amount) };
  }
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
