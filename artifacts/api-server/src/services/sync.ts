import { db, tradesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getLivePrice, getSpotOrder } from "./gateio";
import { logger } from "../lib/logger";

export let lastSyncAt: Date | null = null;

async function syncOpenTrade(trade: typeof tradesTable.$inferSelect): Promise<void> {
  const { id, gateSymbol, side, entryPrice, quantity, paperMode } = trade;

  if (paperMode) {
    // For paper trades: fetch live price and compute unrealized PnL
    try {
      const livePrice = await getLivePrice(gateSymbol);
      const pnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
          : null;

      await db.update(tradesTable)
        .set({ livePrice, pnl })
        .where(eq(tradesTable.id, id));
    } catch (err) {
      logger.warn({ tradeId: id, err }, "Sync: failed to fetch live price for paper trade");
    }
    return;
  }

  // For live trades: check each SL/TP order to detect fills
  const orderChecks: { orderId: string; reason: string }[] = [];

  if (trade.slOrderId) orderChecks.push({ orderId: trade.slOrderId, reason: "sl" });
  if (trade.tp1OrderId) orderChecks.push({ orderId: trade.tp1OrderId, reason: "tp1" });
  if (trade.tp2OrderId) orderChecks.push({ orderId: trade.tp2OrderId, reason: "tp2" });
  if (trade.tp3OrderId) orderChecks.push({ orderId: trade.tp3OrderId, reason: "tp3" });

  for (const { orderId, reason } of orderChecks) {
    try {
      const order = await getSpotOrder(orderId, gateSymbol);
      if (order.status === "closed" || order.status === "cancelled") {
        const closePrice = parseFloat(order.avg_deal_price || order.price);
        const closedQty = parseFloat(order.filled_amount || order.amount);
        const pnl =
          entryPrice != null && closedQty > 0
            ? (side === "buy" ? closePrice - entryPrice : entryPrice - closePrice) * closedQty
            : null;

        await db.update(tradesTable).set({
          status: "closed",
          closePrice,
          closeReason: reason,
          pnl,
          closedAt: new Date(),
        }).where(eq(tradesTable.id, id));

        logger.info({ tradeId: id, reason, closePrice, pnl }, "Trade closed via order fill");
        return;
      }
    } catch (err) {
      logger.warn({ tradeId: id, orderId, err }, "Sync: failed to check order status");
    }
  }

  // Also track current live price for unrealized PnL on open live trades
  try {
    const livePrice = await getLivePrice(gateSymbol);
    const pnl =
      entryPrice != null && quantity != null
        ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
        : null;
    await db.update(tradesTable).set({ livePrice, pnl }).where(eq(tradesTable.id, id));
  } catch {
    // Non-critical
  }
}

export async function syncAllOpenTrades(): Promise<void> {
  const openTrades = await db
    .select()
    .from(tradesTable)
    .where(inArray(tradesTable.status, ["open", "paper"]));

  if (openTrades.length === 0) {
    lastSyncAt = new Date();
    return;
  }

  logger.debug({ count: openTrades.length }, "Sync: checking open trades");

  await Promise.allSettled(openTrades.map(syncOpenTrade));
  lastSyncAt = new Date();
}

let syncInterval: ReturnType<typeof setInterval> | null = null;

export function startSyncLoop(intervalMs = 30_000): void {
  if (syncInterval) return;

  // First sync after 5s startup delay
  setTimeout(() => {
    syncAllOpenTrades().catch((err) => logger.error({ err }, "Sync: initial run failed"));
  }, 5000);

  syncInterval = setInterval(() => {
    syncAllOpenTrades().catch((err) => logger.error({ err }, "Sync: interval run failed"));
  }, intervalMs);

  logger.info({ intervalMs }, "Trade sync loop started");
}

export function stopSyncLoop(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}
