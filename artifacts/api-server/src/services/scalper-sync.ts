/**
 * Scalper keep-alive sync loop — runs every 30s.
 *
 * Standard trades (BB+RSI / SMC):
 *   Paper: polls live price to check TP/SL hit.
 *   Live:  polls Gate.io price-triggered orders; on fill cancels the companion order.
 *
 * CHT trades (strategy === "cht" OR tp1Price != null):
 *   Paper: TP1 hit → move SL to break-even; TP2/TP3/SL hit → close trade.
 *   Live:  TP1 fill → cancel old SL, place new SL at entry (break-even).
 *          TP2/TP3/SL fill → close trade, cancel remaining orders.
 */

import { db, scalperConfigTable, scalperTradesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  getLivePrice,
  getPriceTriggeredOrder,
  cancelPriceTriggeredOrder,
  placeSpotOrder,
  placePriceTriggeredOrder,
  fmtForPair,
} from "./gateio";
import { logger } from "../lib/logger";

export let scalperLastSyncAt: Date | null = null;

// ── Compound balance update ───────────────────────────────────────────────────

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

// ── CHT P&L helper ────────────────────────────────────────────────────────────
// Accounts for the 30% partial exit at TP1 if break-even was already activated.

function computeChtPnl(
  trade: typeof scalperTradesTable.$inferSelect,
  closePrice: number,
): number | null {
  const { entryPrice, quantity, side, breakEvenActivated, tp1Price } = trade;
  if (entryPrice == null || quantity == null) return null;
  const dir = side === "buy" ? 1 : -1;
  if (breakEvenActivated && tp1Price != null) {
    // 30% exited at TP1, remaining 70% at closePrice
    return (
      (tp1Price - entryPrice) * dir * quantity * 0.30 +
      (closePrice - entryPrice) * dir * quantity * 0.70
    );
  }
  return (closePrice - entryPrice) * dir * quantity;
}

// ── CHT paper trade sync ──────────────────────────────────────────────────────

async function syncChtPaperTrade(
  trade: typeof scalperTradesTable.$inferSelect,
  livePrice: number,
): Promise<void> {
  const { id, side, entryPrice, quantity } = trade;

  // Step 1: check TP1 for break-even activation (if not yet done)
  if (!trade.breakEvenActivated && trade.tp1Price != null && entryPrice != null) {
    const tp1Hit = side === "buy" ? livePrice >= trade.tp1Price : livePrice <= trade.tp1Price;
    if (tp1Hit) {
      await db.update(scalperTradesTable).set({
        slPrice: parseFloat(entryPrice.toFixed(8)),   // move SL to entry = break-even
        breakEvenActivated: true,
      }).where(eq(scalperTradesTable.id, id));
      logger.info({ tradeId: id, entryPrice, tp1Price: trade.tp1Price }, "CHT paper: TP1 hit — break-even activated");
      // Re-read updated slPrice for close checks below
      trade = { ...trade, slPrice: entryPrice, breakEvenActivated: true };
    }
  }

  // Step 2: determine close reason (TP2 → TP3 → SL, in priority order)
  let closeReason: string | null = null;

  if (trade.tp2Price != null) {
    const hit = side === "buy" ? livePrice >= trade.tp2Price : livePrice <= trade.tp2Price;
    if (hit) closeReason = "tp2";
  }
  if (!closeReason && trade.tp3Price != null) {
    const hit = side === "buy" ? livePrice >= trade.tp3Price : livePrice <= trade.tp3Price;
    if (hit) closeReason = "tp3";
  }
  if (!closeReason && trade.slPrice != null) {
    const hit = side === "buy" ? livePrice <= trade.slPrice : livePrice >= trade.slPrice;
    if (hit) closeReason = "sl";
  }

  if (closeReason) {
    const closePrice =
      closeReason === "tp2" ? (trade.tp2Price ?? livePrice) :
      closeReason === "tp3" ? (trade.tp3Price ?? livePrice) :
      (trade.slPrice ?? livePrice);

    const pnl = computeChtPnl(trade, closePrice);

    await db.update(scalperTradesTable).set({
      status: "closed",
      livePrice,
      closePrice,
      closeReason,
      pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
      closedAt: new Date(),
    }).where(eq(scalperTradesTable.id, id));

    logger.info({ tradeId: id, closeReason, closePrice, livePrice, pnl }, "CHT paper: trade closed");
    if (pnl != null) await updateScalperCompoundBalance(pnl);
    return;
  }

  // Not closed — update unrealised P&L
  const unrealizedPnl =
    entryPrice != null && quantity != null
      ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
      : null;
  await db.update(scalperTradesTable)
    .set({ livePrice, pnl: unrealizedPnl != null ? parseFloat(unrealizedPnl.toFixed(4)) : null })
    .where(eq(scalperTradesTable.id, id));
}

