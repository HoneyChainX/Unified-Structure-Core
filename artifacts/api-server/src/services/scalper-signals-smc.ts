/**
 * SMC (Smart Money Concepts) signal engine — MSS + OB+ + Fib 4.236
 *
 * Strategy logic (bullish):
 *   1. Identify a swing low followed by a break of a prior swing high (Market Structure Shift)
 *   2. The Order Block = last bearish candle before the MSS impulse breakout
 *   3. Entry = price retraces into OB body AND the latest closed candle closes inside OB body
 *   4. TP  = swing_low + 4.236 × (swing_high − swing_low)  [Fib 4.236 extension]
 *   5. SL  = OB low − 0.1% buffer
 *
 * Bearish mirror: swing_high → MSS down → last bullish OB → retrace into OB → short.
 */

import { Candle, ScalperSignal } from "./scalper-signals";
import { logger } from "../lib/logger";
import { fetchCandles } from "./scalper-signals";

const SWING_LOOKBACK = 3;     // bars each side to confirm a swing point
const FIB_4236 = 4.236;
const SL_BUFFER = 0.001;      // 0.1% beyond OB edge for SL
const MAX_SETUP_AGE = 60;     // ignore OBs older than this many candles

// ── Swing-point detection ────────────────────────────────────────────────────

interface SwingPoint {
  index: number;
  price: number;
}

function findSwingHighs(candles: Candle[], lookback: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let ok = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ index: i, price: candles[i].high });
  }
  return out;
}

function findSwingLows(candles: Candle[], lookback: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let ok = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ index: i, price: candles[i].low });
  }
  return out;
}

// ── Setup interfaces ─────────────────────────────────────────────────────────

interface SMCSetup {
  type: "bullish" | "bearish";
  swingAnchor: number;   // swing low (bull) or swing high (bear) that anchors the Fib
  mssLevel: number;      // swing high (bull) or swing low (bear) that was broken
  ob: { open: number; close: number; high: number; low: number; index: number };
  fibTarget: number;
  slLevel: number;
}

// ── Bullish MSS finder ───────────────────────────────────────────────────────

function findBullishMSS(candles: Candle[]): SMCSetup | null {
  const swingHighs = findSwingHighs(candles, SWING_LOOKBACK);
  const swingLows  = findSwingLows(candles, SWING_LOOKBACK);
  const last = candles.length - 1;

  // Walk swing highs from most-recent to oldest
  for (let shi = swingHighs.length - 1; shi >= 0; shi--) {
    const sh = swingHighs[shi];

    // Find the nearest swing low BEFORE this swing high
    const prevLows = swingLows.filter((sl) => sl.index < sh.index);
    if (prevLows.length === 0) continue;
    const swingLow = prevLows[prevLows.length - 1];

    // Find the first candle after sh that closes ABOVE sh.price → MSS
    let mssIndex = -1;
    for (let i = sh.index + 1; i <= last - 1; i++) {   // must have at least 1 candle after MSS
      if (candles[i].close > sh.price) { mssIndex = i; break; }
    }
    if (mssIndex === -1) continue;

    // Find the last bearish candle in [swingLow.index+1 .. mssIndex-1] → OB
    let obIndex = -1;
    for (let i = mssIndex - 1; i > swingLow.index; i--) {
      if (candles[i].close < candles[i].open) { obIndex = i; break; }
    }
    if (obIndex === -1) continue;

    // Reject stale setups
    if (last - obIndex > MAX_SETUP_AGE) continue;

    const ob = candles[obIndex];
    const obBodyHigh = Math.max(ob.open, ob.close);  // bearish OB: open > close
    const obBodyLow  = Math.min(ob.open, ob.close);

    // Current close must be inside OB body (candle-close confirmation)
    const lastClose = candles[last].close;
    if (lastClose < obBodyLow || lastClose > obBodyHigh) continue;

    const fibTarget = swingLow.price + FIB_4236 * (sh.price - swingLow.price);
    const slLevel   = ob.low * (1 - SL_BUFFER);

    // Sanity: TP must be above entry, SL must be below entry
    if (fibTarget <= lastClose || slLevel >= lastClose) continue;

    logger.debug(
      { gateSymbol: "?", swingLow: swingLow.price, swingHigh: sh.price, obIndex, mssIndex, fibTarget, slLevel },
      "SMC: bullish MSS setup found"
    );

    return {
      type: "bullish",
      swingAnchor: swingLow.price,
      mssLevel: sh.price,
      ob: { open: ob.open, close: ob.close, high: ob.high, low: ob.low, index: obIndex },
      fibTarget,
      slLevel,
    };
  }

  return null;
}

// ── Bearish MSS finder ───────────────────────────────────────────────────────

