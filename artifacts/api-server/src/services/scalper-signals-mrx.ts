/**
 * MRX-Hybrid (Mean Reversion eXpress) Signal Engine
 *
 * Standalone mean-reversion strategy for quick oversold snaps on the Top 10
 * USDT spot pairs using 3-minute candles. LONG ONLY.
 *
 * Entry conditions (ALL must pass):
 *   1. lastClose ≤ BB_lower × 1.0005  AND  RSI ≤ 25  (or ≤ 28 with OB confluence)
 *   2. prevRSI ≤ 28 on prior bar (oversold streak)
 *   3. ATR% in [0.3%, 3.0%] — not dead calm, not blow-up volatility
 *   4. BB width in [0.6%, 5.0%] — adequate compression / no extreme expansion
 *   5. volumeRatio ≥ 1.2 (HARD gate — no dead-volume entries)
 *   6. 15m HTF: EMA20 not more than 1.5% below EMA50 (no hard downtrend)
 *   7. No-pump guard: last 2×3m price change ≥ −1.5% (no flash crash entry)
 *   8. OB confluence (1h): inside 1h demand zone → relax RSI cap to ≤ 28
 *   9. Slippage snapshot: signal records entryPrice for executor comparison
 *
 * Fixed risk params:
 *   TP = +0.28%  |  SL = −2.5%  |  Position size = 100% available USDT (live)
 *   Timeframe: 3m candles  |  Symbol universe: Top 10 by USDT volume
 *
 * Safeguards:
 *   - Dynamic symbol blacklist (DB-driven per close reason & P&L):
 *       SL hit → 60 min cooldown | WIN → 5 min | any close → 3 min re-entry guard
 *   - Rolling 20-trade WR monitor — auto-pause if WR < 70% AND trades ≥ 10
 *   - Full decision log for every symbol evaluated (all 9 filter values + reason)
 */

import { db, scalperTradesTable } from "@workspace/db";
import { eq, inArray, and, gte, desc } from "drizzle-orm";
import {
  Candle,
  ScalperSignal,
  computeEMA,
  computeBB,
  computeRSI,
  computeVolumeRatio,
  fetchCandles,
  getTopUsdtSymbols,
} from "./scalper-signals";
import { computeATR } from "./scalper-signals-cht";
import { logger } from "../lib/logger";

// ── Fixed MRX parameters ──────────────────────────────────────────────────────
export const MRX_TP_PCT       = 0.28;   // +0.28% take profit
export const MRX_SL_PCT       = 2.5;    // −2.5%  stop loss
export const MRX_STRATEGY_TAG = "mrx-hybrid";
const MRX_SYMBOL_COUNT        = 10;
const MRX_CANDLE_TF           = "3m";
const MRX_CANDLE_LIMIT        = 150;
const MRX_HTF_TF              = "15m";
const MRX_HTF_LIMIT           = 80;
const MRX_OB_TF               = "1h";
const MRX_OB_LIMIT            = 50;

// WR auto-pause thresholds
const MRX_WR_MIN_TRADES  = 10;
const MRX_WR_THRESHOLD   = 0.70;

// Stablecoins, wrapped tokens, and fiat-backed assets to exclude from MRX universe
const MRX_EXCLUDE_PATTERNS: RegExp[] = [
  /^(USDT|USDC|BUSD|DAI|TUSD|FDUSD|PYUSD|USDP|USDD|GUSD|SUSD|FRAX|LUSD)_USDT$/,
  /^(WBTC|WETH|WBNB|WMATIC|WSOL|WAVAX)_USDT$/,
  /^(STETH|WSTETH|RETH|CBETH|SFRXETH|BETH|ANKRETH)_USDT$/,
];

// ── MRX module state ─────────────────────────────────────────────────────────
let mrxAutoPaused = false;
let mrxLastWrCheck: { wr: number; count: number; at: Date } | null = null;

export function getMrxStatus(): {
  paused: boolean;
  winRate: number | null;
  tradeCount: number;
  message: string | null;
} {
  return {
    paused: mrxAutoPaused,
    winRate: mrxLastWrCheck ? mrxLastWrCheck.wr : null,
    tradeCount: mrxLastWrCheck ? mrxLastWrCheck.count : 0,
    message: mrxAutoPaused
      ? `Auto-paused: rolling WR ${mrxLastWrCheck ? (mrxLastWrCheck.wr * 100).toFixed(1) : "?"}% < 70% over last ${mrxLastWrCheck?.count ?? 0} trades`
      : null,
  };
}

