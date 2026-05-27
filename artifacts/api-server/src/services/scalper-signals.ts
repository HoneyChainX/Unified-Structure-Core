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
  /** Pre-computed TP price from strategy geometry (e.g. Fib 4.236 or CHT TP2 1.5R). When set, executor uses this instead of config-based computation. */
  tpPrice?: number;
  /** Pre-computed SL price from strategy geometry (e.g. below OB low or ATR-based). When set, overrides config slPct. */
  slPrice?: number;
  /** Which engine generated this signal */
  strategy?: string;
  /** Which timeframe the signal was detected on (e.g. "3m", "5m", "1h") */
  timeframe?: string;
  // CHT Engine — 3-TP bracket (TP1=1R 30%, TP2=1.5R 30%, TP3=2R 40%)
  tp1Price?: number;
  tp2Price?: number;
  tp3Price?: number;
  // CHT Engine metadata (populated when strategy === "cht")
  chtScore?: number;
  chtGrade?: string;
  chtSetupType?: string;
  chtTaoVotes?: number;
  chtRr?: number;
  /**
   * Setup quality in [0, 1] — higher = more extreme relative to the symbol's
   * own recent distribution. Populated by the adaptive-threshold path
   * (BB+RSI) and intended as the common scoring channel for future ranking
   * across engines.
   */
  quality?: number;
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

// ── Cycle-scoped candle cache (populated by live scan, consumed by exec scan) ──
const _cycleCache = new Map<string, Candle[]>();

export function injectCandleCache(map: Map<string, Candle[]>): void {
  _cycleCache.clear();
  for (const [k, v] of map) _cycleCache.set(k, v);
}

export function clearCandleCache(): void {
  _cycleCache.clear();
}

