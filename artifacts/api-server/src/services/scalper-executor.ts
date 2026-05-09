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
  fmtForPair,
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

  // ── Trading allowlist guard ──────────────────────────────────────────────
  // Note: scanning uses public endpoints (no auth), so any coin can be scanned.
  // This guard only blocks ORDER PLACEMENT for symbols not in the API key allowlist.
  // Force (manual entry) bypasses this guard intentionally.
  if (!force && config.symbolAllowlist) {
    const allowed = config.symbolAllowlist
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(signal.gateSymbol.toUpperCase())) {
      logger.info({ symbol: signal.gateSymbol, allowed }, "Scalper: symbol not in trading allowlist, skipping trade");
      return `${signal.gateSymbol} not in your API trading allowlist — add it or use manual entry to override`;
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

  /** Compute TP/SL from a given fill price, honouring signal geometry (SMC) first, then config. */
  function computeTpSl(fillPrice: number, fillQty: number): { tp: number; sl: number } {
    let tp: number;
    if (config.dynamicTp) {
      // AUTO BB — user explicitly chose this mode; overrides all signal geometry
      // LONG → target upper band; SHORT → target lower band. Works for both BB+RSI and SMC.
      tp = signal.side === "buy" ? signal.bbUpper : signal.bbLower;
    } else if (signal.tpPrice != null) {
      // SMC: absolute Fib level — does not depend on fill price
      tp = signal.tpPrice;
    } else if (config.targetProfitPct != null && config.targetProfitPct > 0) {
      const move = fillPrice * (config.targetProfitPct / 100);
      tp = signal.side === "buy" ? fillPrice + move : fillPrice - move;
    } else {
      const move = config.targetProfitUsdt / fillQty;
      tp = signal.side === "buy" ? fillPrice + move : fillPrice - move;
    }

    let sl: number;
    if (signal.slPrice != null) {
      // SMC: absolute OB-edge level
      sl = signal.slPrice;
    } else {
      const move = fillPrice * (config.slPct / 100);
      sl = signal.side === "buy" ? fillPrice - move : fillPrice + move;
    }

    return { tp, sl };
  }

  // Provisional TP/SL at signal entry price (used for the pending DB row only)
  const provisional = computeTpSl(entryPrice, quantity);

  const sharedFields = {
    symbol: signal.symbol,
    gateSymbol: signal.gateSymbol,
    side: signal.side,
    positionSizeUsdt: parseFloat(positionSize.toFixed(4)),
    slPrice: parseFloat(provisional.sl.toFixed(8)),
    tpPrice: parseFloat(provisional.tp.toFixed(8)),
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
    // Recompute TP/SL at actual live fill price so the sync loop checks the right levels
    const { tp: paperTp, sl: paperSl } = computeTpSl(livePrice, qty);

    await db.update(scalperTradesTable).set({
      status: "paper",
      entryPrice: livePrice,
      livePrice,
      quantity: parseFloat(qty.toFixed(8)),
      tpPrice: parseFloat(paperTp.toFixed(8)),
      slPrice: parseFloat(paperSl.toFixed(8)),
      pnl: 0,
    }).where(eq(scalperTradesTable.id, trade.id));

    logger.info(
      { tradeId: trade.id, symbol: signal.symbol, side: signal.side, entryPrice: livePrice, positionSize, tpPrice: paperTp, slPrice: paperSl },
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

    // Recompute TP/SL at actual fill price — same priority order as computeTpSl.
    let actualTp: number;
    if (config.dynamicTp) {
      // AUTO BB overrides all signal geometry for both BB+RSI and SMC strategies
      actualTp = signal.side === "buy" ? signal.bbUpper : signal.bbLower;
    } else if (signal.tpPrice != null) {
      // SMC: absolute Fib level
      actualTp = signal.tpPrice;
    } else if (config.targetProfitPct != null && config.targetProfitPct > 0) {
      const tpMove = filledPrice * (config.targetProfitPct / 100);
      actualTp = signal.side === "buy" ? filledPrice + tpMove : filledPrice - tpMove;
    } else {
      const tpMove = config.targetProfitUsdt / filledQty;
      actualTp = signal.side === "buy" ? filledPrice + tpMove : filledPrice - tpMove;
    }

    let actualSl: number;
    if (signal.slPrice != null) {
      actualSl = signal.slPrice;
    } else {
      const slMove = filledPrice * (config.slPct / 100);
      actualSl = signal.side === "buy" ? filledPrice - slMove : filledPrice + slMove;
    }

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

    const orderUpdates: { tpOrderId?: string; slOrderId?: string; errorMessage?: string } = {};
    const orderErrors: string[] = [];

    // Fetch pair-specific precision once for both TP and SL orders
    const tpFmt = await fmtForPair(signal.gateSymbol, actualTp, filledQty);
    const slFmt = await fmtForPair(signal.gateSymbol, actualSl, filledQty);

    // TP order — use precision-safe price/amount formatting for Gate.io
    try {
      const tpOrder = await placePriceTriggeredOrder({
        currencyPair: signal.gateSymbol,
        triggerPrice: tpFmt.price,
        triggerRule: signal.side === "buy" ? ">=" : "<=",
        side: signal.side === "buy" ? "sell" : "buy",
        amount: tpFmt.amount,
        orderPrice: tpFmt.price,
      });
      orderUpdates.tpOrderId = tpOrder.id.toString();
      logger.info({ tradeId: trade.id, tpOrderId: tpOrder.id, triggerPrice: tpFmt.price }, "Scalper: TP order placed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ tradeId: trade.id, err: msg }, "Scalper: failed to place TP order");
      orderErrors.push(`TP: ${msg}`);
    }

    // SL order — market type guarantees fill even when price gaps hard through the SL level
    try {
      const slOrder = await placePriceTriggeredOrder({
        currencyPair: signal.gateSymbol,
        triggerPrice: slFmt.price,
        triggerRule: signal.side === "buy" ? "<=" : ">=",
        side: signal.side === "buy" ? "sell" : "buy",
        amount: slFmt.amount,
        orderPrice: "0",   // ignored for market put orders
        orderType: "market",
      });
      orderUpdates.slOrderId = slOrder.id.toString();
      logger.info({ tradeId: trade.id, slOrderId: slOrder.id, triggerPrice: slFmt.price }, "Scalper: SL order placed");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ tradeId: trade.id, err: msg }, "Scalper: failed to place SL order");
      orderErrors.push(`SL: ${msg}`);
    }

    if (orderErrors.length > 0) {
      orderUpdates.errorMessage = orderErrors.join(" | ");
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
