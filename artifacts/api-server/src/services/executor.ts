import { db, botConfigTable, tradesTable } from "@workspace/db";
import { eq, inArray, and, gte } from "drizzle-orm";
import type { Signal } from "@workspace/db";
import {
  getUsdtBalance,
  getLivePrice,
  placeSpotOrder,
  placePriceTriggeredOrder,
  toGateSymbol,
} from "./gateio";
import { logger } from "../lib/logger";

const GRADE_ORDER: Record<string, number> = {
  "None": 0,
  "Setup": 1,
  "Strong Setup": 2,
  "A+ Setup": 3,
};

function gradeAtLeast(actual: string | null | undefined, minimum: string): boolean {
  const a = GRADE_ORDER[actual ?? "None"] ?? 0;
  const m = GRADE_ORDER[minimum] ?? 0;
  return a >= m;
}

function roundTo(value: number, decimals: number): string {
  return value.toFixed(decimals);
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

  // Max open trades guard
  const [openCountRow] = await db
    .select({ c: db.$count(tradesTable, inArray(tradesTable.status, ["open", "paper"])) })
    .from(tradesTable)
    .where(inArray(tradesTable.status, ["open", "paper"]));
  const openCount = Number(openCountRow?.c ?? 0);
  if (openCount >= config.maxOpenTrades) {
    logger.info({ signalId: signal.id, openCount, maxOpenTrades: config.maxOpenTrades }, "Max open trades reached, skipping");
    return;
  }

  // Duplicate symbol guard — skip if already holding a position in this symbol
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
    logger.info({ signalId: signal.id, symbol: signal.symbol, existingTradeId: existingTrade.id }, "Duplicate position guard: already in trade for this symbol, skipping");
    return;
  }

  // Cooldown guard — skip if last trade for this symbol was within cooldownMinutes
  if (config.cooldownMinutes > 0) {
    const cutoff = new Date(Date.now() - config.cooldownMinutes * 60_000);
    const [recentTrade] = await db
      .select({ id: tradesTable.id, createdAt: tradesTable.createdAt })
      .from(tradesTable)
      .where(
        and(
          eq(tradesTable.symbol, signal.symbol.toUpperCase()),
          gte(tradesTable.createdAt, cutoff)
        )
      )
      .limit(1);

    if (recentTrade) {
      logger.info(
        { signalId: signal.id, symbol: signal.symbol, cooldownMinutes: config.cooldownMinutes },
        "Cooldown active, skipping"
      );
      return;
    }
  }

  const gateSymbol = toGateSymbol(signal.symbol);
  const side = signal.dir === "LONG" ? "buy" : "sell";

  const [trade] = await db.insert(tradesTable).values({
    signalId: signal.id,
    symbol: signal.symbol.toUpperCase(),
    gateSymbol,
    side,
    status: "pending",
    positionSizeUsdt: config.positionSizeUsdt,
    slPrice: signal.sl ?? undefined,
    tp1Price: signal.tp1 ?? undefined,
    tp2Price: signal.tp2 ?? undefined,
    tp3Price: signal.tp3 ?? undefined,
    paperMode: config.paperMode,
  }).returning();

  if (config.paperMode) {
    // Use live market price for realistic paper simulation
    let livePrice: number | undefined;
    try {
      livePrice = await getLivePrice(gateSymbol);
    } catch (err) {
      logger.warn({ tradeId: trade.id, err }, "Could not fetch live price for paper trade, falling back to entryRef");
      livePrice = signal.entryRef ?? undefined;
    }

    const entryPrice = livePrice;
    const quantity = entryPrice ? config.positionSizeUsdt / entryPrice : undefined;

    await db.update(tradesTable).set({
      status: "paper",
      entryPrice,
      livePrice: entryPrice,
      quantity,
      pnl: 0,
    }).where(eq(tradesTable.id, trade.id));

    logger.info(
      { tradeId: trade.id, symbol: signal.symbol, side, entryPrice, quantity },
      "Paper trade recorded with live price"
    );
    return;
  }

  try {
    const usdtBalance = await getUsdtBalance().catch((err) => {
      throw new Error(`Balance check failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    if (usdtBalance < config.positionSizeUsdt) {
      throw new Error(`Insufficient balance: ${usdtBalance.toFixed(2)} USDT available, ${config.positionSizeUsdt} USDT needed`);
    }

    // For market sell: need base currency amount = USDT / current price
    let livePrice: number | undefined;
    if (side === "sell") {
      livePrice = await getLivePrice(gateSymbol).catch((err) => {
        throw new Error(`Price fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    // market buy: amount = USDT (quote currency); market sell: amount = base currency qty
    const orderAmount =
      side === "buy"
        ? config.positionSizeUsdt.toString()
        : roundTo(config.positionSizeUsdt / livePrice!, 6);

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

    const tpOrders: { tp1OrderId?: string; tp2OrderId?: string; tp3OrderId?: string; slOrderId?: string } = {};

    if (signal.dir === "LONG") {
      if (config.slEnabled && signal.sl) {
        try {
          const slOrder = await placePriceTriggeredOrder({
            currencyPair: gateSymbol,
            triggerPrice: signal.sl.toFixed(8),
            triggerRule: "<=",
            side: "sell",
            amount: quantity.toFixed(8),
            orderPrice: (signal.sl * 0.999).toFixed(8),
          });
          tpOrders.slOrderId = slOrder.id.toString();
          logger.info({ tradeId: trade.id, slOrderId: slOrder.id, slPrice: signal.sl }, "LONG SL order placed");
        } catch (err) {
          logger.warn({ tradeId: trade.id, err }, "Failed to place SL order");
        }
      }

      const tps = [
        { enabled: config.tp1Enabled, price: signal.tp1, pct: config.tp1Pct, key: "tp1OrderId" as const },
        { enabled: config.tp2Enabled, price: signal.tp2, pct: config.tp2Pct, key: "tp2OrderId" as const },
        { enabled: config.tp3Enabled, price: signal.tp3, pct: config.tp3Pct, key: "tp3OrderId" as const },
      ];
      for (const tp of tps) {
        if (tp.enabled && tp.price) {
          try {
            const tpQty = (quantity * (tp.pct / 100)).toFixed(8);
            const tpOrder = await placePriceTriggeredOrder({
              currencyPair: gateSymbol,
              triggerPrice: tp.price.toFixed(8),
              triggerRule: ">=",
              side: "sell",
              amount: tpQty,
              orderPrice: tp.price.toFixed(8),
            });
            tpOrders[tp.key] = tpOrder.id.toString();
            logger.info({ tradeId: trade.id, tpOrderId: tpOrder.id, tpPrice: tp.price }, `${tp.key} order placed`);
          } catch (err) {
            logger.warn({ tradeId: trade.id, err }, `Failed to place ${tp.key} order`);
          }
        }
      }
    } else {
      // SHORT: SL = buy back if price rises, TP = buy back as price falls
      if (config.slEnabled && signal.sl) {
        try {
          const slOrder = await placePriceTriggeredOrder({
            currencyPair: gateSymbol,
            triggerPrice: signal.sl.toFixed(8),
            triggerRule: ">=",
            side: "buy",
            amount: quantity.toFixed(8),
            orderPrice: (signal.sl * 1.001).toFixed(8),
          });
          tpOrders.slOrderId = slOrder.id.toString();
          logger.info({ tradeId: trade.id, slOrderId: slOrder.id, slPrice: signal.sl }, "SHORT SL (buy-back) order placed");
        } catch (err) {
          logger.warn({ tradeId: trade.id, err }, "Failed to place SHORT SL order");
        }
      }

      const tps = [
        { enabled: config.tp1Enabled, price: signal.tp1, pct: config.tp1Pct, key: "tp1OrderId" as const },
        { enabled: config.tp2Enabled, price: signal.tp2, pct: config.tp2Pct, key: "tp2OrderId" as const },
        { enabled: config.tp3Enabled, price: signal.tp3, pct: config.tp3Pct, key: "tp3OrderId" as const },
      ];
      for (const tp of tps) {
        if (tp.enabled && tp.price) {
          try {
            const tpQty = (quantity * (tp.pct / 100)).toFixed(8);
            const tpOrder = await placePriceTriggeredOrder({
              currencyPair: gateSymbol,
              triggerPrice: tp.price.toFixed(8),
              triggerRule: "<=",
              side: "buy",
              amount: tpQty,
              orderPrice: tp.price.toFixed(8),
            });
            tpOrders[tp.key] = tpOrder.id.toString();
            logger.info({ tradeId: trade.id, tpOrderId: tpOrder.id, tpPrice: tp.price }, `SHORT ${tp.key} buy-back order placed`);
          } catch (err) {
            logger.warn({ tradeId: trade.id, err }, `Failed to place SHORT ${tp.key} order`);
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
