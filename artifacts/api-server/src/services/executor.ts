import { db, botConfigTable, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Signal } from "@workspace/db";
import {
  getUsdtBalance,
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

  const gateSymbol = toGateSymbol(signal.symbol);
  const side = signal.dir === "LONG" ? "buy" : "sell";

  const [trade] = await db.insert(tradesTable).values({
    signalId: signal.id,
    symbol: signal.symbol,
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
    await db.update(tradesTable).set({
      status: "paper",
      entryPrice: signal.entryRef ?? undefined,
      quantity: signal.entryRef ? config.positionSizeUsdt / signal.entryRef : undefined,
    }).where(eq(tradesTable.id, trade.id));
    logger.info({ tradeId: trade.id, symbol: signal.symbol, side }, "Paper trade recorded");
    return;
  }

  try {
    let usdtBalance = 0;
    try {
      usdtBalance = await getUsdtBalance();
    } catch (err) {
      throw new Error(`Balance check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (usdtBalance < config.positionSizeUsdt) {
      throw new Error(`Insufficient balance: ${usdtBalance.toFixed(2)} USDT available, ${config.positionSizeUsdt} USDT needed`);
    }

    const entryOrder = await placeSpotOrder({
      currencyPair: gateSymbol,
      side,
      amount: config.positionSizeUsdt.toString(),
      type: "market",
    });

    const entryPrice = parseFloat(entryOrder.avg_deal_price || entryOrder.price);
    const quantity = parseFloat(entryOrder.filled_amount || entryOrder.amount);

    await db.update(tradesTable).set({
      entryOrderId: entryOrder.id,
      entryPrice,
      quantity,
      status: "open",
    }).where(eq(tradesTable.id, trade.id));

    logger.info({ tradeId: trade.id, entryOrderId: entryOrder.id, entryPrice, quantity }, "Entry order placed");

    const slOrderId: string | null = null;
    const tp1OrderId: string | null = null;
    const tp2OrderId: string | null = null;
    const tp3OrderId: string | null = null;

    const tpOrders: { tp1OrderId?: string; tp2OrderId?: string; tp3OrderId?: string } = {};

    if (signal.dir === "LONG" && config.slEnabled && signal.sl) {
      try {
        const slOrder = await placePriceTriggeredOrder({
          currencyPair: gateSymbol,
          triggerPrice: signal.sl.toFixed(8),
          triggerRule: "<=",
          side: "sell",
          amount: quantity.toFixed(8),
          orderPrice: (signal.sl * 0.999).toFixed(8),
        });
        await db.update(tradesTable).set({ slOrderId: slOrder.id.toString() }).where(eq(tradesTable.id, trade.id));
        logger.info({ tradeId: trade.id, slOrderId: slOrder.id, slPrice: signal.sl }, "SL order placed");
      } catch (err) {
        logger.warn({ tradeId: trade.id, err }, "Failed to place SL order");
      }
    }

    if (signal.dir === "LONG") {
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

      await db.update(tradesTable).set(tpOrders).where(eq(tradesTable.id, trade.id));
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ tradeId: trade.id, signalId: signal.id, err: msg }, "Trade execution failed");
    await db.update(tradesTable).set({ status: "error", errorMessage: msg }).where(eq(tradesTable.id, trade.id));
  }
}