// ── CHT live trade sync ───────────────────────────────────────────────────────

async function syncChtLiveTrade(trade: typeof scalperTradesTable.$inferSelect): Promise<void> {
  const { id, gateSymbol, side, entryPrice, quantity } = trade;

  // Helper: cancel a price-triggered order without throwing
  async function tryCancel(orderId: string | null | undefined, label: string): Promise<void> {
    if (!orderId) return;
    try {
      await cancelPriceTriggeredOrder(Number(orderId), gateSymbol);
      logger.info({ tradeId: id, orderId, label }, "CHT live: cancelled order");
    } catch {
      // Already gone — non-critical
    }
  }

  // Helper: check if a price-triggered order has filled; returns fill price or null
  async function checkFill(
    orderId: string | null | undefined,
  ): Promise<{ filled: true; price: number; qty: number } | { filled: false; terminal: boolean } | null> {
    if (!orderId) return null;
    try {
      const order = await getPriceTriggeredOrder(Number(orderId), gateSymbol);
      if (order.status === "finish") {
        const qty = parseFloat(order.put.amount) - parseFloat(order.put.left || "0");
        const price = parseFloat(order.put.avg_deal_price || order.put.price);
        return { filled: true, price, qty };
      }
      if (order.status === "open") return { filled: false, terminal: false };
      return { filled: false, terminal: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("order not found")) return { filled: false, terminal: true };
      logger.warn({ tradeId: id, orderId, err: msg }, "CHT live: order check failed");
      return { filled: false, terminal: false };
    }
  }

  // ── Check TP1 (30% exit → break-even) ─────────────────────────────────────
  if (!trade.breakEvenActivated && trade.tp1OrderId) {
    const result = await checkFill(trade.tp1OrderId);
    if (result?.filled) {
      // TP1 filled: cancel full-qty SL, place new BE SL for remaining ~70%
      await tryCancel(trade.slOrderId, "old-SL");

      const remainingQty = quantity != null ? quantity * 0.70 : null;
      let newSlOrderId: string | null = null;

      if (entryPrice != null && remainingQty != null && remainingQty > 0) {
        try {
          const slFmt = await fmtForPair(gateSymbol, entryPrice, remainingQty);
          const slRule = side === "buy" ? "<=" : ">=";
          const exitSide = side === "buy" ? "sell" : "buy";
          const newSl = await placePriceTriggeredOrder({
            currencyPair: gateSymbol,
            triggerPrice: slFmt.price,
            triggerRule:  slRule,
            side:         exitSide,
            amount:       slFmt.amount,
            orderPrice:   "0",
            orderType:    "market",
          });
          newSlOrderId = newSl.id.toString();
          logger.info(
            { tradeId: id, newSlOrderId, bePrice: slFmt.price },
            "CHT live: TP1 hit — break-even SL placed",
          );
        } catch (err) {
          logger.warn({ tradeId: id, err }, "CHT live: failed to place break-even SL");
        }
      }

      await db.update(scalperTradesTable).set({
        slPrice:           entryPrice != null ? parseFloat(entryPrice.toFixed(8)) : undefined,
        slOrderId:         newSlOrderId,
        tp1OrderId:        null,  // TP1 consumed
        breakEvenActivated: true,
      }).where(eq(scalperTradesTable.id, id));

      logger.info({ tradeId: id }, "CHT live: break-even activated after TP1");
      // Continue to update P&L — don't return early; trade still open
      trade = { ...trade, tp1OrderId: null, slOrderId: newSlOrderId, slPrice: entryPrice ?? trade.slPrice, breakEvenActivated: true };
    }
  }

  // ── Check TP2 / TP3 / SL for full close ───────────────────────────────────
  const exitChecks: { orderId: string | null | undefined; reason: string }[] = [
    { orderId: trade.tp2OrderId, reason: "tp2" },
    { orderId: trade.tp3OrderId, reason: "tp3" },
    { orderId: trade.slOrderId,  reason: "sl"  },
  ];

  for (const { orderId, reason } of exitChecks) {
    if (!orderId) continue;
    const result = await checkFill(orderId);
    if (result?.filled) {
      const closePrice = result.price;
      const pnl = computeChtPnl(trade, closePrice);

      await db.update(scalperTradesTable).set({
        status:     "closed",
        closePrice,
        closeReason: reason,
        pnl:        pnl != null ? parseFloat(pnl.toFixed(4)) : null,
        closedAt:   new Date(),
      }).where(eq(scalperTradesTable.id, id));

      logger.info({ tradeId: id, reason, closePrice, pnl }, "CHT live: trade closed");
      if (pnl != null) await updateScalperCompoundBalance(pnl);

      // Cancel all remaining orders
      const others = exitChecks
        .filter(c => c.orderId && c.orderId !== orderId)
        .map(c => c.orderId!);
      if (trade.tp1OrderId) others.push(trade.tp1OrderId);
      for (const oid of others) await tryCancel(oid, "companion");

      return;
    }
  }

  // ── Price-based fallback: if all orders are terminal/missing ──────────────
  const allTerminal = exitChecks.every(async ({ orderId }) => {
    if (!orderId) return true;
    const r = await checkFill(orderId);
    return r == null || (r.filled === false && r.terminal);
  });

  // Update live P&L
  try {
    const livePrice = await getLivePrice(gateSymbol);
    const pnl =
      entryPrice != null && quantity != null
        ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
        : null;
    await db.update(scalperTradesTable)
      .set({ livePrice, pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null })
      .where(eq(scalperTradesTable.id, id));
    void allTerminal; // suppress unused warning
  } catch {
    // Non-critical
  }
}

