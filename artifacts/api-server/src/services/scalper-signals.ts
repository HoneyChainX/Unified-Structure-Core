/**
 * Scalper signal engine — Bollinger Band mean-reversion + RSI + volume spike
 *
 * For each of the top-5 USDT pairs by 24h volume on Gate.io:
 *   1. Fetch last N 5-minute candles (at least bbPeriod + 1)
 *   2. Compute Bollinger Bands (SMA ± stdDev * σ)
 *   3. Compute RSI(rsiPeriod)
 *   4. Compute volume ratio (last candle volume vs 20-period avg)
 *   5. Entry conditions:
 *      LONG:  close ≤ bbLower  AND  rsi ≤ rsiOversold  AND  volumeRatio ≥ spike threshold
 *      SHORT: close ≥ bbUpper  AND  rsi ≥ rsiOverbought AND  volumeRatio ≥ spike threshold
 */

import { logger } from "../lib/logger";

const GATE_BASE = "https://api.gateio.ws/api/v4";
const CANDLE_LIMIT = 60;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ScalperSignal {
  symbol: string;
  gateSymbol: string;
  side: "buy" | "sell";
  entryPrice: number;
  bbUpper: number;
  bbLower: number;
  bbMid: number;
  rsi: number;
  volumeRatio: number;
}

// ── Public helpers ──────────────────────────────────────────────────────────

export async function getTopUsdtSymbols(n = 5): Promise<string[]> {
  const url = `${GATE_BASE}/spot/tickers`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gate.io tickers error: ${res.status}`);
  const tickers = (await res.json()) as Array<{
    currency_pair: string;
    base_volume: string;
    quote_volume: string;
  }>;

  return tickers
    .filter((t) => t.currency_pair.endsWith("_USDT"))
    .sort((a, b) => parseFloat(b.quote_volume) - parseFloat(a.quote_volume))
    .slice(0, n)
    .map((t) => t.currency_pair);
}

export async function fetchCandles(gateSymbol: string, interval = "5m", limit = CANDLE_LIMIT): Promise<Candle[]> {
  const url = `${GATE_BASE}/spot/candlesticks?currency_pair=${gateSymbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gate.io candles error for ${gateSymbol}: ${res.status}`);
  const raw = (await res.json()) as string[][];

  return raw.map((c) => ({
    time: parseInt(c[0]),
    volume: parseFloat(c[1]),
    close: parseFloat(c[2]),
    high: parseFloat(c[3]),
    low: parseFloat(c[4]),
    open: parseFloat(c[5]),
  }));
}

// ── Indicator functions ─────────────────────────────────────────────────────

function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function stdDev(values: number[], period: number, mean: number): number {
  const slice = values.slice(-period);
  const variance = slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / slice.length;
  return Math.sqrt(variance);
}

export interface BBResult {
  upper: number;
  mid: number;
  lower: number;
}

export function computeBB(closes: number[], period: number, multiplier: number): BBResult {
  const mid = sma(closes, period);
  const sd = stdDev(closes, period, mid);
  return {
    upper: mid + multiplier * sd,
    mid,
    lower: mid - multiplier * sd,
  };
}

export function computeRSI(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeVolumeRatio(volumes: number[], avgPeriod = 20): number {
  if (volumes.length < 2) return 1;
  const avgVol = sma(volumes.slice(0, -1), Math.min(avgPeriod, volumes.length - 1));
  const lastVol = volumes[volumes.length - 1];
  return avgVol > 0 ? lastVol / avgVol : 1;
}

// ── Signal evaluation ───────────────────────────────────────────────────────

export interface SignalParams {
  bbPeriod: number;
  bbStdDev: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  volumeSpikeMultiplier: number;
  longOnly: boolean;
}

export function evaluateSignal(
  gateSymbol: string,
  candles: Candle[],
  params: SignalParams
): ScalperSignal | null {
  if (candles.length < Math.max(params.bbPeriod, params.rsiPeriod) + 2) {
    logger.debug({ gateSymbol, count: candles.length }, "Not enough candles for signal evaluation");
    return null;
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const lastClose = closes[closes.length - 1];

  const bb = computeBB(closes, params.bbPeriod, params.bbStdDev);
  const rsi = computeRSI(closes, params.rsiPeriod);
  const volumeRatio = computeVolumeRatio(volumes);

  const hasVolumeSpike = volumeRatio >= params.volumeSpikeMultiplier;
  const symbol = gateSymbol.replace("_", "");

  if (lastClose <= bb.lower && rsi <= params.rsiOversold && hasVolumeSpike) {
    return {
      symbol,
      gateSymbol,
      side: "buy",
      entryPrice: lastClose,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      bbMid: bb.mid,
      rsi,
      volumeRatio,
    };
  }

  if (!params.longOnly && lastClose >= bb.upper && rsi >= params.rsiOverbought && hasVolumeSpike) {
    return {
      symbol,
      gateSymbol,
      side: "sell",
      entryPrice: lastClose,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      bbMid: bb.mid,
      rsi,
      volumeRatio,
    };
  }

  return null;
}

// ── Full scan ───────────────────────────────────────────────────────────────

export async function scanForSignals(params: SignalParams): Promise<ScalperSignal[]> {
  let symbols: string[];
  try {
    symbols = await getTopUsdtSymbols(5);
  } catch (err) {
    logger.error({ err }, "Scalper: failed to fetch top symbols");
    return [];
  }

  const results = await Promise.allSettled(
    symbols.map(async (gateSymbol) => {
      const candles = await fetchCandles(gateSymbol, 300, CANDLE_LIMIT);
      return evaluateSignal(gateSymbol, candles, params);
    })
  );

  const signals: ScalperSignal[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value != null) {
      signals.push(result.value);
    } else if (result.status === "rejected") {
      logger.warn({ err: result.reason }, "Scalper: signal scan error for symbol");
    }
  }

  return signals;
}
