import { db, tradesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getLivePrice, getSpotOrder, getPriceTriggeredOrder } from "./gateio";
import { logger } from "../lib/logger";
import { notifyTradeClosed } from "./notify";

export let lastSyncAt: Date | null = null;

async function syncOpenTrade(trade: typeof tradesTable.$inferSelect): Promise<void> {
  const { id, gateSymbol, side, entryPrice, quantity, paperMode } = trade;

  if (paperMode) {
    // For paper trades: fetch live price, compute unrealized P&L, and simulate SL/TP hits
    try {
      const livePrice = await getLivePrice(gateSymbol);
      const pnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
          : null;

      // Auto-close paper trade when SL or TP levels are hit
      let closeReason: string | null = null;
      if (trade.slPrice != null) {
        const slHit = side === "buy" ? livePrice <= trade.slPrice : livePrice >= trade.slPrice;
        if (slHit) closeReason = "sl";
      }
      if (!closeReason && trade.tp1Price != null) {
        const tp1Hit = side === "buy" ? livePrice >= trade.tp1Price : livePrice <= trade.tp1Price;
        if (tp1Hit) closeReason = "tp1";
      }
      if (!closeReason && trade.tp2Price != null) {
        const tp2Hit = side === "buy" ? livePrice >= trade.tp2Price : livePrice <= trade.tp2Price;
        if (tp2Hit) closeReason = "tp2";
      }
      if (!closeReason && trade.tp3Price != null) {
        const tp3Hit = side === "buy" ? livePrice >= trade.tp3Price : livePrice <= trade.tp3Price;
        if (tp3Hit) closeReason = "tp3";
      }

      if (closeReason) {
        const closedPnl =
          entryPrice != null && quantity != null
            ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
            : null;
        await db.update(tradesTable).set({
          status: "closed",
          livePrice,
          closePrice: livePrice,
          closeReason,
          pnl: closedPnl,
          closedAt: new Date(),
        }).where(eq(tradesTable.id, id));
        logger.info({ tradeId: id, closeReason, livePrice, pnl: closedPnl }, "Paper trade auto-closed");
        notifyTradeClosed({
          symbol: trade.symbol,
          side: trade.side as "buy" | "sell",
          entryPrice: trade.entryPrice,
          closePrice: livePrice,
          pnl: closedPnl,
          closeReason,
          paperMode: true,
          positionSizeUsdt: trade.positionSizeUsdt,
        });
      } else {
        await db.update(tradesTable)
          .set({ livePrice, pnl })
          .where(eq(tradesTable.id, id));
      }
    } catch (err) {
      logger.warn({ tradeId: id, err }, "Sync: failed to fetch live price for paper trade");
    }
    return;
  }

  // For live trades: check each SL/TP price-triggered order to detect fills
  // These are price_orders (not spot orders), so we use getPriceTriggeredOrder()
  const orderChecks: { orderId: number; reason: string }[] = [];

  if (trade.slOrderId) orderChecks.push({ orderId: Number(trade.slOrderId), reason: "sl" });
  if (trade.tp1OrderId) orderChecks.push({ orderId: Number(trade.tp1OrderId), reason: "tp1" });
  if (trade.tp2OrderId) orderChecks.push({ orderId: Number(trade.tp2OrderId), reason: "tp2" });
  if (trade.tp3OrderId) orderChecks.push({ orderId: Number(trade.tp3OrderId), reason: "tp3" });

  for (const { orderId, reason } of orderChecks) {
    try {
      const order = await getPriceTriggeredOrder(orderId, gateSymbol);
      // "finish" means the triggered limit order was placed and fully filled
      if (order.status === "finish") {
        const closePrice = parseFloat(order.put.avg_deal_price || order.put.price);
        const closedQty = parseFloat(order.put.amount) - parseFloat(order.put.left || "0");
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

        logger.info({ tradeId: id, reason, closePrice, pnl }, "Trade closed via price-triggered order fill");
        notifyTradeClosed({
          symbol: trade.symbol,
          side: trade.side as "buy" | "sell",
          entryPrice: trade.entryPrice,
          closePrice,
          pnl,
          closeReason: reason,
          paperMode: false,
          positionSizeUsdt: trade.positionSizeUsdt,
        });
        return;
      }
    } catch (err) {
      logger.warn({ tradeId: id, orderId, err }, "Sync: failed to check price-triggered order status");
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