export function resumeMrx(): void {
  mrxAutoPaused = false;
  logger.info("MRX: manual resume — auto-pause cleared");
}

// ── Rolling WR monitor ────────────────────────────────────────────────────────
async function checkMrxWinRate(): Promise<void> {
  try {
    const recent = await db
      .select({ pnl: scalperTradesTable.pnl })
      .from(scalperTradesTable)
      .where(
        and(
          eq(scalperTradesTable.strategy, MRX_STRATEGY_TAG),
          inArray(scalperTradesTable.status, ["closed", "cancelled"]),
        ),
      )
      .orderBy(desc(scalperTradesTable.closedAt))
      .limit(20);

    const withPnl = recent.filter((t) => t.pnl != null);
    mrxLastWrCheck = { wr: 0, count: withPnl.length, at: new Date() };

    if (withPnl.length < MRX_WR_MIN_TRADES) return;

    const wins = withPnl.filter((t) => (t.pnl ?? 0) > 0).length;
    const wr = wins / withPnl.length;
    mrxLastWrCheck = { wr, count: withPnl.length, at: new Date() };

    if (wr < MRX_WR_THRESHOLD && !mrxAutoPaused) {
      mrxAutoPaused = true;
      logger.warn(
        { wr: (wr * 100).toFixed(1), count: withPnl.length },
        "MRX: auto-pause triggered — rolling WR below 70% threshold",
      );
    }
  } catch (err) {
    logger.error({ err }, "MRX: WR check failed");
  }
}

// ── Symbol blacklist (DB-driven per close reason / P&L) ──────────────────────
function isMrxSymbolBlacklisted(
  gateSymbol: string,
  recentClosed: Array<{
    gateSymbol: string;
    closeReason: string | null;
    pnl: number | null;
    closedAt: Date | null;
  }>,
  now: number,
): { blocked: boolean; reason: string } {
  const entries = recentClosed.filter((t) => t.gateSymbol === gateSymbol);

  for (const t of entries) {
    const closedAt = t.closedAt ? t.closedAt.getTime() : 0;
    const pnl = t.pnl ?? 0;
    const closeReason = t.closeReason ?? "";

    // SL hit: 60-min cooldown
    if (
      closeReason === "sl" ||
      closeReason === "stop_loss" ||
      (pnl < 0 && closeReason !== "manual")
    ) {
      const until = closedAt + 60 * 60_000;
      if (now < until) {
        const minsLeft = Math.ceil((until - now) / 60_000);
        return { blocked: true, reason: `SL cooldown — ${minsLeft}m remaining` };
      }
    }

    // WIN: 5-min cooldown
    if (pnl > 0) {
      const until = closedAt + 5 * 60_000;
      if (now < until) {
        const secsLeft = Math.ceil((until - now) / 1_000);
        return { blocked: true, reason: `WIN cooldown — ${secsLeft}s remaining` };
      }
    }

    // Any close: 3-min re-entry guard
    const until = closedAt + 3 * 60_000;
    if (now < until) {
      const secsLeft = Math.ceil((until - now) / 1_000);
      return { blocked: true, reason: `Re-entry guard — ${secsLeft}s remaining` };
    }
  }

  return { blocked: false, reason: "" };
}

// ── 1h OB confluence (simplified demand-zone detection) ─────────────────────
interface SwingPoint { index: number; price: number; }

