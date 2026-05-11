import { db, botConfigTable, tradesTable } from "@workspace/db";
import { eq, inArray, and, gte, count } from "drizzle-orm";
import type { Signal } from "@workspace/db";
import {
  getUsdtBalance,
  getLivePrice,
  placeSpotOrder,
  placePriceTriggeredOrder,
  fmtForPair,
  toGateSymbol,
} from "./gateio";
import { getMarketStatus } from "./market";
import { logger } from "../lib/logger";
import { notifyTradeOpened } from "./notify";

const GRADE_ORDER: Record<string, number> = {
  "None": 0,
  "Setup": 1,
  "Strong Setup": 2,
  "A+ Setup": 3,
};

const MODE_SIZE_MULTIPLIER: Record<string, number> = {
  all: 1.0,
  scalp: 0.5,
  intraday: 1.0,
  swing: 1.5,
  position: 2.0,
};

function gradeAtLeast(actual: string | null | undefined, minimum: string): boolean {
  const a = GRADE_ORDER[actual ?? "None"] ?? 0;
  const m = GRADE_ORDER[minimum] ?? 0;
  return a >= m;
}

function roundTo(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function modeAllowed(signalMode: string | null | undefined, tradingMode: string): boolean {
  if (tradingMode === "all" || tradingMode === "position") return true;
  if (!signalMode) return true;
  return signalMode.toLowerCase().includes(tradingMode.toLowerCase());
}

export async function executeSignal(signal: Signal): Promise<void> {
  const [config] = await db.select().from(botConfigTable).limit(1);
  if (!config) {
    logger.debug({ signalId: signal.id }, "Bot config not found, skipping execution");
    return;
  }

  if (!config.enabled) {
    logger.debug({ signalId: signal.id }, "Bot disabled, skipping");
    return;
  }

  if (!signal.triggered) {
    logger.debug({ signalId: signal.id }, "Signal not triggered, skipping");
    return;
  }

  if (signal.confW != null && signal.confW < config.minConfW) {
    logger.info({ signalId: signal.id, confW: signal.confW, minConfW: config.minConfW }, "CONF_W below threshold, skipping");
    return;
  }

  if (!gradeAtLeast(signal.grade, config.minGrade)) {
    logger.info({ signalId: signal.id, grade: signal.grade, minGrade: config.minGrade }, "Grade below threshold, skipping");
    return;
  }

  const allowed = config.allowedSymbols
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (allowed.length > 0 && !allowed.includes(signal.symbol.toUpperCase())) {
    logger.info({ signalId: signal.id, symbol: signal.symbol }, "Symbol not in allowlist, skipping");
    return;
  }

  if (!modeAllowed(signal.mode, config.tradingMode)) {
    logger.info(
      { signalId: signal.id, signalMode: signal.mode, tradingMode: config.tradingMode },
      "Trading mode filter: signal mode does not match, skipping"
    );
    return;
  }

  if (config.longOnly && signal.dir === "SHORT") {
    logger.info({ signalId: signal.id }, "Long-only mode: skipping SHORT signal");
    return;
  }

  // ── Regime gating ────────────────────────────────────────────────────────
  if (config.regimeGatingEnabled) {
    try {
      const market = await getMarketStatus();
      if (config.blockOnRiskOff && market.regime === "RISK_OFF") {
        logger.info(
          { signalId: signal.id, regime: market.regime, btcD: market.btcDominance, stableD: market.stableDominance },
          "Regime gating: RISK_OFF detected — skipping signal"
        );
        return;
      }
      logger.debug({ signalId: signal.id, regime: market.regime }, "Regime gating: regime OK, allowing signal");
    } catch (err) {
      logger.warn({ signalId: signal.id, err }, "Regime gating: market status unavailable, allowing signal through");
    }
  }

  // ── Max open trades ───────────────────────────────────────────────────────
  const [openCountRow] = await db
    .select({ c: count() })
    .from(tradesTable)
    .where(inArray(tradesTable.status, ["open", "paper"]));
  const openCount = Number(openCountRow?.c ?? 0);
  if (openCount >= config.maxOpenTrades) {
    logger.info({ signalId: signal.id, openCount, maxOpenTrades: config.maxOpenTrades }, "Max open trades reached, skipping");
    return;
  }

  // ── Duplicate symbol guard ────────────────────────────────────────────────
  const [existingTrade] = await db
    .select({ id: tradesTable.id })
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.symbol, signal.symbol.toUpperCase()),
        inArray(tradesTable.status, ["open", "paper"])
      )
    )
    .limit(1);

  if (existingTrade) {
    logger.info({ signalId: signal.id, symbol: signal.symbol, existingTradeId: existingTrade.id }, "Duplicate position guard: already in trade, skipping");
    return;
  }

  // ── Cooldown guard ────────────────────────────────────────────────────────
  if (config.cooldownMinutes > 0) {
    const cutoff = new Date(Date.now() - config.cooldownMinutes * 60_000);
    const [recentTrade] = await db
      .select({ id: tradesTable.id })
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.symbol, signal.symbol.toUpperCase()),
          gte(tradesTable.createdAt, cutoff)
        )
      )
      .limit(1);

    if (recentTrade) {
      logger.info({ signalId: signal.id, symbol: signal.symbol, cooldownMinutes: config.cooldownMinutes }, "Cooldown active, skipping");
      return;
    }
  }

  // ── Position sizing ───────────────────────────────────────────────────────
  const baseSize = config.compoundingEnabled && config.compoundBalance != null
    ? config.compoundBalance
    : config.positionSizeUsdt;
  const sizeMultiplier = MODE_SIZE_MULTIPLIER[config.tradingMode] ?? 1.0;
  const effectivePositionSize = parseFloat((baseSize * sizeMultiplier).toFixed(2));

  logger.info(
    { signalId: signal.id, baseSize, sizeMultiplier, effectivePositionSize, compounding: config.compoundingEnabled, tradingMode: config.tradingMode },
    "Effective position size determined"
  );

  const gateSymbol = toGateSymbol(signal.symbol);
  const side = signal.dir === "LONG" ? "buy" : "sell";

  const [trade] = await db.insert(tradesTable).values({
    signalId: signal.id,
    symbol: signal.symbol.toUpperCase(),
    gateSymbol,
    side,
    status: "pending",
    positionSizeUsdt: effectivePositionSize,
    slPrice: signal.sl ?? undefined,
    tp1Price: signal.tp1 ?? undefined,
    tp2Price: signal.tp2 ?? undefined,
    tp3Price: signal.tp3 ?? undefined,
    paperMode: config.paperMode,
  }).returning();

  if (config.paperMode) {
    let livePrice: number | undefined;
    try {
      livePrice = await getLivePrice(gateSymbol);
    } catch (err) {
      logger.warn({ tradeId: trade.id, err }, "Could not fetch live price for paper trade, falling back to entryRef");
      livePrice = signal.entryRef ?? undefined;
    }

    const entryPrice = livePrice;
    const quantity = entryPrice ? effectivePositionSize / entryPrice : undefined;

    await db.update(tradesTable).set({
      status: "paper",
      entryPrice,
      livePrice: entryPrice,
      quantity,
      pnl: 0,
    }).where(eq(tradesTable.id, trade.id));

    logger.info(
      { tradeId: trade.id, symbol: signal.symbol, side, entryPrice, quantity, effectivePositionSize },
      "Paper trade recorded"
    );
    notifyTradeOpened({
      symbol: signal.symbol,
      side,
      entryPrice,
      positionSizeUsdt: effectivePositionSize,
      slPrice: signal.sl,
      tp1Price: signal.tp1,
      paperMode: true,
    });
    return;
  }

  try {
    const usdtBalance = await getUsdtBalance().catch((err) => {
      throw new Error(`Balance check failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    if (usdtBalance < effectivePositionSize) {
      throw new Error(`Insufficient balance: ${usdtBalance.toFixed(2)} USDT available, ${effectivePositionSize} USDT needed`);
    }

    let livePrice: number | undefined;
    if (side === "sell") {
      livePrice = await getLivePrice(gateSymbol).catch((err) => {
        throw new Error(`Price fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    const orderAmount =
      side === "buy"
        ? effectivePositionSize.toString()
        : roundTo(effectivePositionSize / livePrice!, 6);

    const entryOrder = await placeSpotOrder({
      currencyPair: gateSymbol,
      side,
      amount: orderAmount,
      type: "market",
    });

    const entryPrice = parseFloat(entryOrder.avg_deal_price || entryOrder.price);
    const quantity = parseFloat(entryOrder.filled_amount || entryOrder.amount);

    await db.update(tradesTable).set({
      entryOrderId: entryOrder.id,
      entryPrice,
      livePrice: entryPrice,
      quantity,
      status: "open",
      pnl: 0,
    }).where(eq(tradesTable.id, trade.id));

    logger.info({ tradeId: trade.id, entryOrderId: entryOrder.id, entryPrice, quantity }, "Entry order placed");
    notifyTradeOpened({
      symbol: signal.symbol,
      side,
      entryPrice,
      positionSizeUsdt: effectivePositionSize,
      slPrice: signal.sl,
      tp1Price: signal.tp1,
      paperMode: false,
    });

    const tpOrders: { tp1OrderId?: string; tp2OrderId?: string; tp3OrderId?: string; slOrderId?: string } = {};

    if (signal.dir === "LONG") {
      if (config.slEnabled && signal.sl) {
        try {
          // fix #2: SL as market-trigger — prevents gap-through on fast moves
          // fix #3: fmtForPair respects Gate.io per-pair amount_precision / price precision
          const slFmt = await fmtForPair(gateSymbol, signal.sl, quantity);
          const slOrder = await placePriceTriggeredOrder({
            currencyPair: gateSymbol,
            triggerPrice: slFmt.price,
            triggerRule: "<=",
            side: "sell",
            amount: slFmt.amount,
            orderPrice: "0",       // fix #2: market order requires price="0"
            orderType: "market",   // fix #2: market fill — guaranteed execution
          });
          tpOrders.slOrderId = slOrder.id.toString();
        } catch (err) {
          // fix #3: loud ERROR — position is now unprotected, must be visible
          logger.error({ tradeId: trade.id, err }, "UNPROTECTED: failed to place LONG SL — trade has no stop-loss protection");
        }
      }

      for (const tp of [
        { enabled: config.tp1Enabled, price: signal.tp1, pct: config.tp1Pct, key: "tp1OrderId" as const },
        { enabled: config.tp2Enabled, price: signal.tp2, pct: config.tp2Pct, key: "tp2OrderId" as const },
        { enabled: config.tp3Enabled, price: signal.tp3, pct: config.tp3Pct, key: "tp3OrderId" as const },
      ]) {
        if (tp.enabled && tp.price) {
          try {
            // fix #3: fmtForPair for pair-specific TP precision
            const tpQty = quantity * (tp.pct / 100);
            const tpFmt = await fmtForPair(gateSymbol, tp.price, tpQty);
            const tpOrder = await placePriceTriggeredOrder({
              currencyPair: gateSymbol,
              triggerPrice: tpFmt.price,
              triggerRule: ">=",
              side: "sell",
              amount: tpFmt.amount,
              orderPrice: tpFmt.price,
            });
            tpOrders[tp.key] = tpOrder.id.toString();
          } catch (err) {
            // fix #3: loud ERROR — TP failure means no profit-take order active
            logger.error({ tradeId: trade.id, err }, `UNPROTECTED: failed to place LONG ${tp.key}`);
          }
        }
      }
    } else {
      if (config.slEnabled && signal.sl) {
        try {
          // fix #2: SL as market-trigger — prevents gap-through on fast moves
          // fix #3: fmtForPair respects Gate.io per-pair precision
          const slFmt = await fmtForPair(gateSymbol, signal.sl, quantity);
          const slOrder = await placePriceTriggeredOrder({
            currencyPair: gateSymbol,
            triggerPrice: slFmt.price,
            triggerRule: ">=",
            side: "buy",
            amount: slFmt.amount,
            orderPrice: "0",       // fix #2: market order requires price="0"
            orderType: "market",   // fix #2: market fill — guaranteed execution
          });
          tpOrders.slOrderId = slOrder.id.toString();
        } catch (err) {
          // fix #3: loud ERROR — position is now unprotected
          logger.error({ tradeId: trade.id, err }, "UNPROTECTED: failed to place SHORT SL — trade has no stop-loss protection");
        }
      }

      for (const tp of [
        { enabled: config.tp1Enabled, price: signal.tp1, pct: config.tp1Pct, key: "tp1OrderId" as const },
        { enabled: config.tp2Enabled, price: signal.tp2, pct: config.tp2Pct, key: "tp2OrderId" as const },
        { enabled: config.tp3Enabled, price: signal.tp3, pct: config.tp3Pct, key: "tp3OrderId" as const },
      ]) {
        if (tp.enabled && tp.price) {
          try {
            // fix #3: fmtForPair for pair-specific SHORT TP precision
            const tpQty = quantity * (tp.pct / 100);
            const tpFmt = await fmtForPair(gateSymbol, tp.price, tpQty);
            const tpOrder = await placePriceTriggeredOrder({
              currencyPair: gateSymbol,
              triggerPrice: tpFmt.price,
              triggerRule: "<=",
              side: "buy",
              amount: tpFmt.amount,
              orderPrice: tpFmt.price,
            });
            tpOrders[tp.key] = tpOrder.id.toString();
          } catch (err) {
            // fix #3: loud ERROR — TP failure means no profit-take order active
            logger.error({ tradeId: trade.id, err }, `UNPROTECTED: failed to place SHORT ${tp.key}`);
          }
        }
      }
    }

    await db.update(tradesTable).set(tpOrders).where(eq(tradesTable.id, trade.id));

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ tradeId: trade.id, signalId: signal.id, err: msg }, "Trade execution failed");
    await db.update(tradesTable).set({ status: "error", errorMessage: msg }).where(eq(tradesTable.id, trade.id));
  }
}
