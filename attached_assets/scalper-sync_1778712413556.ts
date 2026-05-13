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
  getSpotAccounts,
} from "./gateio";
import { logger } from "../lib/logger";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns the available base-currency balance from the Gate.io spot account.
 * Returns -1 if the balance cannot be fetched (transient error) — callers
 * should treat -1 conservatively (do NOT auto-close the position).
 */
async function getAvailableBase(gateSymbol: string): Promise<number> {
  const baseCurrency = gateSymbol.split("_")[0]!;
  try {
    const accounts = await getSpotAccounts();
    const baseAcc = accounts.find((a) => a.currency === baseCurrency);
    return baseAcc ? parseFloat(baseAcc.available) : 0;
  } catch {
    return -1;
  }
}

/**
 * Fetches the configurable stop-limit SL offset percentage from the DB config.
 * Falls back to 0.2% if config is unavailable.
 */
export async function getSlLimitOffsetPct(): Promise<number> {
  try {
    const [cfg] = await db.select({ v: scalperConfigTable.slLimitOffsetPct }).from(scalperConfigTable).limit(1);
    return cfg?.v ?? 0.2;
  } catch {
    return 0.2;
  }
}

/**
 * Computes the stop-limit order's limit price by applying an offset away from
 * the trigger in the direction that keeps the order fillable in a fast move.
 * Long (buy side): limit = trigger * (1 - offset) — slightly below trigger
 * Short (sell side): limit = trigger * (1 + offset) — slightly above trigger
 */
export function computeSlLimitPrice(trigger: number, side: string, offsetPct: number): number {
  const f = offsetPct / 100;
  return side === "buy" ? trigger * (1 - f) : trigger * (1 + f);
}

export let scalperLastSyncAt: Date | null = null;

// ── Grace period for terminal ORDER_NOT_FOUND checks ─────────────────────────
// Gate.io's order query API can take a few seconds to index a newly placed
// order. A sync tick that fires during that window gets ORDER_NOT_FOUND and
// would wrongly treat the order as terminally gone. Skip terminal treatment
// for any trade that is less than 2 minutes old.
const GRACE_PERIOD_MS = 2 * 60 * 1000;

function isInGracePeriod(createdAt: Date | string | null | undefined): boolean {
  if (!createdAt) return false;
  return Date.now() - new Date(createdAt).getTime() < GRACE_PERIOD_MS;
}

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

// A1: per-fill P&L + TP3 force-close + SL→BE
// P&L is accumulated incrementally via realizedPnl on each partial exit.
// computeChtPnl removed — each exit now computes its own increment directly.

// ── CHT paper trade sync ──────────────────────────────────────────────────────