function findLocalSwingLows(candles: Candle[], lookback = 2): SwingPoint[] {
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

/**
 * Returns true if the current price is inside an active 1h demand zone (OB).
 *
 * A bullish demand OB is a bearish 1h candle followed by ≥ 2 consecutive bullish
 * candles (impulse), with at least one subsequent swing low confirming structure.
 * When true, the MRX RSI cap relaxes from ≤ 25 to ≤ 28.
 */
function detectBullish1hOB(candles1h: Candle[], currentPrice: number): boolean {
  if (candles1h.length < 10) return false;

  const swingLows = findLocalSwingLows(candles1h, 2);
  const last = candles1h.length - 1;
  const searchStart = Math.max(0, last - 30);

  for (let i = last - 2; i >= searchStart; i--) {
    const c = candles1h[i];
    if (c.close >= c.open) continue;                // must be a bearish candle

    const n1 = candles1h[i + 1];
    const n2 = candles1h[i + 2];
    if (!n1 || !n2) continue;
    if (n1.close <= n1.open || n2.close <= n2.open) continue;  // need 2 bullish after

    const obLow  = Math.min(c.open, c.close);
    const obHigh = Math.max(c.open, c.close);
    if (currentPrice < obLow || currentPrice > obHigh) continue;

    // Confirm there is a swing low AFTER the OB (structure shift)
    const hasStructure = swingLows.some((sl) => sl.index > i && sl.index <= last);
    if (!hasStructure) continue;

    return true;
  }

  return false;
}

// ── Core signal evaluator ─────────────────────────────────────────────────────
export interface MRXDecision {
  accepted: boolean;
  reason: string;
  rsi: number;
  prevRsi: number;
  atrPct: number;
  bbWidthPct: number;
  volumeRatio: number;
  htfEma20: number;
  htfEma50: number;
  pumpChange5m: number;
  inOB: boolean;
  effectiveRsiCap: number;
  entryPrice: number;
  tpPrice: number;
  slPrice: number;
}

export function evaluateMRXSignal(
  gateSymbol: string,
  candles3m: Candle[],
  candles15m: Candle[],
  candles1h: Candle[],
): { signal: ScalperSignal | null; decision: MRXDecision } {
  const symbol = gateSymbol.replace("_USDT", "").replace(/_/g, "");

  const failEarly = (reason: string): { signal: null; decision: MRXDecision } => ({
    signal: null,
    decision: {
      accepted: false, reason,
      rsi: 0, prevRsi: 0, atrPct: 0, bbWidthPct: 0, volumeRatio: 0,
      htfEma20: 0, htfEma50: 0, pumpChange5m: 0, inOB: false,
      effectiveRsiCap: 25, entryPrice: 0, tpPrice: 0, slPrice: 0,
    },
  });

  if (candles3m.length < 30) return failEarly("Insufficient 3m candles");

  const closes3m  = candles3m.map((c) => c.close);
  const volumes3m = candles3m.map((c) => c.volume);
  const lastClose = closes3m[closes3m.length - 1];

  // ── Indicators ────────────────────────────────────────────────────────────
  const bb          = computeBB(closes3m, 20, 2.0);
  const rsi         = computeRSI(closes3m, 14);
  const prevRsi     = computeRSI(closes3m.slice(0, -1), 14);
  const volumeRatio = computeVolumeRatio(volumes3m);
  const atr         = computeATR(candles3m, 14);
  const atrPct      = lastClose > 0 ? (atr / lastClose) * 100 : 0;
  const bbWidthPct  = bb.mid > 0 ? ((bb.upper - bb.lower) / bb.mid) * 100 : 0;

  // HTF (15m) EMA
  const closes15m = candles15m.map((c) => c.close);
  const htfEma20  = closes15m.length >= 20 ? computeEMA(closes15m, 20) : lastClose;
  const htfEma50  = closes15m.length >= 50 ? computeEMA(closes15m, 50) : lastClose;

  // No-pump guard: last 2 × 3m bars ≈ 6 min
  const pumpRef      = closes3m.length >= 3 ? closes3m[closes3m.length - 3] : lastClose;
  const pumpChange5m = pumpRef > 0 ? ((lastClose - pumpRef) / pumpRef) * 100 : 0;

  // OB confluence (1h)
  const inOB = detectBullish1hOB(candles1h, lastClose);
  const effectiveRsiCap = inOB ? 28 : 25;

  const tpPrice = lastClose * (1 + MRX_TP_PCT / 100);
  const slPrice = lastClose * (1 - MRX_SL_PCT / 100);

  const base: Omit<MRXDecision, "accepted" | "reason"> = {
    rsi, prevRsi, atrPct, bbWidthPct, volumeRatio,
    htfEma20, htfEma50, pumpChange5m, inOB, effectiveRsiCap,
    entryPrice: lastClose, tpPrice, slPrice,
  };

  // ── Gate 1: BB lower touch + RSI oversold ────────────────────────────────
  if (!(lastClose <= bb.lower * 1.0005 && rsi <= effectiveRsiCap)) {
    return {
      signal: null,
      decision: {
        ...base, accepted: false,
        reason: `Gate 1: close ${lastClose.toFixed(6)} vs bbLower×1.0005 ${(bb.lower * 1.0005).toFixed(6)}; RSI ${rsi.toFixed(1)} vs cap ${effectiveRsiCap}`,
      },
    };
  }

  // ── Gate 2: prevRSI streak ≤ 28 ─────────────────────────────────────────
  if (!(prevRsi <= 28)) {
    return {
      signal: null,
      decision: {
        ...base, accepted: false,
        reason: `Gate 2: prevRSI ${prevRsi.toFixed(1)} > 28 — no oversold streak`,
      },
    };
  }

  // ── Gate 3: ATR% in [0.3%, 3.0%] ────────────────────────────────────────
  if (atrPct < 0.3 || atrPct > 3.0) {
    return {
      signal: null,
      decision: {
        ...base, accepted: false,
        reason: `Gate 3: ATR% ${atrPct.toFixed(3)} not in [0.3, 3.0]`,
      },
    };
  }

  // ── Gate 4: BB width in [0.6%, 5.0%] ────────────────────────────────────
  if (bbWidthPct < 0.6 || bbWidthPct > 5.0) {
    return {
      signal: null,
      decision: {
        ...base, accepted: false,
        reason: `Gate 4: BBWidth% ${bbWidthPct.toFixed(3)} not in [0.6, 5.0]`,
      },
    };
  }

  // ── Gate 5: volumeRatio ≥ 1.2 (HARD gate) ───────────────────────────────
  if (volumeRatio < 1.2) {
    return {
      signal: null,
      decision: {
        ...base, accepted: false,
        reason: `Gate 5 (HARD): volumeRatio ${volumeRatio.toFixed(3)} < 1.2`,
      },
    };
  }

  // ── Gate 6: 15m HTF — EMA20 not >1.5% below EMA50 ──────────────────────
  if (closes15m.length >= 50 && htfEma20 < htfEma50 * (1 - 0.015)) {
    return {
      signal: null,
      decision: {
        ...base, accepted: false,
        reason: `Gate 6: 15m EMA20 ${htfEma20.toFixed(6)} >1.5% below EMA50 ${htfEma50.toFixed(6)} — hard downtrend`,
      },
    };
  }

  // ── Gate 7: No-pump guard ≥ −1.5% ───────────────────────────────────────
  if (pumpChange5m < -1.5) {
    return {
      signal: null,
      decision: {
        ...base, accepted: false,
        reason: `Gate 7: 5m change ${pumpChange5m.toFixed(2)}% < −1.5% — flash crash / dump in progress`,
      },
    };
  }

  // ── All gates passed ──────────────────────────────────────────────────────
  return {
    signal: {
      symbol,
      gateSymbol,
      side: "buy",
      entryPrice: lastClose,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      bbMid:   bb.mid,
      rsi,
      volumeRatio,
      tpPrice,
      slPrice,
      strategy:  MRX_STRATEGY_TAG,
      timeframe: "3m",
    },
    decision: {
      ...base, accepted: true,
      reason: `PASS — OB=${inOB ? `YES (RSI cap→${effectiveRsiCap})` : "NO"} ATR%=${atrPct.toFixed(2)} BBW%=${bbWidthPct.toFixed(2)} volR=${volumeRatio.toFixed(2)} 5mChg=${pumpChange5m.toFixed(2)}%`,
    },
  };
}

// ── Full MRX scan ─────────────────────────────────────────────────────────────
export async function scanForMRXSignals(params: {
  /** Override symbol list — skips top-10 fetch when provided. */
  symbols?: string[];
  /** Pre-fetched candle map keyed "GATE_SYMBOL:tf" — avoids duplicate API calls. */
  candleCache?: Map<string, Candle[]>;
}): Promise<ScalperSignal[]> {
  // ── Rolling WR check before each cycle ────────────────────────────────────
  await checkMrxWinRate();
  if (mrxAutoPaused) {
    logger.warn("MRX: scanner auto-paused — skipping cycle (POST /api/scalper/mrx/resume to re-enable)");
    return [];
  }

  // ── Resolve symbol universe ───────────────────────────────────────────────
  let symbols: string[];
  if (params.symbols && params.symbols.length > 0) {
    symbols = params.symbols;
  } else {
    try {
      const raw = await getTopUsdtSymbols(MRX_SYMBOL_COUNT);
      symbols = raw.filter((s) => !MRX_EXCLUDE_PATTERNS.some((p) => p.test(s)));
    } catch (err) {
      logger.error({ err }, "MRX: failed to fetch top symbols");
      return [];
    }
  }

  // ── Symbol blacklist (DB-driven — 60 min lookback) ───────────────────────
  const cutoff = new Date(Date.now() - 60 * 60_000);
  let recentClosed: Array<{
    gateSymbol: string;
    closeReason: string | null;
    pnl: number | null;
    closedAt: Date | null;
  }> = [];
  try {
    recentClosed = await db
      .select({
        gateSymbol:  scalperTradesTable.gateSymbol,
        closeReason: scalperTradesTable.closeReason,
        pnl:         scalperTradesTable.pnl,
        closedAt:    scalperTradesTable.closedAt,
      })
      .from(scalperTradesTable)
      .where(
        and(
          eq(scalperTradesTable.strategy, MRX_STRATEGY_TAG),
          inArray(scalperTradesTable.status, ["closed", "cancelled"]),
          gte(scalperTradesTable.closedAt, cutoff),
        ),
      );
  } catch (err) {
    logger.warn({ err }, "MRX: could not load blacklist from DB — proceeding without cooldowns");
  }

  const now = Date.now();

  // ── Per-symbol evaluation ─────────────────────────────────────────────────
  const results = await Promise.allSettled(
    symbols.map(async (gateSymbol): Promise<ScalperSignal | null> => {
      // Blacklist check
      const bl = isMrxSymbolBlacklisted(gateSymbol, recentClosed, now);
      if (bl.blocked) {
        logger.debug({ gateSymbol, reason: bl.reason }, "MRX: symbol blacklisted — skipping");
        return null;
      }

      // Candle fetch — reuse cache if provided
      const get = async (tf: string, limit: number): Promise<Candle[]> => {
        const key = `${gateSymbol}:${tf}`;
        const cached = params.candleCache?.get(key);
        if (cached) return cached;
        return fetchCandles(gateSymbol, tf, limit);
      };

      const [candles3m, candles15m, candles1h] = await Promise.all([
        get(MRX_CANDLE_TF, MRX_CANDLE_LIMIT),
        get(MRX_HTF_TF, MRX_HTF_LIMIT),
        get(MRX_OB_TF, MRX_OB_LIMIT),
      ]);

      const { signal, decision } = evaluateMRXSignal(gateSymbol, candles3m, candles15m, candles1h);

      if (decision.accepted) {
        logger.info(
          {
            gateSymbol,
            rsi: decision.rsi.toFixed(1),
            prevRsi: decision.prevRsi.toFixed(1),
            atrPct: decision.atrPct.toFixed(3),
            bbWidthPct: decision.bbWidthPct.toFixed(3),
            volumeRatio: decision.volumeRatio.toFixed(3),
            pumpChange5m: decision.pumpChange5m.toFixed(2),
            inOB: decision.inOB,
            effectiveRsiCap: decision.effectiveRsiCap,
            entry: decision.entryPrice,
            tp: decision.tpPrice.toFixed(6),
            sl: decision.slPrice.toFixed(6),
          },
          `MRX SIGNAL ACCEPTED: ${gateSymbol} — ${decision.reason}`,
        );
      } else {
        logger.debug({ gateSymbol, reason: decision.reason }, "MRX: signal rejected");
      }

      return signal;
    }),
  );

  const signals: ScalperSignal[] = [];
  for (const r of results) {
    if (r.status === "fulfilled" && r.value != null) signals.push(r.value);
    else if (r.status === "rejected") logger.warn({ err: r.reason }, "MRX: scan error for symbol");
  }

  return signals;
}
