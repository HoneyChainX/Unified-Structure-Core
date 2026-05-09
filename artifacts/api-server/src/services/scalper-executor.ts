/**
 * Scalper executor — takes a confirmed ScalperSignal and:
 *   1. Applies all guards (enabled, max open, cooldown, duplicate)
 *   2. Sizes the position (or uses compound balance)
 *   3. In paper mode: records the trade at live price
 *   4. In live mode: places a market entry + TP limit + SL stop-limit on Gate.io
 *
 * TP is set to achieve `targetProfitUsdt` on the full position.
 * SL is set `slPct`% against the entry.
 */

import { db, scalperConfigTable, scalperTradesTable } from "@workspace/db";
import { eq, inArray, and, gte, count } from "drizzle-orm";
import {
  getUsdtBalance,
  getLivePrice,
  placeSpotOrder,
  placePriceTriggeredOrder,
} from "./gateio";
import type { ScalperSignal } from "./scalper-signals";
import { logger } from "../lib/logger";

export interface ExecuteOptions {
  /** When true: skip cooldown and duplicate guards (used for manual entries) */
  force?: boolean;
}

/**
 * Returns null on success, or a human-readable reason string if blocked.
 */
export async function executeScalperSignal(signal: ScalperSignal, opts: ExecuteOptions = {}): Promise<string | null> {
  const { force = false } = opts;

  const [config] = await db.select().from(scalperConfigTable).limit(1);
  if (!config) {
    logger.debug({ symbol: signal.gateSymbol }, "Scalper config not found, skipping");
    return "Scalper config not found";
  }

  if (!config.enabled) {
    logger.debug({ symbol: signal.gateSymbol }, "Scalper disabled, skipping");
    return "Scalper bot is disabled — enable it first";
  }

  // ── Max open trades ──────────────────────────────────────────────────────
  const [openRow] = await db
    .select({ c: count() })
    .from(scalperTradesTable)
    .where(inArray(scalperTradesTable.status, ["open", "paper"]));
  const openCount = Number(openRow?.c ?? 0);
  if (openCount >= config.maxOpenTrades) {
    logger.info({ openCount, maxOpenTrades: config.maxOpenTrades }, "Scalper: max open trades reached");
    return `Max open trades reached (${openCount}/${config.maxOpenTrades})`;
  }

  // ── Duplicate symbol guard (skipped for forced manual entries) ───────────
  if (!force) {
    const [existing] = await db
      .select({ id: scalperTradesTable.id })
      .from(scalperTradesTable)
      .where(
        and(
          eq(scalperTradesTable.gateSymbol, signal.gateSymbol),
          inArray(scalperTradesTable.status, ["open", "paper"])
        )
      )
      .limit(1);

    if (existing) {
      logger.info({ symbol: signal.gateSymbol }, "Scalper: duplicate position, skipping");
      return `Already have an open position for ${signal.gateSymbol}`;
    }
  }

  // ── Cooldown guard (skipped for forced manual entries) ───────────────────
  if (!force && config.cooldownMinutes > 0) {
    const cutoff = new Date(Date.now() - config.cooldownMinutes * 60_000);
    const [recent] = await db
      .select({ id: scalperTradesTable.id })
      .from(scalperTradesTable)
      .where(
        and(
          eq(scalperTradesTable.gateSymbol, signal.gateSymbol),
          gte(scalperTradesTable.createdAt, cutoff)
        )
      )
      .limit(1);

    if (recent) {
      logger.info({ symbol: signal.gateSymbol, cooldownMinutes: config.cooldownMinutes }, "Scalper: cooldown active");
      return `Cooldown active for ${signal.gateSymbol} — wait ${config.cooldownMinutes} min between trades (or use force)`;
    }
  }

  // ── Position sizing ──────────────────────────────────────────────────────
  // Priority: % of live balance > compounding balance > fixed USDT
  let positionSize: number;
  if (config.positionSizePct != null && config.positionSizePct > 0) {
    try {
      const liveBalance = await getUsdtBalance();
      positionSize = liveBalance * (config.positionSizePct / 100);
      logger.debug({ liveBalance, positionSizePct: config.positionSizePct, positionSize }, "Scalper: % position sizing");
    } catch {
      positionSize = config.positionSizeUsdt; // fallback if balance fetch fails
    }
  } else if (config.compoundingEnabled && config.compoundBalance != null) {
    positionSize = config.compoundBalance;
  } else {
    positionSize = config.positionSizeUsdt;
  }

  const entryPrice = signal.entryPrice;
  const quantity = positionSize / entryPrice;

  // TP: achieve targetProfitUsdt on full position
  // price move needed = targetProfitUsdt / quantity
  const tpMove = config.targetProfitUsdt / quantity;
  const tpPrice = signal.side === "buy" ? entryPrice + tpMove : entryPrice - tpMove;

  // SL: slPct% against entry
  const slMove = entryPrice * (config.slPct / 100);
  const slPrice = signal.side === "buy" ? entryPrice - slMove : entryPrice + slMove;

  const sharedFields = {
    symbol: signal.symbol,
    gateSymbol: signal.gateSymbol,
    side: signal.side,
    positionSizeUsdt: parseFloat(positionSize.toFixed(4)),
    slPrice: parseFloat(slPrice.toFixed(8)),
    tpPrice: parseFloat(tpPrice.toFixed(8)),
    bbUpper: signal.bbUpper,
    bbLower: signal.bbLower,
    bbMid: signal.bbMid,
    rsi: signal.rsi,
    volumeRatio: signal.volumeRatio,
    paperMode: config.paperMode,
  };

  const [trade] = await db.insert(scalperTradesTable).values({
    ...sharedFields,
    status: "pending",
  }).returning();

  if (config.paperMode) {
    let livePrice = entryPrice;
    try {
      livePrice = await getLivePrice(signal.gateSymbol);
    } catch (err) {
      logger.warn({ tradeId: trade.id, err }, "Scalper paper: using signal price as fallback");
    }

    const qty = positionSize / livePrice;
    await db.update(scalperTradesTable).set({
      status: "paper",
      entryPrice: livePrice,
      livePrice,
      quantity: parseFloat(qty.toFixed(8)),
      pnl: 0,
    }).where(eq(scalperTradesTable.id, trade.id));

    logger.info(
      { tradeId: trade.id, symbol: signal.symbol, side: signal.side, entryPrice: livePrice, positionSize, tpPrice, slPrice },
      "Scalper paper trade recorded"
    );
    return null;
  }

  // ── Live execution ───────────────────────────────────────────────────────
  try {
    const balance = await getUsdtBalance();
    if (balance < positionSize) {
      throw new Error(`Insufficient balance: ${balance.toFixed(2)} USDT, need ${positionSize}`);
    }

    let livePrice = entryPrice;
    if (signal.side === "sell") {
      livePrice = await getLivePrice(signal.gateSymbol);
    }

    const orderAmount =
      signal.side === "buy"
        ? positionSize.toString()
        : (positionSize / livePrice).toFixed(6);

    const entryOrder = await placeSpotOrder({
      currencyPair: signal.gateSymbol,
      side: signal.side,
      amount: orderAmount,
      type: "market",
    });

    const filledPrice = parseFloat(entryOrder.avg_deal_price || entryOrder.price);
    const filledQty = parseFloat(entryOrder.filled_amount || entryOrder.amount);

    // Recompute TP/SL at actual fill price
    const actualTpMove = config.targetProfitUsdt / filledQty;
    const actualTp = signal.side === "buy" ? filledPrice + actualTpMove : filledPrice - actualTpMove;
    const actualSlMove = filledPrice * (config.slPct / 100);
    const actualSl = signal.side === "buy" ? filledPrice - actualSlMove : filledPrice + actualSlMove;

    await db.update(scalperTradesTable).set({
      entryOrderId: entryOrder.id,
      entryPrice: filledPrice,
      livePrice: filledPrice,
      quantity: filledQty,
      tpPrice: parseFloat(actualTp.toFixed(8)),
      slPrice: parseFloat(actualSl.toFixed(8)),
      status: "open",
      pnl: 0,
    }).where(eq(scalperTradesTable.id, trade.id));

    logger.info({ tradeId: trade.id, filledPrice, filledQty, tpPrice: actualTp, slPrice: actualSl }, "Scalper: entry filled");

    const orderUpdates: { tpOrderId?: string; slOrderId?: string } = {};

    // TP order
    try {
      const tpOrder = await placePriceTriggeredOrder({
        currencyPair: signal.gateSymbol,
        triggerPrice: actualTp.toFixed(8),
        triggerRule: signal.side === "buy" ? ">=" : "<=",
        side: signal.side === "buy" ? "sell" : "buy",
        amount: filledQty.toFixed(8),
        orderPrice: actualTp.toFixed(8),
      });
      orderUpdates.tpOrderId = tpOrder.id.toString();
    } catch (err) {
      logger.warn({ tradeId: trade.id, err }, "Scalper: failed to place TP order");
    }

    // SL order
    try {
      const slOrder = await placePriceTriggeredOrder({
        currencyPair: signal.gateSymbol,
        triggerPrice: actualSl.toFixed(8),
        triggerRule: signal.side === "buy" ? "<=" : ">=",
        side: signal.side === "buy" ? "sell" : "buy",
        amount: filledQty.toFixed(8),
        orderPrice: (signal.side === "buy" ? actualSl * 0.999 : actualSl * 1.001).toFixed(8),
      });
      orderUpdates.slOrderId = slOrder.id.toString();
    } catch (err) {
      logger.warn({ tradeId: trade.id, err }, "Scalper: failed to place SL order");
    }

    if (Object.keys(orderUpdates).length > 0) {
      await db.update(scalperTradesTable).set(orderUpdates).where(eq(scalperTradesTable.id, trade.id));
    }

    return null;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ tradeId: trade.id, symbol: signal.symbol, err: msg }, "Scalper: execution failed");
    await db.update(scalperTradesTable).set({ status: "error", errorMessage: msg }).where(eq(scalperTradesTable.id, trade.id));
    return msg;
  }
}