async function syncChtPaperTrade(
  trade: typeof scalperTradesTable.$inferSelect,
  livePrice: number,
): Promise<void> {
  const { id, side, entryPrice, quantity } = trade;

  // A1: per-fill P&L + TP3 force-close + SL→BE
  const qty = quantity ?? 0;
  const dir = side === "buy" ? 1 : -1;

  // Step 1: TP1 → break-even + record 30% partial P&L
  if (!trade.breakEvenActivated && trade.tp1Price != null && entryPrice != null) {
    const tp1Hit = side === "buy" ? livePrice >= trade.tp1Price : livePrice <= trade.tp1Price;
    if (tp1Hit) {
      const tp1Qty = qty * 0.30;
      const tp1PnlIncrement = (trade.tp1Price - entryPrice) * dir * tp1Qty;
      const newClosedQty    = tp1Qty;
      const newRemainingQty = qty - tp1Qty;
      const newRealizedPnl  = Number(trade.realizedPnl ?? 0) + tp1PnlIncrement;
      await db.update(scalperTradesTable).set({
        slPrice:            parseFloat(entryPrice.toFixed(8)),
        breakEvenActivated: true,
        closedQty:          newClosedQty.toFixed(8),
        remainingQty:       newRemainingQty.toFixed(8),
        realizedPnl:        newRealizedPnl.toFixed(4),
      }).where(eq(scalperTradesTable.id, id));
      logger.info({ tradeId: id, entryPrice, tp1Price: trade.tp1Price, tp1PnlIncrement, newRealizedPnl }, "CHT paper: TP1 hit — break-even activated, 30% P&L recorded");
      trade = { ...trade, slPrice: entryPrice, breakEvenActivated: true, closedQty: newClosedQty.toFixed(8), remainingQty: newRemainingQty.toFixed(8), realizedPnl: newRealizedPnl.toFixed(4) };
    }
  }

  // Step 2a: TP2 partial (30%) — only after BE activated and TP2 not yet consumed
  const closedQtyNow   = Number(trade.closedQty ?? 0);
  const realizedPnlNow = Number(trade.realizedPnl ?? 0);
  const tp2Consumed    = closedQtyNow > qty * 0.35;

  if (trade.breakEvenActivated && !tp2Consumed && trade.tp2Price != null && entryPrice != null) {
    const tp2Hit = side === "buy" ? livePrice >= trade.tp2Price : livePrice <= trade.tp2Price;
    if (tp2Hit) {
      const tp2Qty          = qty * 0.30;
      const tp2PnlIncrement = (trade.tp2Price - entryPrice) * dir * tp2Qty;
      const newClosedQty    = closedQtyNow + tp2Qty;
      const newRemainingQty = qty - newClosedQty;
      const newRealizedPnl  = realizedPnlNow + tp2PnlIncrement;
      await db.update(scalperTradesTable).set({
        closedQty:    newClosedQty.toFixed(8),
        remainingQty: newRemainingQty.toFixed(8),
        realizedPnl:  newRealizedPnl.toFixed(4),
        livePrice,
      }).where(eq(scalperTradesTable.id, id));
      logger.info({ tradeId: id, tp2Price: trade.tp2Price, tp2PnlIncrement, newRealizedPnl, newRemainingQty }, "CHT paper: TP2 partial — 30% P&L recorded, trade still open");
      trade = { ...trade, closedQty: newClosedQty.toFixed(8), remainingQty: newRemainingQty.toFixed(8), realizedPnl: newRealizedPnl.toFixed(4) };
    }
  }

  // Step 2b: TP3 final (40%) — only after TP2 consumed
  const closedQtyAfterTp2   = Number(trade.closedQty ?? 0);
  const realizedPnlAfterTp2 = Number(trade.realizedPnl ?? 0);
  const tp2AlreadyConsumed  = closedQtyAfterTp2 > qty * 0.35;
  const tp3Consumed         = closedQtyAfterTp2 > qty * 0.65;

  if (tp2AlreadyConsumed && !tp3Consumed && trade.tp3Price != null && entryPrice != null) {
    const tp3Hit = side === "buy" ? livePrice >= trade.tp3Price : livePrice <= trade.tp3Price;
    if (tp3Hit) {
      const tp3Qty    = qty - closedQtyAfterTp2;
      const finalPnl  = realizedPnlAfterTp2 + (trade.tp3Price - entryPrice) * dir * tp3Qty;
      await db.update(scalperTradesTable).set({
        status:      "closed",
        livePrice,
        closePrice:  trade.tp3Price,
        closeReason: "tp3",
        closedQty:   qty.toFixed(8),
        remainingQty: "0",
        realizedPnl: finalPnl.toFixed(4),
        pnl:         parseFloat(finalPnl.toFixed(4)),
        closedAt:    new Date(),
      }).where(eq(scalperTradesTable.id, id));
      logger.info({ tradeId: id, tp3Price: trade.tp3Price, finalPnl }, "CHT paper: TP3 hit — trade fully closed");
      await updateScalperCompoundBalance(finalPnl);
      return;
    }
  }

  // Step 2c: SL — close remaining qty at SL price
  if (trade.slPrice != null && entryPrice != null) {
    const slHit = side === "buy" ? livePrice <= trade.slPrice : livePrice >= trade.slPrice;
    if (slHit) {
      const remainingQty = qty - closedQtyAfterTp2;
      const finalPnl     = realizedPnlAfterTp2 + (trade.slPrice - entryPrice) * dir * remainingQty;
      await db.update(scalperTradesTable).set({
        status:      "closed",
        livePrice,
        closePrice:  trade.slPrice,
        closeReason: "sl",
        closedQty:   qty.toFixed(8),
        remainingQty: "0",
        realizedPnl: finalPnl.toFixed(4),
        pnl:         parseFloat(finalPnl.toFixed(4)),
        closedAt:    new Date(),
      }).where(eq(scalperTradesTable.id, id));
      logger.info({ tradeId: id, slPrice: trade.slPrice, remainingQty, finalPnl }, "CHT paper: SL hit — trade closed");
      await updateScalperCompoundBalance(finalPnl);
      return;
    }
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
      await cancelPriceTriggeredOrder(orderId, gateSymbol);
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
      const order = await getPriceTriggeredOrder(orderId, gateSymbol);
      if (order.status === "finish") {
        const qty = parseFloat(order.put.amount) - parseFloat(order.put.left || "0");
        const price = parseFloat(order.put.avg_deal_price || order.put.price);
        return { filled: true, price, qty };
      }
      if (order.status === "open") return { filled: false, terminal: false };
      return { filled: false, terminal: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("order not found")) {
        if (isInGracePeriod(trade.createdAt)) return { filled: false, terminal: false };
        return { filled: false, terminal: true };
      }
      logger.warn({ tradeId: id, orderId, err: msg }, "CHT live: order check failed");
      return { filled: false, terminal: false };
    }
  }

  // B9: Retry BE SL placement — triggered when TP1 consumed but slOrderId is null (prior placement failed)
  if (trade.breakEvenActivated && !trade.tp1OrderId && !trade.slOrderId) {
    const beAvailBase = await getAvailableBase(gateSymbol);
    const effectiveQty = beAvailBase > 0 ? Math.min(quantity ?? 0, beAvailBase) : (quantity ?? 0);
    const retryQty = effectiveQty * 0.70;
    if (entryPrice != null && retryQty > 0) {
      try {
        const slOffsetPct = await getSlLimitOffsetPct();
        const slLimitPriceVal = computeSlLimitPrice(entryPrice, side, slOffsetPct);
        const [slFmt, slLimFmt] = await Promise.all([
          fmtForPair(gateSymbol, entryPrice, retryQty),
          fmtForPair(gateSymbol, slLimitPriceVal, retryQty),
        ]);
        const slRule = side === "buy" ? "<=" : ">=";
        const exitSide = side === "buy" ? "sell" : "buy";
        const retrySl = await placePriceTriggeredOrder({
          currencyPair: gateSymbol, triggerPrice: slFmt.price, triggerRule: slRule,
          side: exitSide, amount: slFmt.amount, orderPrice: slLimFmt.price, orderType: "limit",
        });
        const retrySlId = retrySl.id.toString();
        await db.update(scalperTradesTable).set({ slOrderId: retrySlId }).where(eq(scalperTradesTable.id, id));
        trade = { ...trade, slOrderId: retrySlId };
        logger.info({ tradeId: id, retrySlId, trigger: slFmt.price, limitPrice: slLimFmt.price, retryQty }, "CHT live: BE SL stop-limit retry succeeded");
      } catch (err) {
        logger.error({ tradeId: id, err }, "CHT live: BE SL retry failed — trade still unprotected");
      }
    }
  }

  // ── Check TP1 (30% exit → break-even) ─────────────────────────────────────
  if (!trade.breakEvenActivated && trade.tp1OrderId) {
    const result = await checkFill(trade.tp1OrderId);
    if (result?.filled) {
      // B9: place new BE SL BEFORE cancelling old, to preserve protection on failure
      const remainingQty = quantity != null ? quantity * 0.70 : null;
      let newSlOrderId: string | null = null;
      let slPlacementFailed = false;

      if (entryPrice != null && remainingQty != null && remainingQty > 0) {
        try {
          const tp1AvailBase = await getAvailableBase(gateSymbol);
          const tp1EffectiveQty = tp1AvailBase > 0 ? Math.min(quantity ?? 0, tp1AvailBase) : (quantity ?? 0);
          const beSlQty = tp1EffectiveQty * 0.70;
          const slOffsetPct = await getSlLimitOffsetPct();
          const slLimitPriceVal = computeSlLimitPrice(entryPrice, side, slOffsetPct);
          const [slFmt, slLimFmt] = await Promise.all([
            fmtForPair(gateSymbol, entryPrice, beSlQty > 0 ? beSlQty : remainingQty),
            fmtForPair(gateSymbol, slLimitPriceVal, beSlQty > 0 ? beSlQty : remainingQty),
          ]);
          const slRule = side === "buy" ? "<=" : ">=";
          const exitSide = side === "buy" ? "sell" : "buy";
          const newSl = await placePriceTriggeredOrder({
            currencyPair: gateSymbol,
            triggerPrice: slFmt.price,
            triggerRule:  slRule,
            side:         exitSide,
            amount:       slFmt.amount,
            orderPrice:   slLimFmt.price,
            orderType:    "limit",
          });
          newSlOrderId = newSl.id.toString();
          // New SL confirmed — now safe to cancel the old full-position SL
          await tryCancel(trade.slOrderId, "old-SL");
          logger.info(
            { tradeId: id, newSlOrderId, trigger: slFmt.price, limitPrice: slLimFmt.price },
            "CHT live: TP1 hit — break-even SL stop-limit placed, old SL cancelled",
          );
        } catch (err) {
          slPlacementFailed = true;
          logger.error({ tradeId: id, err }, "CHT live: BE SL placement failed after TP1 — keeping old SL, will retry next cycle");
        }
      }

      // A1: record 30% partial P&L at TP1 fill price
      const tp1Qty          = (quantity ?? 0) * 0.30;
      const tp1PnlIncrement = (result.price - (entryPrice ?? 0)) * (side === "buy" ? 1 : -1) * tp1Qty;
      const newRealizedPnl  = Number(trade.realizedPnl ?? 0) + tp1PnlIncrement;
      const newClosedQty    = tp1Qty;
      const newRemainingQty = (quantity ?? 0) - tp1Qty;

      // B9: if placement failed, preserve old slOrderId (don't null it)
      const dbSlOrderId = slPlacementFailed ? trade.slOrderId : newSlOrderId;

      await db.update(scalperTradesTable).set({
        slPrice:            entryPrice != null ? parseFloat(entryPrice.toFixed(8)) : undefined,
        slOrderId:          dbSlOrderId,
        tp1OrderId:         null,  // TP1 consumed
        breakEvenActivated: true,
        closedQty:          newClosedQty.toFixed(8),
        remainingQty:       newRemainingQty.toFixed(8),
        realizedPnl:        newRealizedPnl.toFixed(4),
      }).where(eq(scalperTradesTable.id, id));

      logger.info({ tradeId: id, tp1FillPrice: result.price, tp1PnlIncrement, newRealizedPnl }, "CHT live: TP1 — break-even activated, 30% P&L recorded");
      // Continue — don't return early; trade still open for TP2/TP3/SL
      trade = { ...trade, tp1OrderId: null, slOrderId: dbSlOrderId, slPrice: entryPrice ?? trade.slPrice, breakEvenActivated: true, closedQty: newClosedQty.toFixed(8), remainingQty: newRemainingQty.toFixed(8), realizedPnl: newRealizedPnl.toFixed(4) };
    }
  }

  // A1: per-fill P&L + TP3 force-close + SL→BE
  const qty = quantity ?? 0;
  const dir = side === "buy" ? 1 : -1;

  // ── Check TP2 (30% partial exit — Gate.io order sized for 30% qty) ─────────
  if (trade.tp2OrderId) {
    const result = await checkFill(trade.tp2OrderId);
    if (result?.filled) {
      const tp2Qty          = qty * 0.30;
      const tp2PnlIncrement = (result.price - (entryPrice ?? 0)) * dir * tp2Qty;
      const newClosedQty    = Number(trade.closedQty ?? 0) + tp2Qty;
      const newRemainingQty = qty - newClosedQty;
      const newRealizedPnl  = Number(trade.realizedPnl ?? 0) + tp2PnlIncrement;
      await db.update(scalperTradesTable).set({
        tp2OrderId:   null,
        closedQty:    newClosedQty.toFixed(8),
        remainingQty: newRemainingQty.toFixed(8),
        realizedPnl:  newRealizedPnl.toFixed(4),
      }).where(eq(scalperTradesTable.id, id));
      logger.info({ tradeId: id, tp2Price: result.price, tp2PnlIncrement, newRealizedPnl, newRemainingQty }, "CHT live: TP2 partial — 30% exit recorded, trade still open");
      trade = { ...trade, tp2OrderId: null, closedQty: newClosedQty.toFixed(8), remainingQty: newRemainingQty.toFixed(8), realizedPnl: newRealizedPnl.toFixed(4) };

      // B6: replace 70%-qty BE SL with 40%-qty SL for the TP2→TP3 phase
      const tp2AvailBase = await getAvailableBase(gateSymbol);
      const tp2EffectiveRem = tp2AvailBase > 0 ? Math.min(qty, tp2AvailBase) : qty;
      const remainingSlQty = tp2EffectiveRem * 0.40;
      if (trade.slPrice != null && remainingSlQty > 0) {
        try {
          const slOffsetPct = await getSlLimitOffsetPct();
          const slLimitPriceVal = computeSlLimitPrice(trade.slPrice, side, slOffsetPct);
          const [slFmt, slLimFmt] = await Promise.all([
            fmtForPair(gateSymbol, trade.slPrice, remainingSlQty),
            fmtForPair(gateSymbol, slLimitPriceVal, remainingSlQty),
          ]);
          const slRule = side === "buy" ? "<=" : ">=";
          const exitSide = side === "buy" ? "sell" : "buy";
          const newSl = await placePriceTriggeredOrder({
            currencyPair: gateSymbol, triggerPrice: slFmt.price, triggerRule: slRule,
            side: exitSide, amount: slFmt.amount, orderPrice: slLimFmt.price, orderType: "limit",
          });
          const tp2NewSlOrderId = newSl.id.toString();
          // New SL placed — now safe to cancel the old BE SL
          await tryCancel(trade.slOrderId, "be-sl-after-tp2");
          await db.update(scalperTradesTable).set({ slOrderId: tp2NewSlOrderId }).where(eq(scalperTradesTable.id, id));
          trade = { ...trade, slOrderId: tp2NewSlOrderId };
          logger.info({ tradeId: id, tp2NewSlOrderId, remainingSlQty, trigger: slFmt.price, limitPrice: slLimFmt.price }, "CHT live: TP2 — new 40%-qty SL stop-limit placed, old BE SL cancelled");
        } catch (err) {
          logger.error({ tradeId: id, err }, "CHT live: TP2 — failed to place new 40%-qty SL; old BE SL preserved");
        }
      }
    }
  }

  // ── Check TP3 (40% final exit + A1: force-close any rounding residual) ─────
  if (trade.tp3OrderId) {
    const result = await checkFill(trade.tp3OrderId);
    if (result?.filled) {
      const closedSoFar     = Number(trade.closedQty ?? 0);
      const tp3FillQty      = result.qty > 0 ? result.qty : qty * 0.40;
      const tp3PnlIncrement = (result.price - (entryPrice ?? 0)) * dir * tp3FillQty;
      const newRealizedPnl  = Number(trade.realizedPnl ?? 0) + tp3PnlIncrement;

      // A1: force-close any rounding residual (> 0.00001 base units)
      let residualPnl = 0;
      const residualQty = qty - closedSoFar - tp3FillQty;
      if (residualQty > 0.00001) {
        try {
          const lp = await getLivePrice(gateSymbol);
          const resiFmt  = await fmtForPair(gateSymbol, lp, residualQty);
          const exitOrder = await placeSpotOrder({
            currencyPair: gateSymbol,
            side:         side === "buy" ? "sell" : "buy",
            amount:       resiFmt.amount,
            type:         "market",
          });
          const resiClose = parseFloat(exitOrder.avg_deal_price || lp.toString());
          residualPnl = (resiClose - (entryPrice ?? 0)) * dir * residualQty;
          logger.info({ tradeId: id, residualQty, resiClose, residualPnl }, "CHT live: TP3 residual force-closed");
        } catch (resiErr) {
          logger.warn({ tradeId: id, residualQty, resiErr }, "CHT live: TP3 residual force-close failed (dust — ignoring)");
        }
      }

      const finalPnl = newRealizedPnl + residualPnl;
      await tryCancel(trade.slOrderId, "sl-after-tp3");

      await db.update(scalperTradesTable).set({
        status:       "closed",
        closePrice:   result.price,
        closeReason:  "tp3",
        closedQty:    qty.toFixed(8),
        remainingQty: "0",
        realizedPnl:  finalPnl.toFixed(4),
        pnl:          parseFloat(finalPnl.toFixed(4)),
        tp1OrderId: null, tp2OrderId: null, tp3OrderId: null, slOrderId: null,
        closedAt:     new Date(),
      }).where(eq(scalperTradesTable.id, id));

      logger.info({ tradeId: id, tp3Price: result.price, finalPnl }, "CHT live: TP3 — trade fully closed");
      if (finalPnl) await updateScalperCompoundBalance(finalPnl);
      return;
    }
  }

  // ── Check SL (close remaining qty at SL fill price) ──────────────────────
  if (trade.slOrderId) {
    const result = await checkFill(trade.slOrderId);
    if (result?.filled) {
      const closedSoFar  = Number(trade.closedQty ?? 0);
      const remainingQty = qty - closedSoFar;
      const slFillQty    = result.qty > 0 ? result.qty : remainingQty;
      const slPnlIncrement = (result.price - (entryPrice ?? 0)) * dir * slFillQty;
      const finalPnl     = Number(trade.realizedPnl ?? 0) + slPnlIncrement;

      await tryCancel(trade.tp2OrderId, "tp2-after-sl");
      await tryCancel(trade.tp3OrderId, "tp3-after-sl");

      await db.update(scalperTradesTable).set({
        status:       "closed",
        closePrice:   result.price,
        closeReason:  "sl",
        closedQty:    qty.toFixed(8),
        remainingQty: "0",
        realizedPnl:  finalPnl.toFixed(4),
        pnl:          parseFloat(finalPnl.toFixed(4)),
        tp1OrderId: null, tp2OrderId: null, tp3OrderId: null, slOrderId: null,
        closedAt:     new Date(),
      }).where(eq(scalperTradesTable.id, id));

      logger.info({ tradeId: id, slPrice: result.price, remainingQty, finalPnl }, "CHT live: SL hit — trade closed");
      if (finalPnl) await updateScalperCompoundBalance(finalPnl);
      return;
    }
  }

  // ── Terminal check: if all exit orders are gone, attempt emergency close ──
  const exitOrderIds = [trade.tp1OrderId, trade.tp2OrderId, trade.tp3OrderId, trade.slOrderId].filter(Boolean);
  const terminalResults = await Promise.all(
    exitOrderIds.map(async (orderId) => {
      const r = await checkFill(orderId);
      return r == null || (r.filled === false && r.terminal);
    }),
  );
  const allTerminal = exitOrderIds.length > 0 && terminalResults.every(Boolean);

  // Update live P&L (unrealized portion)
  let livePrice: number | null = null;
  try {
    livePrice = await getLivePrice(gateSymbol);
    const pnl =
      entryPrice != null && quantity != null
        ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
        : null;
    await db.update(scalperTradesTable)
      .set({ livePrice, pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null })
      .where(eq(scalperTradesTable.id, id));
    logger.debug({ tradeId: id, allTerminal }, "CHT live: exit order terminal check");
  } catch {
    // Non-critical
  }

  // Emergency close: all orders vanished without a detected fill.
  // IMPORTANT: check actual wallet balance first — Gate.io may have cancelled/expired
  // the orders without closing the position (e.g. fee rounding causing BALANCE_NOT_ENOUGH).
  if (allTerminal && quantity != null && quantity > 0 && livePrice != null) {
    for (const oid of exitOrderIds as string[]) {
      try { await cancelPriceTriggeredOrder(oid, gateSymbol); } catch { /* already gone */ }
    }

    const availableBase = await getAvailableBase(gateSymbol);

    if (availableBase < 0) {
      // Could not fetch balance (transient Gate.io error) — do not auto-close; retry next cycle
      logger.error({ tradeId: id, gateSymbol }, "CHT live: terminal orders — balance check failed, keeping open for next cycle");
      await db.update(scalperTradesTable).set({
        tp1OrderId: null, tp2OrderId: null, tp3OrderId: null, slOrderId: null,
        errorMessage: "terminal: all orders gone, balance check failed — sync will retry",
      }).where(eq(scalperTradesTable.id, id));
      return;
    }

    if (availableBase === 0) {
      // Balance gone — TP/SL must have filled and sold the position; close at live price
      const finalPnl = Number(trade.realizedPnl ?? 0) +
        (entryPrice != null
          ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
          : 0);
      await db.update(scalperTradesTable).set({
        status: "closed", livePrice, closePrice: livePrice, closeReason: "terminal",
        pnl: parseFloat(finalPnl.toFixed(4)),
        tp1OrderId: null, tp2OrderId: null, tp3OrderId: null, slOrderId: null,
        closedAt: new Date(),
      }).where(eq(scalperTradesTable.id, id));
      logger.warn({ tradeId: id, livePrice, finalPnl }, "CHT live: terminal orders — balance zero, position closed, trade marked closed at live price");
      await updateScalperCompoundBalance(finalPnl);
      return;
    }

    // Balance present — position is still open on Gate.io. Sell the actual available qty.
    const sellQty = Math.min(quantity, availableBase);
    logger.warn({ tradeId: id, quantity, availableBase, sellQty, gateSymbol }, "CHT live: terminal orders — balance present, attempting market exit");
    try {
      const exitFmt = await fmtForPair(gateSymbol, livePrice, sellQty);
      const exitOrder = await placeSpotOrder({
        currencyPair: gateSymbol,
        side: side === "buy" ? "sell" : "buy",
        amount: exitFmt.amount, type: "market",
      });
      const actualClose = parseFloat(exitOrder.avg_deal_price || livePrice.toString());
      const finalPnl = Number(trade.realizedPnl ?? 0) +
        (entryPrice != null
          ? (side === "buy" ? actualClose - entryPrice : entryPrice - actualClose) * sellQty
          : 0);
      await db.update(scalperTradesTable).set({
        status: "closed", livePrice, closePrice: actualClose, closeReason: "terminal",
        pnl: parseFloat(finalPnl.toFixed(4)),
        tp1OrderId: null, tp2OrderId: null, tp3OrderId: null, slOrderId: null,
        closedAt: new Date(),
      }).where(eq(scalperTradesTable.id, id));
      logger.warn({ tradeId: id, actualClose, finalPnl }, "CHT live: terminal orders — emergency exit placed, trade closed");
      await updateScalperCompoundBalance(finalPnl);
    } catch (exitErr) {
      const exitMsg = exitErr instanceof Error ? exitErr.message : String(exitErr);
      logger.error({ tradeId: id, exitErr: exitMsg, availableBase }, "CHT live: terminal emergency exit failed — keeping open, sync will retry");
      await db.update(scalperTradesTable).set({
        tp1OrderId: null, tp2OrderId: null, tp3OrderId: null, slOrderId: null,
        errorMessage: `terminal: exit failed (${exitMsg}) — sync will retry`,
      }).where(eq(scalperTradesTable.id, id));
    }
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
  const orderChecks: { orderId: string; reason: "tp" | "sl" }[] = [];
  if (trade.tpOrderId) orderChecks.push({ orderId: trade.tpOrderId, reason: "tp" });
  if (trade.slOrderId) orderChecks.push({ orderId: trade.slOrderId, reason: "sl" });

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
          tpOrderId: null, slOrderId: null,
          closedAt: new Date(),
        }).where(eq(scalperTradesTable.id, id));

        logger.info({ tradeId: id, reason, closePrice, filledQty, pnl }, "Scalper: live trade closed");
        if (pnl != null) await updateScalperCompoundBalance(pnl);

        const otherOrderId = reason === "tp" ? trade.slOrderId : trade.tpOrderId;
        if (otherOrderId) {
          try {
            await cancelPriceTriggeredOrder(otherOrderId, gateSymbol);
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
        if (isInGracePeriod(trade.createdAt)) {
          allOrdersTerminal = false;
          logger.info({ tradeId: id, orderId, reason }, "Scalper sync: order not found but within grace period — skipping terminal");
        } else {
          logger.warn({ tradeId: id, orderId, reason }, "Scalper sync: order not found — treating as terminal");
        }
      } else {
        allOrdersTerminal = false;
        logger.warn({ tradeId: id, orderId, err: msg }, "Scalper sync: order check failed (transient)");
      }
    }
  }

  // TP/SL retry if placement failed
  if ((!trade.tpOrderId || !trade.slOrderId) && trade.tpPrice != null && trade.slPrice != null && quantity != null) {
    logger.warn({ tradeId: id }, "Scalper sync: missing TP/SL orders — retrying");
    // Clamp to actual available balance — fee deductions may leave less than DB quantity
    const retryAvailBase = await getAvailableBase(gateSymbol);
    const retryQty = retryAvailBase > 0 ? Math.min(quantity, retryAvailBase) : quantity;
    logger.info({ tradeId: id, quantity, retryAvailBase, retryQty }, "Scalper sync: retry qty resolved");
    const retryUpdates: Record<string, unknown> = {};
    const retryErrors: string[] = [];

    if (!trade.tpOrderId) {
      try {
        const fmt = await fmtForPair(gateSymbol, trade.tpPrice, retryQty);
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
        const slOffsetPct = await getSlLimitOffsetPct();
        const slLimitPriceVal = computeSlLimitPrice(trade.slPrice, side, slOffsetPct);
        const [fmt, slLimFmt] = await Promise.all([
          fmtForPair(gateSymbol, trade.slPrice, retryQty),
          fmtForPair(gateSymbol, slLimitPriceVal, retryQty),
        ]);
        const o = await placePriceTriggeredOrder({
          currencyPair: gateSymbol,
          triggerPrice: fmt.price,
          triggerRule:  side === "buy" ? "<=" : ">=",
          side:         side === "buy" ? "sell" : "buy",
          amount: fmt.amount, orderPrice: slLimFmt.price, orderType: "limit",
        });
        retryUpdates.slOrderId = o.id.toString();
        logger.info({ tradeId: id, slOrderId: o.id, trigger: fmt.price, limitPrice: slLimFmt.price }, "Scalper sync: SL stop-limit retry succeeded");
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
          try { await cancelPriceTriggeredOrder(oid, gateSymbol); } catch { /* gone */ }
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
          tpOrderId: null, slOrderId: null,
          closedAt: new Date(),
        }).where(eq(scalperTradesTable.id, id));

        logger.warn({ tradeId: id, closeReason, closePrice: actualClose }, "Scalper: live closed via price fallback");
        if (pnl != null) await updateScalperCompoundBalance(pnl);
        return;
      }

      // Price is between SL and TP — but if all orders are terminal (not found), check
      // the actual wallet balance to decide if the position is still open or already closed.
      if (allOrdersTerminal && quantity != null && quantity > 0) {
        for (const oid of [trade.tpOrderId, trade.slOrderId].filter(Boolean) as string[]) {
          try { await cancelPriceTriggeredOrder(oid, gateSymbol); } catch { /* already gone */ }
        }

        const availableBase = await getAvailableBase(gateSymbol);

        if (availableBase < 0) {
          // Balance fetch failed — do not auto-close; retry next cycle
          logger.error({ tradeId: id, gateSymbol }, "Scalper: terminal orders — balance check failed, keeping open for next cycle");
          await db.update(scalperTradesTable).set({
            tpOrderId: null, slOrderId: null,
            errorMessage: "terminal: all orders gone, balance check failed — sync will retry",
          }).where(eq(scalperTradesTable.id, id));
          return;
        }

        if (availableBase === 0) {
          // Balance zero — TP/SL filled and sold the position; close at live price
          const pnl =
            entryPrice != null
              ? (side === "buy" ? livePrice - entryPrice : entryPrice - livePrice) * quantity
              : null;
          await db.update(scalperTradesTable).set({
            status: "closed", livePrice, closePrice: livePrice, closeReason: "terminal",
            pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
            tpOrderId: null, slOrderId: null,
            closedAt: new Date(),
          }).where(eq(scalperTradesTable.id, id));
          logger.warn({ tradeId: id, livePrice, pnl }, "Scalper: terminal orders — balance zero, position already closed, marked at live price");
          if (pnl != null) await updateScalperCompoundBalance(pnl);
          return;
        }

        // Balance present — position still open. Sell the actual available qty.
        const sellQty = Math.min(quantity, availableBase);
        logger.warn({ tradeId: id, quantity, availableBase, sellQty, gateSymbol }, "Scalper: terminal orders — balance present, attempting market exit");
        try {
          const exitFmt = await fmtForPair(gateSymbol, livePrice, sellQty);
          const exitOrder = await placeSpotOrder({
            currencyPair: gateSymbol,
            side: side === "buy" ? "sell" : "buy",
            amount: exitFmt.amount, type: "market",
          });
          const actualClose = parseFloat(exitOrder.avg_deal_price || livePrice.toString());
          const pnl =
            entryPrice != null
              ? (side === "buy" ? actualClose - entryPrice : entryPrice - actualClose) * sellQty
              : null;
          await db.update(scalperTradesTable).set({
            status: "closed", livePrice, closePrice: actualClose, closeReason: "terminal",
            pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
            tpOrderId: null, slOrderId: null,
            closedAt: new Date(),
          }).where(eq(scalperTradesTable.id, id));
          logger.warn({ tradeId: id, actualClose, pnl }, "Scalper: terminal orders — emergency exit placed, trade closed");
          if (pnl != null) await updateScalperCompoundBalance(pnl);
          return;
        } catch (exitErr) {
          const exitMsg = exitErr instanceof Error ? exitErr.message : String(exitErr);
          logger.error({ tradeId: id, exitErr: exitMsg, availableBase }, "Scalper: terminal emergency exit failed — keeping open, sync will retry");
          await db.update(scalperTradesTable).set({
            tpOrderId: null, slOrderId: null,
            errorMessage: `terminal: exit failed (${exitMsg}) — sync will retry`,
          }).where(eq(scalperTradesTable.id, id));
          return;
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
      await cancelPriceTriggeredOrder(orderId, gateSymbol);
      logger.info({ tradeId: id, orderId, label }, "Micro live: cancelled order");
    } catch { /* already gone */ }
  }

  async function checkFill(
    orderId: string | null | undefined,
  ): Promise<{ filled: true; price: number } | { filled: false; terminal: boolean } | null> {
    if (!orderId) return null;
    try {
      const order = await getPriceTriggeredOrder(orderId, gateSymbol);
      if (order.status === "finish") {
        const price = parseFloat(order.put.avg_deal_price || order.put.price);
        return { filled: true, price };
      }
      if (order.status === "open") return { filled: false, terminal: false };
      return { filled: false, terminal: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("order not found")) {
        if (isInGracePeriod(trade.createdAt)) return { filled: false, terminal: false };
        return { filled: false, terminal: true };
      }
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
          const microAvailBase = await getAvailableBase(gateSymbol);
          const microEffectiveQty = microAvailBase > 0 ? Math.min(quantity ?? 0, microAvailBase) : (quantity ?? 0);
          const microBeSlQty = microEffectiveQty * 0.50;
          const slOffsetPct = await getSlLimitOffsetPct();
          const slLimitPriceVal = computeSlLimitPrice(entryPrice, side, slOffsetPct);
          const [slFmt, slLimFmt] = await Promise.all([
            fmtForPair(gateSymbol, entryPrice, microBeSlQty > 0 ? microBeSlQty : remainingQty),
            fmtForPair(gateSymbol, slLimitPriceVal, microBeSlQty > 0 ? microBeSlQty : remainingQty),
          ]);
          const slRule = side === "buy" ? "<=" : ">=";
          const exitSide = side === "buy" ? "sell" : "buy";
          const newSl = await placePriceTriggeredOrder({
            currencyPair: gateSymbol,
            triggerPrice: slFmt.price, triggerRule: slRule,
            side: exitSide, amount: slFmt.amount,
            orderPrice: slLimFmt.price, orderType: "limit",
          });
          newSlOrderId = newSl.id.toString();
          logger.info({ tradeId: id, newSlOrderId, trigger: slFmt.price, limitPrice: slLimFmt.price }, "Micro live: TP1 hit — break-even SL stop-limit placed");
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
        tp1OrderId: null, tp2OrderId: null, slOrderId: null,
        closedAt: new Date(),
      }).where(eq(scalperTradesTable.id, id));

      logger.info({ tradeId: id, reason, closePrice, pnl }, "Micro live: trade closed");
      if (pnl != null) await updateScalperCompoundBalance(pnl);

      const others = exitChecks.filter(c => c.orderId && c.orderId !== orderId).map(c => c.orderId!);
      for (const oid of others) await tryCancel(oid, "companion");
      return;
    }
  }

  // ── Terminal check: if all exit orders are gone, attempt emergency close ──
  const microExitOrderIds = [trade.tp1OrderId, trade.tp2OrderId, trade.slOrderId].filter(Boolean);
  const microTerminalResults = await Promise.all(
    microExitOrderIds.map(async (orderId) => {
      const r = await checkFill(orderId);
      return r == null || (r.filled === false && r.terminal);
    }),
  );
  const microAllTerminal = microExitOrderIds.length > 0 && microTerminalResults.every(Boolean);

  // Update live P&L
  let microLivePrice: number | null = null;
  try {
    microLivePrice = await getLivePrice(gateSymbol);
    const pnl =
      entryPrice != null && quantity != null
        ? (side === "buy" ? microLivePrice - entryPrice : entryPrice - microLivePrice) * quantity
        : null;
    await db.update(scalperTradesTable)
      .set({ livePrice: microLivePrice, pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null })
      .where(eq(scalperTradesTable.id, id));
  } catch { /* non-critical */ }

  if (microAllTerminal && quantity != null && quantity > 0 && microLivePrice != null) {
    for (const oid of microExitOrderIds as string[]) {
      try { await cancelPriceTriggeredOrder(oid, gateSymbol); } catch { /* already gone */ }
    }

    const availableBase = await getAvailableBase(gateSymbol);

    if (availableBase < 0) {
      // Balance fetch failed — keep open, retry next cycle
      logger.error({ tradeId: id, gateSymbol }, "Micro live: terminal orders — balance check failed, keeping open for next cycle");
      await db.update(scalperTradesTable).set({
        tp1OrderId: null, tp2OrderId: null, slOrderId: null,
        errorMessage: "terminal: all orders gone, balance check failed — sync will retry",
      }).where(eq(scalperTradesTable.id, id));
      return;
    }

    if (availableBase === 0) {
      // Balance zero — position already closed by TP/SL; close DB record at live price
      const pnl =
        entryPrice != null
          ? (side === "buy" ? microLivePrice - entryPrice : entryPrice - microLivePrice) * quantity
          : null;
      await db.update(scalperTradesTable).set({
        status: "closed", livePrice: microLivePrice, closePrice: microLivePrice, closeReason: "terminal",
        pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
        tp1OrderId: null, tp2OrderId: null, slOrderId: null,
        closedAt: new Date(),
      }).where(eq(scalperTradesTable.id, id));
      logger.warn({ tradeId: id, microLivePrice, pnl }, "Micro live: terminal orders — balance zero, position closed, marked at live price");
      if (pnl != null) await updateScalperCompoundBalance(pnl);
      return;
    }

    // Balance present — position still open. Sell the actual available qty.
    const sellQty = Math.min(quantity, availableBase);
    logger.warn({ tradeId: id, quantity, availableBase, sellQty, gateSymbol }, "Micro live: terminal orders — balance present, attempting market exit");
    try {
      const exitFmt = await fmtForPair(gateSymbol, microLivePrice, sellQty);
      const exitOrder = await placeSpotOrder({
        currencyPair: gateSymbol,
        side: side === "buy" ? "sell" : "buy",
        amount: exitFmt.amount, type: "market",
      });
      const actualClose = parseFloat(exitOrder.avg_deal_price || microLivePrice.toString());
      const pnl =
        entryPrice != null
          ? (side === "buy" ? actualClose - entryPrice : entryPrice - actualClose) * sellQty
          : null;
      await db.update(scalperTradesTable).set({
        status: "closed", livePrice: microLivePrice, closePrice: actualClose, closeReason: "terminal",
        pnl: pnl != null ? parseFloat(pnl.toFixed(4)) : null,
        tp1OrderId: null, tp2OrderId: null, slOrderId: null,
        closedAt: new Date(),
      }).where(eq(scalperTradesTable.id, id));
      logger.warn({ tradeId: id, actualClose, pnl }, "Micro live: terminal orders — emergency exit placed, trade closed");
      if (pnl != null) await updateScalperCompoundBalance(pnl);
    } catch (exitErr) {
      const exitMsg = exitErr instanceof Error ? exitErr.message : String(exitErr);
      logger.error({ tradeId: id, exitErr: exitMsg, availableBase }, "Micro live: terminal emergency exit failed — keeping open, sync will retry");
      await db.update(scalperTradesTable).set({
        tp1OrderId: null, tp2OrderId: null, slOrderId: null,
        errorMessage: `terminal: exit failed (${exitMsg}) — sync will retry`,
      }).where(eq(scalperTradesTable.id, id));
    }
  }
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

  // Process trades sequentially — concurrent Promise.allSettled lets two sync
  // ticks overlap on the same trade, causing double P&L credit on compound
  // balance when both detect a terminal condition at the same millisecond.
  for (const trade of openTrades) {
    try {
      await syncScalperTrade(trade);
    } catch (err) {
      logger.error({ err, tradeId: trade.id }, "Scalper sync: trade sync failed");
    }
  }

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
