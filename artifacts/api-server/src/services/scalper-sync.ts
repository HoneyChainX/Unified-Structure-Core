/**
 * Scalper keep-alive sync loop — runs every 30s.
 * For paper trades: checks TP/SL hit via live price.
 * For live trades: polls Gate.io price-triggered orders for fills.
 * Updates compound balance after each close.
 */

import { db, scalperConfigTable, scalperTradesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getLivePrice, getPriceTriggeredOrder } from "./gateio";
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

  if (paperMode) {
    try {
      const livePrice = await getLivePrice(gateSymbol);
      const unrealizedPnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
          : null;

      let closeReason: string | null = null;
      if (trade.tpPrice != null) {
        const tpHit = side === "buy" ? livePrice >= trade.tpPrice : livePrice <= trade.tpPrice;
        if (tpHit) closeReason = "tp";
      }
      if (!closeReason && trade.slPrice != null) {
        const slHit = side === "buy" ? livePrice <= trade.slPrice : livePrice >= trade.slPrice;
        if (slHit) closeReason = "sl";
      }

      if (closeReason) {
        const closedPnl =
          entryPrice != null && quantity != null
            ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
            : null;
        await db.update(scalperTradesTable).set({
          status: "closed",
          livePrice,
          closePrice: livePrice,
          closeReason,
          pnl: closedPnl,
          closedAt: new Date(),
        }).where(eq(scalperTradesTable.id, id));
        logger.info({ tradeId: id, closeReason, livePrice, pnl: closedPnl }, "Scalper: paper trade auto-closed");
        if (closedPnl != null) await updateScalperCompoundBalance(closedPnl);
      } else {
        await db.update(scalperTradesTable)
          .set({ livePrice, pnl: unrealizedPnl })
          .where(eq(scalperTradesTable.id, id));
      }
    } catch (err) {
      logger.warn({ tradeId: id, err }, "Scalper sync: failed to fetch live price for paper trade");
    }
    return;
  }

  // Live: check TP / SL price-triggered orders
  const orderChecks: { orderId: number; reason: string }[] = [];
  if (trade.tpOrderId) orderChecks.push({ orderId: Number(trade.tpOrderId), reason: "tp" });
  if (trade.slOrderId) orderChecks.push({ orderId: Number(trade.slOrderId), reason: "sl" });

  for (const { orderId, reason } of orderChecks) {
    try {
      const order = await getPriceTriggeredOrder(orderId, gateSymbol);
      if (order.status === "finish") {
        const closePrice = parseFloat(order.put.avg_deal_price || order.put.price);
        const closedQty = parseFloat(order.put.amount) - parseFloat(order.put.left || "0");
        const pnl =
          entryPrice != null && closedQty > 0
            ? (side === "buy" ? closePrice - entryPrice : entryPrice - closePrice) * closedQty
            : null;

        await db.update(scalperTradesTable).set({
          status: "closed",
          closePrice,
          closeReason: reason,
          pnl,
          closedAt: new Date(),
        }).where(eq(scalperTradesTable.id, id));

        logger.info({ tradeId: id, reason, closePrice, pnl }, "Scalper: live trade closed via order fill");
        if (pnl != null) await updateScalperCompoundBalance(pnl);
        return;
      }
    } catch (err) {
      logger.warn({ tradeId: id, orderId, err }, "Scalper sync: failed to check price-triggered order");
    }
  }

  // Update live P&L
  try {
    const livePrice = await getLivePrice(gateSymbol);
    const pnl =
      entryPrice != null && quantity != null
        ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
        : null;
    await db.update(scalperTradesTable).set({ livePrice, pnl }).where(eq(scalperTradesTable.id, id));
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
