/**
 * Scalper keep-alive sync loop — runs every 30s.
 *
 * Paper trades:
 *   - Polls live price to check TP/SL hit
 *   - Closes at the exact TP/SL price (not the polling price) for accurate P&L simulation
 *
 * Live trades:
 *   - Polls Gate.io price-triggered orders for TP/SL fills
 *   - On fill: cancels the OTHER order (TP fills → cancel SL, SL fills → cancel TP)
 *   - Fallback: if no order IDs exist (order placement failed), uses price-based check
 *
 * Both: updates compound balance after each close.
 */

import { db, scalperConfigTable, scalperTradesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getLivePrice, getPriceTriggeredOrder, cancelPriceTriggeredOrder, placeSpotOrder, placePriceTriggeredOrder, fmtForPair } from "./gateio";
import { logger } from "../lib/logger";

export let scalperLastSyncAt: Date | null = null;

async function updateScalperCompoundBalance(pnl: number): Promise<void> {
  try {
    const [config] = await db.select().from(scalperConfigTable).limit(1);
    if (!config || !config.compoundingEnabled || config.compoundBalance == null) return;

    const newBalance = Math.max(config.compoundBalance + pnl, config.positionSizeUsdt * 0.1);
    await db.update(scalperConfigTable)
      .set({ compoundBalance: parseFloat(newBalance.toFixed(4)), updatedAt: new Date() })
      .where(eq(scalperConfigTable.id, config.id));

    logger.info({ oldBalance: config.compoundBalance, pnl, newBalance }, "Scalper: compound balance updated");
  } catch (err) {
    logger.warn({ err }, "Scalper: failed to update compound balance");
  }
}

