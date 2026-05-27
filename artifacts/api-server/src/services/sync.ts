import { db, tradesTable, botConfigTable } from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { getLivePrice, getSpotOrder, getPriceTriggeredOrder } from "./gateio";
import { logger } from "../lib/logger";
import { notifyTradeClosed } from "./notify";
import { pnlFromFills } from "./fees";

export let lastSyncAt: Date | null = null;

/**
 * After a trade closes, update the compound balance if compounding is enabled.
 * compoundBalance = max(current + pnl, 10% of original positionSizeUsdt)
 */
async function updateCompoundBalance(pnl: number | null): Promise<void> {
  if (pnl == null || !Number.isFinite(pnl)) return;
  try {
    const [config] = await db.select().from(botConfigTable).limit(1);
    if (!config || !config.compoundingEnabled || config.compoundBalance == null) return;

    // Atomic increment: avoids read-modify-write race when two closes land
    // in the same tick. Floor at 10 % of original sizing so a drawdown
    // streak can't drive the compound balance to zero.
    const floor = config.positionSizeUsdt * 0.1;
    const result = await db.execute(sql`
      UPDATE ${botConfigTable}
      SET compound_balance = GREATEST(coalesce(compound_balance, 0) + ${pnl}, ${floor}),
          updated_at = now()
      WHERE id = ${config.id}
      RETURNING compound_balance
    `);
    const newBalance = (result.rows?.[0] as { compound_balance?: number } | undefined)?.compound_balance;
    logger.info(
      { oldBalance: config.compoundBalance, pnl, newBalance },
      "Compound balance updated after trade close"
    );
  } catch (err) {
    logger.warn({ err }, "Failed to update compound balance");
  }
}

async function syncOpenTrade(trade: typeof tradesTable.$inferSelect): Promise<void> {
  const { id, gateSymbol, side, entryPrice, quantity, paperMode } = trade;

  if (paperMode) {
    try {
      const livePrice = await getLivePrice(gateSymbol);
      const pnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
          : null;

      let closeReason: string | null = null;
      if (trade.slPrice != null) {
        const slHit = side === "buy" ? livePrice <= trade.slPrice : livePrice >= trade.slPrice;
        if (slHit) closeReason = "sl";
      }
      // tp1/tp2/tp3 — used by multi-TP strategies (CHT, Micro)
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
        const fillMath =
          entryPrice != null && quantity != null
            ? pnlFromFills({ side: side as "buy" | "sell", entryPrice, closePrice: livePrice, quantity })
            : null;
        const closedPnl = fillMath ? fillMath.net : null;
        await db.update(tradesTable).set({
          status: "closed",
          livePrice,
          closePrice: livePrice,
          closeReason,
          pnl: closedPnl,
          feesUsdt: fillMath?.fees ?? null,
          closedAt: new Date(),
        }).where(eq(tradesTable.id, id));
        logger.info({ tradeId: id, closeReason, livePrice, pnl: closedPnl, fees: fillMath?.fees }, "Paper trade auto-closed (fee-adjusted)");
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
        await updateCompoundBalance(closedPnl);
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

  const orderChecks: { orderId: string; reason: string }[] = [];

  if (trade.slOrderId) orderChecks.push({ orderId: trade.slOrderId, reason: "sl" });
  if (trade.tp1OrderId) orderChecks.push({ orderId: trade.tp1OrderId, reason: "tp1" });
  if (trade.tp2OrderId) orderChecks.push({ orderId: trade.tp2OrderId, reason: "tp2" });
  if (trade.tp3OrderId) orderChecks.push({ orderId: trade.tp3OrderId, reason: "tp3" });

  // A2: terminal order handling + poll timeout
  let terminalOrderCount = 0;

  for (const { orderId, reason } of orderChecks) {
    try {
      const order = await getPriceTriggeredOrder(orderId, gateSymbol);
      if (order.status === "finish") {
        const closePrice = parseFloat(order.put.avg_deal_price || order.put.price);
        const closedQty = parseFloat(order.put.amount) - parseFloat(order.put.left || "0");
        const fillMath =
          entryPrice != null && closedQty > 0
            ? pnlFromFills({ side: side as "buy" | "sell", entryPrice, closePrice, quantity: closedQty })
            : null;
        const pnl = fillMath ? fillMath.net : null;

        await db.update(tradesTable).set({
          status: "closed",
          closePrice,
          closeReason: reason,
          pnl,
          feesUsdt: fillMath?.fees ?? null,
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
        await updateCompoundBalance(pnl);
        return;
      }
      // A2: terminal statuses that will never fill — count them
      if (["cancelled", "expired", "failed"].includes(order.status)) {
        logger.warn({ tradeId: id, orderId, reason, status: order.status }, "tv_bot.order.terminal {tradeId, gateOrderId, reason}");
        terminalOrderCount++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A2: ORDER_NOT_FOUND means Gate.io has no record of this order — treat as terminal
      if (msg.includes("ORDER_NOT_FOUND") || msg.includes("order not found") || msg.includes("404")) {
        logger.warn({ tradeId: id, orderId, reason }, "tv_bot.order.terminal {tradeId, gateOrderId, reason}");
        terminalOrderCount++;
      } else {
        logger.warn({ tradeId: id, orderId, err }, "Sync: failed to check price-triggered order status");
      }
    }
  }

  // A2: if ALL known orders are terminal/not-found, no protection remains — cancel the trade
  if (orderChecks.length > 0 && terminalOrderCount >= orderChecks.length) {
    logger.warn({ tradeId: id, terminalOrderCount }, "tv_bot.order.terminal — all orders gone, marking cancelled");
    await db.update(tradesTable).set({
      status: "cancelled",
      closeReason: "order_not_found",
      closedAt: new Date(),
    }).where(eq(tradesTable.id, id));
    return;
  }

  // A2: poll timeout — trade open for > 30 min with no fills detected → mark error
  const tradeAgeMs = Date.now() - (trade.createdAt?.getTime() ?? 0);
  if (tradeAgeMs > 30 * 60 * 1000 && orderChecks.length > 0) {
    logger.warn({ tradeId: id, ageMs: tradeAgeMs }, "tv_bot.order.terminal — poll_timeout after 30 min with no fills");
    await db.update(tradesTable).set({
      status: "error",
      closeReason: "poll_timeout",
      closedAt: new Date(),
    }).where(eq(tradesTable.id, id));
    return;
  }

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
