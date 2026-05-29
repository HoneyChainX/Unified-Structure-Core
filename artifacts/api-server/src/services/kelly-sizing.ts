/**
 * Fractional-Kelly sizing helper.
 *
 * For each symbol we keep a small rolling window of closed trades and derive:
 *   p = win rate            (count of pnl > 0 / total)
 *   W = avg win  (USDT, > 0)
 *   L = avg loss (USDT, > 0)
 *   R = W / L                payoff ratio
 *   f_kelly = max(0, p − (1 − p) / R)
 *
 * Production multiplier:
 *   scale = clamp(f_kelly × safetyFraction, floorPct/100, maxPct/100)
 *
 * Safety:
 *   - Below `minTrades` closed trades, returns 1.0 (no effect) so we don't
 *     size by 5-sample noise.
 *   - If avg_loss is zero (only wins so far, lucky streak), returns
 *     maxPct/100 — bullish but capped.
 *   - Negative edge → falls back to floor, NOT zero. We still want to take
 *     trades, just at minimum size, so a bad-stretch sample doesn't lock
 *     out trading entirely.
 *   - All inputs clamped: safetyFraction ∈ [0,1], floor ≤ max.
 */
import { db, scalperTradesTable } from "@workspace/db";
import { and, eq, isNotNull, inArray, desc } from "drizzle-orm";

export interface KellyParams {
  enabled: boolean;
  lookbackTrades: number;
  minTrades: number;
  safetyFraction: number;
  floorPct: number;
  maxPct: number;
}

export interface KellyResult {
  /** Multiplier to apply to base position size: scale ∈ [floorPct/100, maxPct/100] when applied, else 1.0. */
  multiplier: number;
  /** Why this multiplier was chosen (for logging). */
  reason: "disabled" | "no_samples" | "all_wins" | "negative_edge" | "ok";
  trades: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  kellyFraction: number | null;
}

/** Pure-function form — testable in isolation. */
export function computeKellyMultiplier(
  closedPnls: number[],
  params: KellyParams,
): KellyResult {
  if (!params.enabled) {
    return { multiplier: 1.0, reason: "disabled", trades: closedPnls.length, winRate: null, avgWin: null, avgLoss: null, kellyFraction: null };
  }
  const safety  = clamp01(params.safetyFraction);
  const floor   = clamp01(params.floorPct / 100);
  const max     = clamp(params.maxPct / 100, floor, 1);
  const trades  = closedPnls.length;
  if (trades < params.minTrades) {
    return { multiplier: 1.0, reason: "no_samples", trades, winRate: null, avgWin: null, avgLoss: null, kellyFraction: null };
  }
  const wins   = closedPnls.filter((p) => p > 0);
  const losses = closedPnls.filter((p) => p < 0).map(Math.abs);
  const winRate = wins.length / trades;
  if (losses.length === 0) {
    return { multiplier: max, reason: "all_wins", trades, winRate, avgWin: avg(wins), avgLoss: 0, kellyFraction: 1 };
  }
  const avgWin  = avg(wins);
  const avgLoss = avg(losses);
  const R       = avgWin / avgLoss;
  const fKelly  = winRate - (1 - winRate) / R;
  if (fKelly <= 0) {
    return { multiplier: floor, reason: "negative_edge", trades, winRate, avgWin, avgLoss, kellyFraction: fKelly };
  }
  const scale = clamp(fKelly * safety, floor, max);
  return { multiplier: scale, reason: "ok", trades, winRate, avgWin, avgLoss, kellyFraction: fKelly };
}

/** Async wrapper — pulls closed P&L history for one symbol from the DB. */
export async function getKellyMultiplierForSymbol(gateSymbol: string, params: KellyParams): Promise<KellyResult> {
  if (!params.enabled) return computeKellyMultiplier([], params);
  const rows = await db
    .select({ pnl: scalperTradesTable.pnl })
    .from(scalperTradesTable)
    .where(and(
      eq(scalperTradesTable.gateSymbol, gateSymbol),
      inArray(scalperTradesTable.status, ["closed"]),
      isNotNull(scalperTradesTable.pnl),
    ))
    .orderBy(desc(scalperTradesTable.closedAt))
    .limit(params.lookbackTrades);
  const pnls = rows.map((r) => Number(r.pnl)).filter(Number.isFinite);
  return computeKellyMultiplier(pnls, params);
}

function avg(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); }
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