async function syncScalperTrade(trade: typeof scalperTradesTable.$inferSelect): Promise<void> {
  const { id, gateSymbol, side, entryPrice, quantity, paperMode } = trade;

  // ── Paper trade ──────────────────────────────────────────────────────────
  if (paperMode) {
    let livePrice: number;
    try {
      livePrice = await getLivePrice(gateSymbol);
    } catch (err) {
      logger.warn({ tradeId: id, err }, "Scalper sync: failed to fetch live price for paper trade");
      return;
    }

    let closeReason: "tp" | "sl" | null = null;
    if (trade.tpPrice != null) {
      const tpHit = side === "buy" ? livePrice >= trade.tpPrice : livePrice <= trade.tpPrice;
      if (tpHit) closeReason = "tp";
    }
    if (!closeReason && trade.slPrice != null) {
      const slHit = side === "buy" ? livePrice <= trade.slPrice : livePrice >= trade.slPrice;
      if (slHit) closeReason = "sl";
    }

    if (closeReason) {
      // Close at the exact TP/SL level — not the polling price — for accurate P&L simulation
      const closePrice = closeReason === "tp"
        ? (trade.tpPrice ?? livePrice)
        : (trade.slPrice ?? livePrice);

      const closedPnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? closePrice - entryPrice : entryPrice - closePrice) * quantity
          : null;

      await db.update(scalperTradesTable).set({
        status: "closed",
        livePrice,
        closePrice,
        closeReason,
        pnl: closedPnl != null ? parseFloat(closedPnl.toFixed(4)) : null,
        closedAt: new Date(),
      }).where(eq(scalperTradesTable.id, id));

      logger.info({ tradeId: id, closeReason, closePrice, livePrice, pnl: closedPnl }, "Scalper: paper trade auto-closed");
      if (closedPnl != null) await updateScalperCompoundBalance(closedPnl);
    } else {
      const unrealizedPnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
          : null;
      await db.update(scalperTradesTable)
        .set({ livePrice, pnl: unrealizedPnl != null ? parseFloat(unrealizedPnl.toFixed(4)) : null })
        .where(eq(scalperTradesTable.id, id));
    }
    return;
  }

  // ── Live trade — poll Gate.io price-triggered orders ─────────────────────
  const orderChecks: { orderId: number; reason: "tp" | "sl" }[] = [];
  if (trade.tpOrderId) orderChecks.push({ orderId: Number(trade.tpOrderId), reason: "tp" });
  if (trade.slOrderId) orderChecks.push({ orderId: Number(trade.slOrderId), reason: "sl" });

  // Tracks whether every checked order has reached a terminal non-fill state.
  // If true after the loop, we fall through to the price-based fallback.
  let allOrdersTerminal = orderChecks.length > 0;

  for (const { orderId, reason } of orderChecks) {
    try {
      const order = await getPriceTriggeredOrder(orderId, gateSymbol);

      if (order.status === "finish") {
        const filledQty = parseFloat(order.put.amount) - parseFloat(order.put.left || "0");

        if (filledQty <= 0) {
          // Trigger fired but the underlying limit order didn't fill (price gapped through limit).
          // Treat as terminal — fall through to price-based fallback below.
          logger.warn(
            { tradeId: id, orderId, reason },
            "Scalper: price-triggered order fired but underlying order unfilled (price gap) — using price fallback"
          );
          continue; // stays allOrdersTerminal=true
        }

        // Order successfully filled — close the DB trade
        const closePrice = parseFloat(order.put.avg_deal_price || order.put.price);
        const pnl =
          entryPrice != null && filledQty > 0
            ? (side === "buy" ? closePrice - entryPrice : entryPrice - closePrice) * filledQty
            : null;

        await db.update(scalperTradesTable).set({
          status: "closed",
          closePrice,
          closeReason: reason,
          pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
          closedAt: new Date(),
        }).where(eq(scalperTradesTable.id, id));

        logger.info({ tradeId: id, reason, closePrice, filledQty, pnl }, "Scalper: live trade closed via order fill");
        if (pnl != null) await updateScalperCompoundBalance(pnl);

        // Cancel the companion order to prevent a dangling TP/SL on Gate.io
        const otherOrderId = reason === "tp" ? trade.slOrderId : trade.tpOrderId;
        if (otherOrderId) {
          try {
            await cancelPriceTriggeredOrder(Number(otherOrderId), gateSymbol);
            logger.info({ tradeId: id, cancelledOrderId: otherOrderId }, "Scalper: cancelled companion order");
          } catch (cancelErr) {
            logger.warn({ tradeId: id, otherOrderId, cancelErr }, "Scalper: failed to cancel companion order (may already be gone)");
          }
        }

        return;
      }

      if (order.status === "open") {
        // Still waiting for trigger price — not terminal
        allOrdersTerminal = false;
      }

      if (order.status === "cancelled" || order.status === "expired" || order.status === "failed") {
        // Order ended without filling — stays allOrdersTerminal=true, will run price fallback
        logger.warn({ tradeId: id, orderId, reason, status: order.status }, "Scalper: price-triggered order terminated without fill");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "order not found" means Gate.io has purged the order — it's definitively gone (filled,
      // cancelled, or expired). Treat as terminal so the price-based fallback can close the trade.
      if (msg.includes("order not found")) {
        logger.warn({ tradeId: id, orderId, reason }, "Scalper sync: order not found on Gate.io — treating as terminal");
        // allOrdersTerminal stays true — price fallback will run after the loop
      } else {
        // Transient network error — be conservative, keep the position alive
        allOrdersTerminal = false;
        logger.warn({ tradeId: id, orderId, err: msg }, "Scalper sync: failed to check price-triggered order");
      }
    }
  }

  // ── TP/SL retry — placement failed at entry for one or both orders ───────
  // Attempt to re-place whichever orders are missing on Gate.io so the position is protected.
  // This runs every sync cycle until both orders succeed or the trade closes.
  if ((!trade.tpOrderId || !trade.slOrderId) && trade.tpPrice != null && trade.slPrice != null && quantity != null) {
    logger.warn({ tradeId: id }, "Scalper sync: no TP/SL order IDs — retrying placement");
    const retryUpdates: Record<string, unknown> = {};
    const retryErrors: string[] = [];

    if (!trade.tpOrderId) {
      try {
        const tpFmt = await fmtForPair(gateSymbol, trade.tpPrice, quantity);
        const tpOrder = await placePriceTriggeredOrder({
          currencyPair: gateSymbol,
          triggerPrice: tpFmt.price,
          triggerRule: side === "buy" ? ">=" : "<=",
          side: side === "buy" ? "sell" : "buy",
          amount: tpFmt.amount,
          orderPrice: tpFmt.price,
        });
        retryUpdates.tpOrderId = tpOrder.id.toString();
        logger.info({ tradeId: id, tpOrderId: tpOrder.id, triggerPrice: tpFmt.price }, "Scalper sync: TP order retry succeeded");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        retryErrors.push(`TP retry: ${msg}`);
        logger.warn({ tradeId: id, err: msg }, "Scalper sync: TP retry failed");
      }
    }

    if (!trade.slOrderId) {
      try {
        const slFmt = await fmtForPair(gateSymbol, trade.slPrice, quantity);
        const slOrder = await placePriceTriggeredOrder({
          currencyPair: gateSymbol,
          triggerPrice: slFmt.price,
          triggerRule: side === "buy" ? "<=" : ">=",
          side: side === "buy" ? "sell" : "buy",
          amount: slFmt.amount,
          orderPrice: "0",
          orderType: "market",
        });
        retryUpdates.slOrderId = slOrder.id.toString();
        logger.info({ tradeId: id, slOrderId: slOrder.id, triggerPrice: slFmt.price }, "Scalper sync: SL order retry succeeded");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        retryErrors.push(`SL retry: ${msg}`);
        logger.warn({ tradeId: id, err: msg }, "Scalper sync: SL retry failed");
      }
    }

    if (Object.keys(retryUpdates).length > 0) {
      await db.update(scalperTradesTable).set(retryUpdates).where(eq(scalperTradesTable.id, id));
    }
    if (retryErrors.length > 0) {
      await db.update(scalperTradesTable).set({ errorMessage: retryErrors.join(" | ") }).where(eq(scalperTradesTable.id, id));
    }
  }

  // ── Price-based fallback ──────────────────────────────────────────────────
  // Runs when:
  //   (a) No TP/SL order IDs were ever stored (placement failed at entry AND retry also failed), OR
  //   (b) All checked orders reached terminal non-fill states (cancelled/expired/failed/unfilled limit)
  // IMPORTANT: for live trades this ALSO places a real market exit on Gate.io before closing the DB.
  const shouldFallback =
    (orderChecks.length === 0 || allOrdersTerminal) &&
    trade.tpPrice != null && trade.slPrice != null;

  if (shouldFallback) {
    try {
      const livePrice = await getLivePrice(gateSymbol);
      const tpHit = side === "buy" ? livePrice >= trade.tpPrice! : livePrice <= trade.tpPrice!;
      const slHit = side === "buy" ? livePrice <= trade.slPrice! : livePrice >= trade.slPrice!;
      const closeReason: "tp" | "sl" | null = tpHit ? "tp" : slHit ? "sl" : null;

      if (closeReason) {
        let actualClosePrice = closeReason === "tp" ? trade.tpPrice! : trade.slPrice!;

        // Cancel any surviving TP/SL orders to avoid dangling fills
        for (const oid of [trade.tpOrderId, trade.slOrderId].filter(Boolean) as string[]) {
          try { await cancelPriceTriggeredOrder(parseInt(oid), gateSymbol); } catch { /* already gone */ }
        }

        // Place a real market exit on Gate.io — the DB record alone closing is not enough
        if (quantity != null && quantity > 0) {
          const exitSide = side === "buy" ? "sell" : "buy";
          try {
            // Use pair-aware precision for the exit amount (e.g. amount_precision=0 pairs need integers)
            const exitFmt = await fmtForPair(gateSymbol, livePrice, quantity);
            const exitOrder = await placeSpotOrder({
              currencyPair: gateSymbol,
              side: exitSide,
              amount: exitFmt.amount,
              type: "market",
            });
            actualClosePrice = parseFloat(exitOrder.avg_deal_price || livePrice.toString());
            logger.info({ tradeId: id, exitSide, actualClosePrice, closeReason }, "Scalper: fallback market exit placed on Gate.io");
          } catch (exitErr) {
            logger.error({ tradeId: id, exitErr }, "Scalper: fallback market exit FAILED — position may still be open on Gate.io");
          }
        }

        const pnl =
          entryPrice != null && quantity != null
            ? (side === "buy" ? actualClosePrice - entryPrice : entryPrice - actualClosePrice) * quantity
            : null;

        await db.update(scalperTradesTable).set({
          status: "closed",
          livePrice,
          closePrice: actualClosePrice,
          closeReason,
          pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
          closedAt: new Date(),
        }).where(eq(scalperTradesTable.id, id));

        logger.warn(
          { tradeId: id, closeReason, closePrice: actualClosePrice, allOrdersTerminal },
          "Scalper: live trade closed via price fallback"
        );
        if (pnl != null) await updateScalperCompoundBalance(pnl);
        return;
      }

      // Trade still within TP/SL range — update live P&L only
      const pnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
          : null;
      await db.update(scalperTradesTable)
        .set({ livePrice, pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null })
        .where(eq(scalperTradesTable.id, id));
    } catch {
      // Non-critical
    }
    return;
  }

  // ── Update live P&L — orders are still active (waiting to trigger) ────────
  try {
    const livePrice = await getLivePrice(gateSymbol);
    const pnl =
      entryPrice != null && quantity != null
        ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
        : null;
    await db.update(scalperTradesTable)
      .set({ livePrice, pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null })
      .where(eq(scalperTradesTable.id, id));
  } catch {
    // Non-critical
  }
}

export async function syncAllScalperTrades(): Promise<void> {
  const openTrades = await db
    .select()
    .from(scalperTradesTable)
    .where(inArray(scalperTradesTable.status, ["open", "paper"]));

  if (openTrades.length === 0) {
    scalperLastSyncAt = new Date();
    return;
  }

  logger.debug({ count: openTrades.length }, "Scalper sync: checking open trades");
  await Promise.allSettled(openTrades.map(syncScalperTrade));
  scalperLastSyncAt = new Date();
}

let scalperSyncInterval: ReturnType<typeof setInterval> | null = null;

export function startScalperSyncLoop(intervalMs = 30_000): void {
  if (scalperSyncInterval) return;

  setTimeout(() => {
    syncAllScalperTrades().catch((err) => logger.error({ err }, "Scalper sync: initial run failed"));
  }, 5000);

  scalperSyncInterval = setInterval(() => {
    syncAllScalperTrades().catch((err) => logger.error({ err }, "Scalper sync: interval failed"));
  }, intervalMs);

  logger.info({ intervalMs }, "Scalper sync loop started");
}

export function stopScalperSyncLoop(): void {
  if (scalperSyncInterval) {
    clearInterval(scalperSyncInterval);
    scalperSyncInterval = null;
  }
}