// ── Standard trade sync (BB+RSI / SMC) ───────────────────────────────────────

async function syncStandardTrade(trade: typeof scalperTradesTable.$inferSelect): Promise<void> {
  const { id, gateSymbol, side, entryPrice, quantity, paperMode } = trade;

  if (paperMode) {
    let livePrice: number;
    try {
      livePrice = await getLivePrice(gateSymbol);
    } catch (err) {
      logger.warn({ tradeId: id, err }, "Scalper sync: failed to fetch live price");
      return;
    }

    let closeReason: "tp" | "sl" | null = null;
    if (trade.tpPrice != null) {
      const hit = side === "buy" ? livePrice >= trade.tpPrice : livePrice <= trade.tpPrice;
      if (hit) closeReason = "tp";
    }
    if (!closeReason && trade.slPrice != null) {
      const hit = side === "buy" ? livePrice <= trade.slPrice : livePrice >= trade.slPrice;
      if (hit) closeReason = "sl";
    }

    if (closeReason) {
      const closePrice = closeReason === "tp" ? (trade.tpPrice ?? livePrice) : (trade.slPrice ?? livePrice);
      const closedPnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? closePrice - entryPrice : entryPrice - closePrice) * quantity
          : null;

      await db.update(scalperTradesTable).set({
        status: "closed", livePrice, closePrice, closeReason,
        pnl: closedPnl != null ? parseFloat(closedPnl.toFixed(4)) : null,
        closedAt: new Date(),
      }).where(eq(scalperTradesTable.id, id));

      logger.info({ tradeId: id, closeReason, closePrice, pnl: closedPnl }, "Scalper: paper trade auto-closed");
      if (closedPnl != null) await updateScalperCompoundBalance(closedPnl);
    } else {
      const pnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
          : null;
      await db.update(scalperTradesTable)
        .set({ livePrice, pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null })
        .where(eq(scalperTradesTable.id, id));
    }
    return;
  }

  // Live standard trade — poll Gate.io price-triggered orders
  const orderChecks: { orderId: number; reason: "tp" | "sl" }[] = [];
  if (trade.tpOrderId) orderChecks.push({ orderId: Number(trade.tpOrderId), reason: "tp" });
  if (trade.slOrderId) orderChecks.push({ orderId: Number(trade.slOrderId), reason: "sl" });

  let allOrdersTerminal = orderChecks.length > 0;

  for (const { orderId, reason } of orderChecks) {
    try {
      const order = await getPriceTriggeredOrder(orderId, gateSymbol);

      if (order.status === "finish") {
        const filledQty = parseFloat(order.put.amount) - parseFloat(order.put.left || "0");

        if (filledQty <= 0) {
          logger.warn({ tradeId: id, orderId, reason }, "Scalper: order fired but unfilled (gap) — price fallback");
          continue;
        }

        const closePrice = parseFloat(order.put.avg_deal_price || order.put.price);
        const pnl =
          entryPrice != null && filledQty > 0
            ? (side === "buy" ? closePrice - entryPrice : entryPrice - closePrice) * filledQty
            : null;

        await db.update(scalperTradesTable).set({
          status: "closed", closePrice, closeReason: reason,
          pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
          closedAt: new Date(),
        }).where(eq(scalperTradesTable.id, id));

        logger.info({ tradeId: id, reason, closePrice, filledQty, pnl }, "Scalper: live trade closed");
        if (pnl != null) await updateScalperCompoundBalance(pnl);

        const otherOrderId = reason === "tp" ? trade.slOrderId : trade.tpOrderId;
        if (otherOrderId) {
          try {
            await cancelPriceTriggeredOrder(Number(otherOrderId), gateSymbol);
          } catch { /* already gone */ }
        }
        return;
      }

      if (order.status === "open") allOrdersTerminal = false;

      if (["cancelled", "expired", "failed"].includes(order.status)) {
        logger.warn({ tradeId: id, orderId, reason, status: order.status }, "Scalper: order terminated without fill");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("order not found")) {
        logger.warn({ tradeId: id, orderId, reason }, "Scalper sync: order not found — treating as terminal");
      } else {
        allOrdersTerminal = false;
        logger.warn({ tradeId: id, orderId, err: msg }, "Scalper sync: order check failed (transient)");
      }
    }
  }

  // TP/SL retry if placement failed
  if ((!trade.tpOrderId || !trade.slOrderId) && trade.tpPrice != null && trade.slPrice != null && quantity != null) {
    logger.warn({ tradeId: id }, "Scalper sync: missing TP/SL orders — retrying");
    const retryUpdates: Record<string, unknown> = {};
    const retryErrors: string[] = [];

    if (!trade.tpOrderId) {
      try {
        const fmt = await fmtForPair(gateSymbol, trade.tpPrice, quantity);
        const o = await placePriceTriggeredOrder({
          currencyPair: gateSymbol,
          triggerPrice: fmt.price,
          triggerRule:  side === "buy" ? ">=" : "<=",
          side:         side === "buy" ? "sell" : "buy",
          amount: fmt.amount, orderPrice: fmt.price,
        });
        retryUpdates.tpOrderId = o.id.toString();
        logger.info({ tradeId: id, tpOrderId: o.id }, "Scalper sync: TP retry succeeded");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        retryErrors.push(`TP retry: ${msg}`);
      }
    }

    if (!trade.slOrderId) {
      try {
        const fmt = await fmtForPair(gateSymbol, trade.slPrice, quantity);
        const o = await placePriceTriggeredOrder({
          currencyPair: gateSymbol,
          triggerPrice: fmt.price,
          triggerRule:  side === "buy" ? "<=" : ">=",
          side:         side === "buy" ? "sell" : "buy",
          amount: fmt.amount, orderPrice: "0", orderType: "market",
        });
        retryUpdates.slOrderId = o.id.toString();
        logger.info({ tradeId: id, slOrderId: o.id }, "Scalper sync: SL retry succeeded");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        retryErrors.push(`SL retry: ${msg}`);
      }
    }

    if (Object.keys(retryUpdates).length > 0) {
      await db.update(scalperTradesTable).set(retryUpdates).where(eq(scalperTradesTable.id, id));
    }
    if (retryErrors.length > 0) {
      await db.update(scalperTradesTable).set({ errorMessage: retryErrors.join(" | ") }).where(eq(scalperTradesTable.id, id));
    }
  }

  // Price-based fallback
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
        let actualClose = closeReason === "tp" ? trade.tpPrice! : trade.slPrice!;

        for (const oid of [trade.tpOrderId, trade.slOrderId].filter(Boolean) as string[]) {
          try { await cancelPriceTriggeredOrder(parseInt(oid), gateSymbol); } catch { /* gone */ }
        }

        if (quantity != null && quantity > 0) {
          try {
            const exitFmt = await fmtForPair(gateSymbol, livePrice, quantity);
            const exitOrder = await placeSpotOrder({
              currencyPair: gateSymbol,
              side: side === "buy" ? "sell" : "buy",
              amount: exitFmt.amount, type: "market",
            });
            actualClose = parseFloat(exitOrder.avg_deal_price || livePrice.toString());
            logger.info({ tradeId: id, closeReason, actualClose }, "Scalper: fallback exit placed");
          } catch (exitErr) {
            const exitMsg = exitErr instanceof Error ? exitErr.message : String(exitErr);
            if (exitMsg.includes("BALANCE_NOT_ENOUGH") || exitMsg.includes("balance")) {
              // Asset already sold by TP/SL — position is closed, no sell needed
              logger.warn({ tradeId: id, closeReason }, "Scalper: fallback sell skipped — balance already gone (TP/SL filled)");
            } else {
              logger.error({ tradeId: id, exitErr }, "Scalper: fallback exit FAILED");
            }
          }
        }

        const pnl =
          entryPrice != null && quantity != null
            ? (side === "buy" ? actualClose - entryPrice : entryPrice - actualClose) * quantity
            : null;

        await db.update(scalperTradesTable).set({
          status: "closed", livePrice, closePrice: actualClose, closeReason,
          pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
          closedAt: new Date(),
        }).where(eq(scalperTradesTable.id, id));

        logger.warn({ tradeId: id, closeReason, closePrice: actualClose }, "Scalper: live closed via price fallback");
        if (pnl != null) await updateScalperCompoundBalance(pnl);
        return;
      }

      // Price is between SL and TP — but if all orders are terminal (not found), the
      // position was likely already closed by Gate.io. Try a market sell to confirm;
      // if BALANCE_NOT_ENOUGH, the asset is gone — mark as closed at live price.
      if (allOrdersTerminal && quantity != null && quantity > 0) {
        try {
          const exitFmt = await fmtForPair(gateSymbol, livePrice, quantity);
          const exitOrder = await placeSpotOrder({
            currencyPair: gateSymbol,
            side: side === "buy" ? "sell" : "buy",
            amount: exitFmt.amount, type: "market",
          });
          const actualClose = parseFloat(exitOrder.avg_deal_price || livePrice.toString());
          const pnl =
            entryPrice != null
              ? (side === "buy" ? actualClose - entryPrice : entryPrice - actualClose) * quantity
              : null;
          await db.update(scalperTradesTable).set({
            status: "closed", livePrice, closePrice: actualClose, closeReason: "terminal",
            pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
            closedAt: new Date(),
          }).where(eq(scalperTradesTable.id, id));
          logger.warn({ tradeId: id, actualClose, pnl }, "Scalper: terminal orders — emergency exit placed, trade closed");
          if (pnl != null) await updateScalperCompoundBalance(pnl);
          return;
        } catch (exitErr) {
          const exitMsg = exitErr instanceof Error ? exitErr.message : String(exitErr);
          if (exitMsg.includes("BALANCE_NOT_ENOUGH") || exitMsg.includes("balance")) {
            // Already sold — close at live price with best-effort P&L estimate
            const pnl =
              entryPrice != null
                ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
                : null;
            await db.update(scalperTradesTable).set({
              status: "closed", livePrice, closePrice: livePrice, closeReason: "terminal",
              pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
              closedAt: new Date(),
            }).where(eq(scalperTradesTable.id, id));
            logger.warn({ tradeId: id, livePrice, pnl }, "Scalper: terminal orders — balance gone, trade auto-closed at live price");
            if (pnl != null) await updateScalperCompoundBalance(pnl);
            return;
          }
          logger.error({ tradeId: id, exitErr: exitMsg }, "Scalper: terminal emergency exit failed (transient)");
        }
      }

      const pnl =
        entryPrice != null && quantity != null
          ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
          : null;
      await db.update(scalperTradesTable)
        .set({ livePrice, pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null })
        .where(eq(scalperTradesTable.id, id));
    } catch { /* Non-critical */ }
    return;
  }

  // Update live P&L only
  try {
    const livePrice = await getLivePrice(gateSymbol);
    const pnl =
      entryPrice != null && quantity != null
        ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
        : null;
    await db.update(scalperTradesTable)
      .set({ livePrice, pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null })
      .where(eq(scalperTradesTable.id, id));
  } catch { /* Non-critical */ }
}