function findBearishMSS(candles: Candle[]): SMCSetup | null {
  const swingHighs = findSwingHighs(candles, SWING_LOOKBACK);
  const swingLows  = findSwingLows(candles, SWING_LOOKBACK);
  const last = candles.length - 1;

  for (let sli = swingLows.length - 1; sli >= 0; sli--) {
    const sl = swingLows[sli];

    const prevHighs = swingHighs.filter((sh) => sh.index < sl.index);
    if (prevHighs.length === 0) continue;
    const swingHigh = prevHighs[prevHighs.length - 1];

    // First candle after sl that closes BELOW sl.price → bearish MSS
    let mssIndex = -1;
    for (let i = sl.index + 1; i <= last - 1; i++) {
      if (candles[i].close < sl.price) { mssIndex = i; break; }
    }
    if (mssIndex === -1) continue;

    // Last bullish candle in [swingHigh.index+1 .. mssIndex-1] → bearish OB
    let obIndex = -1;
    for (let i = mssIndex - 1; i > swingHigh.index; i--) {
      if (candles[i].close > candles[i].open) { obIndex = i; break; }
    }
    if (obIndex === -1) continue;

    if (last - obIndex > MAX_SETUP_AGE) continue;

    const ob = candles[obIndex];
    const obBodyHigh = Math.max(ob.open, ob.close);  // bullish OB: close > open
    const obBodyLow  = Math.min(ob.open, ob.close);

    const lastClose = candles[last].close;
    if (lastClose < obBodyLow || lastClose > obBodyHigh) continue;

    const fibTarget = swingHigh.price - FIB_4236 * (swingHigh.price - sl.price);
    const slLevel   = ob.high * (1 + SL_BUFFER);

    // Sanity: TP below entry, SL above entry
    if (fibTarget >= lastClose || slLevel <= lastClose) continue;

    return {
      type: "bearish",
      swingAnchor: swingHigh.price,
      mssLevel: sl.price,
      ob: { open: ob.open, close: ob.close, high: ob.high, low: ob.low, index: obIndex },
      fibTarget,
      slLevel,
    };
  }

  return null;
}

// ── Public evaluator ─────────────────────────────────────────────────────────

export function evaluateSMCSignal(
  gateSymbol: string,
  candles: Candle[],
  params: { longOnly: boolean }
): ScalperSignal | null {
  if (candles.length < SWING_LOOKBACK * 2 + 10) return null;

  const symbol    = gateSymbol.replace("_USDT", "").replace("_", "");
  const lastClose = candles[candles.length - 1].close;

  /**
   * Map an SMC setup's R:R into the shared [0,1] quality channel.
   *
   *   R:R ≤ 1.0  → 0.0     (rejected upstream, but defensive)
   *   R:R = 2.5  → 0.50
   *   R:R = 4.0  → 1.00    (Fib 4.236-driven targets routinely land here)
   *
   * Saturates at 1.0 so absurd R:R outliers don't dominate the ranker.
   */
  const smcQuality = (entry: number, tp: number, sl: number): number => {
    const reward = Math.abs(tp - entry);
    const risk = Math.abs(entry - sl);
    if (risk <= 0) return 0;
    const rr = reward / risk;
    return Math.min(1, Math.max(0, (rr - 1) / 3));
  };

  const bullish = findBullishMSS(candles);
  if (bullish) {
    return {
      symbol,
      gateSymbol,
      side: "buy",
      entryPrice: lastClose,
      tpPrice: bullish.fibTarget,
      slPrice: bullish.slLevel,
      // Repurpose BB fields to carry OB zone info for display
      bbUpper: bullish.ob.high,
      bbLower: bullish.ob.low,
      bbMid: bullish.mssLevel,
      rsi: 0,
      volumeRatio: 0,
      strategy: "smc_mss",
      quality: smcQuality(lastClose, bullish.fibTarget, bullish.slLevel),
    };
  }

  if (!params.longOnly) {
    const bearish = findBearishMSS(candles);
    if (bearish) {
      return {
        symbol,
        gateSymbol,
        side: "sell",
        entryPrice: lastClose,
        tpPrice: bearish.fibTarget,
        slPrice: bearish.slLevel,
        bbUpper: bearish.ob.high,
        bbLower: bearish.ob.low,
        bbMid: bearish.mssLevel,
        rsi: 0,
        volumeRatio: 0,
        strategy: "smc_mss",
        quality: smcQuality(lastClose, bearish.fibTarget, bearish.slLevel),
      };
    }
  }

  return null;
}

// ── Full SMC scan ─────────────────────────────────────────────────────────────

export async function scanForSMCSignals(params: {
  longOnly: boolean;
  symbols: string[];
  /** Timeframe for candle fetching (default "5m") */
  timeframe?: string;
}): Promise<ScalperSignal[]> {
  const tf = params.timeframe ?? "5m";
  const candleCount = ({ "3m": 150, "5m": 150, "15m": 150, "1h": 100, "4h": 80, "1d": 60 } as Record<string, number>)[tf] ?? 150;

  const results = await Promise.allSettled(
    params.symbols.map(async (gateSymbol) => {
      const candles = await fetchCandles(gateSymbol, tf, candleCount);
      const sig = evaluateSMCSignal(gateSymbol, candles, params);
      return sig ? { ...sig, timeframe: tf } : null;
    })
  );

  const signals: ScalperSignal[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value != null) {
      signals.push(result.value);
    } else if (result.status === "rejected") {
      logger.warn({ err: result.reason }, "SMC: scan error for symbol");
    }
  }

  return signals;
}
