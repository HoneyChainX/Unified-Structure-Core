/**
 * Combined-exposure tracker (BUG-13 fix from replit.md).
 *
 * The webhook bot (`trades` table) and the autonomous scalper (`scalper_trades`
 * table) share one Gate.io spot account, but each one previously read its own
 * `maxOpenTrades` cap independently. The true exposure is the SUM. This module
 * is the single read path both executors use before opening a new position.
 */

import { db, tradesTable, scalperTradesTable } from "@workspace/db";
import { inArray } from "drizzle-orm";

export interface CombinedExposure {
  /** Number of currently open or paper trades across BOTH systems. */
  openCount: number;
  /** Sum of `positionSizeUsdt` for those open trades. */
  notionalUsdt: number;
  /** Unique symbols with at least one open trade. */
  symbols: string[];
  /** Per-symbol open count (uppercase canonical, e.g. BTC_USDT). */
  bySymbol: Record<string, number>;
}

export async function getCombinedOpenExposure(): Promise<CombinedExposure> {
  const [webhookRows, scalperRows] = await Promise.all([
    db.select({
      gateSymbol: tradesTable.gateSymbol,
      positionSizeUsdt: tradesTable.positionSizeUsdt,
    })
      .from(tradesTable)
      .where(inArray(tradesTable.status, ["open", "paper"])),
    db.select({
      gateSymbol: scalperTradesTable.gateSymbol,
      positionSizeUsdt: scalperTradesTable.positionSizeUsdt,
    })
      .from(scalperTradesTable)
      .where(inArray(scalperTradesTable.status, ["open", "paper"])),
  ]);

  const all = [...webhookRows, ...scalperRows];
  const bySymbol: Record<string, number> = {};
  let notional = 0;

  for (const row of all) {
    const sym = (row.gateSymbol ?? "").toUpperCase();
    if (sym) bySymbol[sym] = (bySymbol[sym] ?? 0) + 1;
    const sz = Number(row.positionSizeUsdt ?? 0);
    if (Number.isFinite(sz) && sz > 0) notional += sz;
  }

  return {
    openCount: all.length,
    notionalUsdt: notional,
    symbols: Object.keys(bySymbol),
    bySymbol,
  };
}