// ── Micro $2 paper trade sync ─────────────────────────────────────────────────

async function syncMicroPaperTrade(
  trade: typeof scalperTradesTable.$inferSelect,
  livePrice: number,
): Promise<void> {
  const { id, side, entryPrice, quantity } = trade;

  // Step 1: TP1 hit → move SL to break-even
  if (!trade.breakEvenActivated && trade.tp1Price != null && entryPrice != null) {
    const tp1Hit = side === "buy" ? livePrice >= trade.tp1Price : livePrice <= trade.tp1Price;
    if (tp1Hit) {
      await db.update(scalperTradesTable).set({
        slPrice: parseFloat(entryPrice.toFixed(8)),
        breakEvenActivated: true,
      }).where(eq(scalperTradesTable.id, id));
      logger.info({ tradeId: id, entryPrice, tp1Price: trade.tp1Price }, "Micro paper: TP1 hit — break-even activated");
      trade = { ...trade, slPrice: entryPrice, breakEvenActivated: true };
    }
  }

  // Step 2: TP2 or SL → close
  let closeReason: string | null = null;
  if (trade.tp2Price != null) {
    const hit = side === "buy" ? livePrice >= trade.tp2Price : livePrice <= trade.tp2Price;
    if (hit) closeReason = "tp2";
  }
  if (!closeReason && trade.slPrice != null) {
    const hit = side === "buy" ? livePrice <= trade.slPrice : livePrice >= trade.slPrice;
    if (hit) closeReason = "sl";
  }

  if (closeReason) {
    const closePrice =
      closeReason === "tp2" ? (trade.tp2Price ?? livePrice) : (trade.slPrice ?? livePrice);

    // P&L: 50% exited at TP1 (if BE activated), 50% at closePrice
    let pnl: number | null = null;
    if (entryPrice != null && quantity != null) {
      const d = side === "buy" ? 1 : -1;
      if (closeReason !== "sl" && trade.breakEvenActivated && trade.tp1Price != null) {
        pnl = (trade.tp1Price - entryPrice) * d * quantity * 0.50
            + (closePrice - entryPrice) * d * quantity * 0.50;
      } else {
        pnl = (closePrice - entryPrice) * d * quantity;
      }
    }

    await db.update(scalperTradesTable).set({
      status: "closed", livePrice, closePrice, closeReason,
      pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
      closedAt: new Date(),
    }).where(eq(scalperTradesTable.id, id));

    logger.info({ tradeId: id, closeReason, closePrice, pnl }, "Micro paper: trade closed");
    if (pnl != null) await updateScalperCompoundBalance(pnl);
    return;
  }

  // Update unrealised P&L
  const unrealizedPnl =
    entryPrice != null && quantity != null
      ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
      : null;
  await db.update(scalperTradesTable)
    .set({ livePrice, pnl: unrealizedPnl != null ? parseFloat(unrealizedPnl.toFixed(4)) : null })
    .where(eq(scalperTradesTable.id, id));
}