export async function fetchCandles(gateSymbol: string, interval = "5m", limit = CANDLE_LIMIT): Promise<Candle[]> {
  const cacheKey = `${gateSymbol}:${interval}`;
  const cached = _cycleCache.get(cacheKey);
  if (cached) return cached;

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

/**
 * Rolling RSI series: returns one RSI value per anchor bar over `window` bars
 * ending at the last candle. Used by the adaptive-threshold path to compute
 * per-symbol RSI quantiles instead of relying on global 30/70 cutoffs.
 *
 * For a closes-array of length N and period P, anchor bar i ∈ [P, N) produces
 * an RSI computed from closes[i-P..i]. Result length = min(window, N-P).
 */
export function computeRSISeries(closes: number[], period: number, window: number): number[] {
  const out: number[] = [];
  if (closes.length < period + 1) return out;
  const startAnchor = Math.max(period, closes.length - window);
  for (let anchor = startAnchor; anchor < closes.length; anchor++) {
    let gains = 0;
    let losses = 0;
    for (let i = anchor - period + 1; i <= anchor; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) { out.push(100); continue; }
    const rs = avgGain / avgLoss;
    out.push(100 - 100 / (1 + rs));
  }
  return out;
}

/**
 * Linear-interpolated quantile on a numeric array. Empty input → fallback.
 * Used by adaptive RSI thresholds and the signal-quality score.
 */
export function quantile(values: number[], q: number, fallback = NaN): number {
  if (values.length === 0) return fallback;
  if (q <= 0) return Math.min(...values);
  if (q >= 1) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeVolumeRatio(volumes: number[], avgPeriod = 20): number {
  if (volumes.length < 2) return 1;
  const avgVol = sma(volumes.slice(0, -1), Math.min(avgPeriod, volumes.length - 1));
  const lastVol = volumes[volumes.length - 1];
  return avgVol > 0 ? lastVol / avgVol : 1;
}

// ── Signal evaluation ───────────────────────────────────────────────────────

// ── EMA ──────────────────────────────────────────────────────────────────────

export function computeEMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1];
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

export interface SignalParams {
  bbPeriod: number;
  bbStdDev: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  volumeSpikeMultiplier: number;
  longOnly: boolean;
  emaFilterEnabled: boolean;
  emaPeriod: number;
  /** Override the symbol list — skips top-5 fetch when provided */
  symbols?: string[];
  /** Timeframe for candle fetching (default "5m") */
  timeframe?: string;
  /**
   * Adaptive RSI thresholds. When true, rsiOversold/rsiOverbought are
   * ignored and replaced by the rolling Nth-percentile of the symbol's
   * recent RSI distribution. Floors clamp the adaptive bounds so quiet
   * markets don't fire signals at RSI 45/55.
   */
  adaptiveThresholds?: boolean;
  adaptiveWindow?: number;       // bars of history (default 100)
  adaptiveLowQ?: number;         // 0..1 (default 0.05)
  adaptiveHighQ?: number;        // 0..1 (default 0.95)
  adaptiveRsiLowFloor?: number;  // clamp upper bound of the adaptive oversold (default 35)
  adaptiveRsiHighFloor?: number; // clamp lower bound of the adaptive overbought (default 65)
}

export function evaluateSignal(
  gateSymbol: string,
  candles: Candle[],
  params: SignalParams
): ScalperSignal | null {
  if (candles.length < Math.max(params.bbPeriod, params.rsiPeriod, params.emaPeriod) + 2) {
    logger.debug({ gateSymbol, count: candles.length }, "Not enough candles for signal evaluation");
    return null;
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const lastClose = closes[closes.length - 1];

  const bb = computeBB(closes, params.bbPeriod, params.bbStdDev);
  const rsi = computeRSI(closes, params.rsiPeriod);
  const volumeRatio = computeVolumeRatio(volumes);
  const ema = params.emaFilterEnabled ? computeEMA(closes, params.emaPeriod) : null;

  // ── Adaptive RSI thresholds ───────────────────────────────────────────────
  // When enabled, the oversold / overbought cutoffs are the rolling lowQ /
  // highQ percentiles of this symbol's RSI distribution over the last
  // `adaptiveWindow` bars. Quiet markets get tighter bounds; volatile markets
  // get wider bounds. Floors prevent the bounds from becoming so loose that
  // the strategy fires at neutral RSI in flat regimes.
  let rsiOversold = params.rsiOversold;
  let rsiOverbought = params.rsiOverbought;
  let qualityLong: number | undefined;
  let qualityShort: number | undefined;
  if (params.adaptiveThresholds) {
    const win = Math.max(20, params.adaptiveWindow ?? 100);
    const lowQ = params.adaptiveLowQ ?? 0.05;
    const highQ = params.adaptiveHighQ ?? 0.95;
    const lowFloor = params.adaptiveRsiLowFloor ?? 35;
    const highFloor = params.adaptiveRsiHighFloor ?? 65;
    const series = computeRSISeries(closes, params.rsiPeriod, win);
    if (series.length >= 20) {
      const aLow = quantile(series, lowQ, params.rsiOversold);
      const aHigh = quantile(series, highQ, params.rsiOverbought);
      // Clamp toward the configured floors so adaptive can never *loosen*
      // beyond a sane threshold (avoids firing at RSI 45 in a flat market).
      rsiOversold = Math.min(aLow, lowFloor);
      rsiOverbought = Math.max(aHigh, highFloor);
      // Quality = how far below/above the bound the current RSI sits, on a
      // 0..1 scale where 1 = at-or-beyond the historical min/max.
      const sMin = Math.min(...series);
      const sMax = Math.max(...series);
      qualityLong  = rsi <= rsiOversold ? Math.min(1, (rsiOversold - rsi) / Math.max(1, rsiOversold - sMin)) : 0;
      qualityShort = rsi >= rsiOverbought ? Math.min(1, (rsi - rsiOverbought) / Math.max(1, sMax - rsiOverbought)) : 0;
    }
  }

  // Volume is a confirmation metric displayed on the signal, but NOT a hard gate.
  // BB+RSI fires on price extremity + RSI confirmation alone — volume amplifies
  // signal quality but should never silence a genuine oversold/overbought setup,
  // especially during quiet-market hours when volume is structurally low.
  const hasVolumeSpike = volumeRatio >= params.volumeSpikeMultiplier;
  const symbol = gateSymbol.replace("_", "");

  // LONG: price at/below lower BB AND RSI oversold — volume is informational only
  // EMA filter uses a 2% tolerance zone below EMA rather than strict price > EMA.
  // BB+RSI is a mean-reversion strategy — an oversold pullback will always temporarily
  // dip below EMA50. Requiring price > EMA blocks every valid setup. Instead, block
  // only when price is MORE THAN 2% below EMA (genuine downtrend), not a normal dip.
  const trendAllowsLong = !params.emaFilterEnabled || ema === null || lastClose > ema * 0.98;
  if (lastClose <= bb.lower && rsi <= rsiOversold && trendAllowsLong) {
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
      quality: qualityLong,
    };
  }

  // SHORT: price at/above upper BB AND RSI overbought — volume is informational only
  const trendAllowsShort = !params.emaFilterEnabled || ema === null || lastClose < ema;
  if (!params.longOnly && lastClose >= bb.upper && rsi >= rsiOverbought && trendAllowsShort) {
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
      quality: qualityShort,
    };
  }

  // Suppress unused-variable warning — hasVolumeSpike kept for future scoring use
  void hasVolumeSpike;

  return null;
}

// ── Full scan ───────────────────────────────────────────────────────────────

export async function scanForSignals(params: SignalParams): Promise<ScalperSignal[]> {
  let symbols: string[];
  if (params.symbols && params.symbols.length > 0) {
    symbols = params.symbols;
  } else {
    try {
      symbols = await getTopUsdtSymbols(5);
    } catch (err) {
      logger.error({ err }, "Scalper: failed to fetch top symbols");
      return [];
    }
  }

  const tf = params.timeframe ?? "5m";
  const candleCount = ({ "3m": 150, "5m": 150, "15m": 150, "1h": 100, "4h": 80, "1d": 60 } as Record<string, number>)[tf] ?? CANDLE_LIMIT;

  const results = await Promise.allSettled(
    symbols.map(async (gateSymbol) => {
      const candles = await fetchCandles(gateSymbol, tf, candleCount);
      const sig = evaluateSignal(gateSymbol, candles, params);
      return sig ? { ...sig, timeframe: tf } : null;
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
