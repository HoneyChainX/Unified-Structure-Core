/**
 * Tiny fetch wrapper with bearer auth + connection settings persistence.
 *
 * Connection state (server URL + bearer token) lives in Capacitor Preferences
 * on a real device and falls back to localStorage in the dev server.
 */
import { Preferences } from "@capacitor/preferences";

const SERVER_KEY = "usc.server";
const TOKEN_KEY = "usc.token";

export interface Connection {
  serverUrl: string;   // e.g. https://bot.example.com
  token: string;
}

async function safeGet(key: string): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key });
    return value;
  } catch {
    return window.localStorage.getItem(key);
  }
}
async function safeSet(key: string, value: string): Promise<void> {
  try {
    await Preferences.set({ key, value });
  } catch {
    window.localStorage.setItem(key, value);
  }
}
async function safeRemove(key: string): Promise<void> {
  try {
    await Preferences.remove({ key });
  } catch {
    window.localStorage.removeItem(key);
  }
}

export async function loadConnection(): Promise<Connection | null> {
  const [serverUrl, token] = await Promise.all([safeGet(SERVER_KEY), safeGet(TOKEN_KEY)]);
  if (!serverUrl || !token) return null;
  return { serverUrl, token };
}

export async function saveConnection(conn: Connection): Promise<void> {
  await Promise.all([safeSet(SERVER_KEY, conn.serverUrl), safeSet(TOKEN_KEY, conn.token)]);
}

export async function clearConnection(): Promise<void> {
  await Promise.all([safeRemove(SERVER_KEY), safeRemove(TOKEN_KEY)]);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function apiGet<T>(conn: Connection, path: string): Promise<T> {
  const res = await fetch(`${conn.serverUrl.replace(/\/$/, "")}${path}`, {
    headers: { Authorization: `Bearer ${conn.token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, text || `HTTP ${res.status}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function apiPost<T>(conn: Connection, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${conn.serverUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, text || `HTTP ${res.status}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

// ── Payload types (kept in sync with artifacts/api-server/src/routes/mobile.ts) ──

export interface DashboardPayload {
  equityUsdt: number | null;
  dailyRealisedPnl: number;
  openTradesByProtection: Record<string, number>;
  totalOpen: number;
  asOf: string;
}

export interface Position {
  id: number;
  engine: "webhook" | "scalper";
  symbol: string;
  side: "buy" | "sell";
  entryPrice: string | number | null;
  livePrice: string | number | null;
  quantity: string | number | null;
  pnl: string | number | null;
  protectionState: string;
  createdAt: string;
  strategy: string | null;
  quality: string | null;
}

export interface SignalRow {
  id: number;
  symbol: string;
  tf: string;
  dir: string;
  grade: string | null;
  quality: string | null;
  triggered: boolean;
  receivedAt: string;
}