// ── Micro $2 live trade sync ──────────────────────────────────────────────────

async function syncMicroLiveTrade(trade: typeof scalperTradesTable.$inferSelect): Promise<void> {
  const { id, gateSymbol, side, entryPrice, quantity } = trade;

  async function tryCancel(orderId: string | null | undefined, label: string): Promise<void> {
    if (!orderId) return;
    try {
      await cancelPriceTriggeredOrder(Number(orderId), gateSymbol);
      logger.info({ tradeId: id, orderId, label }, "Micro live: cancelled order");
    } catch { /* already gone */ }
  }

  async function checkFill(
    orderId: string | null | undefined,
  ): Promise<{ filled: true; price: number } | { filled: false; terminal: boolean } | null> {
    if (!orderId) return null;
    try {
      const order = await getPriceTriggeredOrder(Number(orderId), gateSymbol);
      if (order.status === "finish") {
        const price = parseFloat(order.put.avg_deal_price || order.put.price);
        return { filled: true, price };
      }
      if (order.status === "open") return { filled: false, terminal: false };
      return { filled: false, terminal: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("order not found")) return { filled: false, terminal: true };
      logger.warn({ tradeId: id, orderId, err: msg }, "Micro live: order check failed");
      return { filled: false, terminal: false };
    }
  }

  // ── Check TP1 (50% exit → break-even) ─────────────────────────────────
  if (!trade.breakEvenActivated && trade.tp1OrderId) {
    const result = await checkFill(trade.tp1OrderId);
    if (result?.filled) {
      await tryCancel(trade.slOrderId, "old-SL");

      const remainingQty = quantity != null ? quantity * 0.50 : null;
      let newSlOrderId: string | null = null;

      if (entryPrice != null && remainingQty != null && remainingQty > 0) {
        try {
          const slFmt = await fmtForPair(gateSymbol, entryPrice, remainingQty);
          const slRule = side === "buy" ? "<=" : ">=";
          const exitSide = side === "buy" ? "sell" : "buy";
          const newSl = await placePriceTriggeredOrder({
            currencyPair: gateSymbol,
            triggerPrice: slFmt.price, triggerRule: slRule,
            side: exitSide, amount: slFmt.amount,
            orderPrice: "0", orderType: "market",
          });
          newSlOrderId = newSl.id.toString();
          logger.info({ tradeId: id, newSlOrderId, bePrice: slFmt.price }, "Micro live: TP1 hit — break-even SL placed");
        } catch (err) {
          logger.warn({ tradeId: id, err }, "Micro live: failed to place break-even SL");
        }
      }

      await db.update(scalperTradesTable).set({
        slPrice:            entryPrice != null ? parseFloat(entryPrice.toFixed(8)) : undefined,
        slOrderId:          newSlOrderId,
        tp1OrderId:         null,
        breakEvenActivated: true,
      }).where(eq(scalperTradesTable.id, id));

      trade = { ...trade, tp1OrderId: null, slOrderId: newSlOrderId, slPrice: entryPrice ?? trade.slPrice, breakEvenActivated: true };
      logger.info({ tradeId: id }, "Micro live: break-even activated after TP1");
    }
  }

  // ── Check TP2 / SL for full close ─────────────────────────────────────
  const exitChecks: { orderId: string | null | undefined; reason: string }[] = [
    { orderId: trade.tp2OrderId, reason: "tp2" },
    { orderId: trade.slOrderId,  reason: "sl"  },
  ];

  for (const { orderId, reason } of exitChecks) {
    if (!orderId) continue;
    const result = await checkFill(orderId);
    if (result?.filled) {
      const closePrice = result.price;
      let pnl: number | null = null;
      if (entryPrice != null && quantity != null) {
        const d = side === "buy" ? 1 : -1;
        if (reason !== "sl" && trade.breakEvenActivated && trade.tp1Price != null) {
          pnl = (trade.tp1Price - entryPrice) * d * quantity * 0.50
              + (closePrice - entryPrice) * d * quantity * 0.50;
        } else {
          pnl = (closePrice - entryPrice) * d * quantity;
        }
      }

      await db.update(scalperTradesTable).set({
        status: "closed", closePrice, closeReason: reason,
        pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
        closedAt: new Date(),
      }).where(eq(scalperTradesTable.id, id));

      logger.info({ tradeId: id, reason, closePrice, pnl }, "Micro live: trade closed");
      if (pnl != null) await updateScalperCompoundBalance(pnl);

      const others = exitChecks.filter(c => c.orderId && c.orderId !== orderId).map(c => c.orderId!);
      for (const oid of others) await tryCancel(oid, "companion");
      return;
    }
  }

  // Update live P&L
  try {
    const livePrice = await getLivePrice(gateSymbol);
    const pnl =
      entryPrice != null && quantity != null
        ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
        : null;
    await db.update(scalperTradesTable)
      .set({ livePrice, pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null })
      .where(eq(scalperTradesTable.id, id));
  } catch { /* non-critical */ }
}

// ── Main sync dispatcher ──────────────────────────────────────────────────────

async function syncScalperTrade(trade: typeof scalperTradesTable.$inferSelect): Promise<void> {
  const isMicro = trade.strategy === "micro_2usd";
  const isCht   = !isMicro && (trade.strategy === "cht" || (trade.tp1Price != null && trade.tp3Price != null));

  if (isMicro) {
    if (trade.paperMode) {
      let livePrice: number;
      try {
        livePrice = await getLivePrice(trade.gateSymbol);
      } catch (err) {
        logger.warn({ tradeId: trade.id, err }, "Micro sync: failed to fetch live price");
        return;
      }
      return syncMicroPaperTrade(trade, livePrice);
    }
    return syncMicroLiveTrade(trade);
  }

  if (isCht) {
    if (trade.paperMode) {
      let livePrice: number;
      try {
        livePrice = await getLivePrice(trade.gateSymbol);
      } catch (err) {
        logger.warn({ tradeId: trade.id, err }, "CHT sync: failed to fetch live price");
        return;
      }
      return syncChtPaperTrade(trade, livePrice);
    }
    return syncChtLiveTrade(trade);
  }

  return syncStandardTrade(trade);
}

// ── Public sync loop ──────────────────────────────────────────────────────────

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
