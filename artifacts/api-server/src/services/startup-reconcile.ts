// A5+D5: startup reconciliation — read-only marking; no destructive actions.
// Runs once on boot, after DB + Gate clients are ready, before engines start.
// Marks DB rows whose Gate.io orders have vanished; never cancels live orders.

import { db, scalperTradesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { listActivePriceTriggeredOrders } from "./gateio";
import { logger } from "../lib/logger";

export async function runStartupReconcile(): Promise<void> {
  const startMs = Date.now();
  let checked = 0;
  let errored = 0;
  let warnings = 0;

  try {
    // 1. Fetch all open/pending scalper trades from DB
    const dbTrades = await db
      .select()
      .from(scalperTradesTable)
      .where(inArray(scalperTradesTable.status, ["pending", "open"]));

    if (dbTrades.length === 0) {
      logger.info({ durationMs: Date.now() - startMs }, "reconcile.summary — no open trades, nothing to check");
      return;
    }

    // 2. Fetch all live open price-triggered (SL/TP) orders from Gate.io
    let liveOrderIds: Set<string>;
    try {
      const liveOrders = await listActivePriceTriggeredOrders();
      liveOrderIds = new Set(liveOrders.map((o) => String(o.id)));
    } catch (gateErr) {
      logger.warn({ gateErr }, "reconcile: could not fetch live Gate.io orders — skipping reconcile");
      return;
    }

    // 3. For each DB trade, check if its protection orders still exist on Gate.io
    for (const trade of dbTrades) {
      checked++;

      // a) Pending trades were never confirmed open — mark as error (stuck pre-fill)
      if (trade.status === "pending") {
        logger.warn({ tradeId: trade.id, symbol: trade.gateSymbol }, "reconcile.orphan_pending — stuck pending at startup, marking error");
        await db.update(scalperTradesTable)
          .set({ status: "error", errorMessage: "reconcile: stuck pending at startup" })
          .where(eq(scalperTradesTable.id, trade.id));
        errored++;
        continue;
      }

      // b) Open live trade — check if any recorded Gate.io order IDs are still live
      const knownOrderIds = [
        trade.slOrderId,
        trade.tpOrderId,
        trade.tp1OrderId,
        trade.tp2OrderId,
        trade.tp3OrderId,
      ].filter((id): id is string => id != null);

      if (knownOrderIds.length === 0) {
        // No recorded order IDs — can't verify; log warn for operator
        logger.warn({ tradeId: trade.id, symbol: trade.gateSymbol }, "reconcile.missing_protection — open trade has no order IDs; leave for operator");
        warnings++;
        continue;
      }

      const allGone  = knownOrderIds.every((oid) => !liveOrderIds.has(oid));
      const someGone = !allGone && knownOrderIds.some((oid) => !liveOrderIds.has(oid));

      if (allGone) {
        // c) All protection orders gone from Gate.io — position is orphaned; mark error
        logger.warn({ tradeId: trade.id, symbol: trade.gateSymbol, knownOrderIds }, "reconcile.orphan_db_no_gate — all Gate.io orders missing, marking error");
        await db.update(scalperTradesTable)
          .set({ status: "error", errorMessage: "reconcile: all protection orders missing from Gate.io at startup" })
          .where(eq(scalperTradesTable.id, trade.id));
        errored++;
      } else if (someGone) {
        // Partial mismatch — some orders still live; log warn only, leave for operator
        const missingIds = knownOrderIds.filter((oid) => !liveOrderIds.has(oid));
        logger.warn({ tradeId: trade.id, symbol: trade.gateSymbol, missingIds }, "reconcile.missing_protection — some Gate.io orders gone; leaving for sync loop");
        warnings++;
      }
    }

    // 4. Orphan Gate.io orders (orders whose trade ID is not in DB) cannot be
    //    identified without a per-order lookup (price_order summary has no client tag).
    //    Log the live count for visibility only.
    logger.info({ liveOrderCount: liveOrderIds.size }, "reconcile: live Gate.io price_orders counted");

  } catch (err) {
    logger.error({ err }, "reconcile: unexpected error");
  }

  logger.info(
    { checked, errored, warnings, durationMs: Date.now() - startMs },
    "reconcile.summary",
  );
}
