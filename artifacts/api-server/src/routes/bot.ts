import { Router } from "express";
import { db, botConfigTable, tradesTable, signalsTable } from "@workspace/db";
import { eq, desc, count, and, inArray, sql } from "drizzle-orm";
import { getUsdtBalance, cancelPriceTriggeredOrder, getLivePrice, toGateSymbol } from "../services/gateio";
import { lastSyncAt } from "../services/sync";
import { executeSignal } from "../services/executor";

const router = Router();

router.get("/config", async (req, res): Promise<void> => {
  let [config] = await db.select().from(botConfigTable).limit(1);
  if (!config) {
    [config] = await db.insert(botConfigTable).values({ id: 1 }).returning();
  }
  res.json(config);
});

router.put("/config", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const allowed = [
    "enabled", "paperMode", "longOnly",
    "tradingMode", "compoundingEnabled", "compoundBalance",
    "positionSizeUsdt", "minConfW", "minGrade",
    "allowedSymbols", "maxOpenTrades", "cooldownMinutes",
    "slEnabled", "tp1Enabled", "tp2Enabled", "tp3Enabled",
    "tp1Pct", "tp2Pct", "tp3Pct",
  ];
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (key in body && body[key] !== undefined) {
      update[key] = body[key];
    }
  }

  // When enabling compounding for the first time, seed compoundBalance from positionSizeUsdt
  if (body["compoundingEnabled"] === true) {
    const [existing] = await db.select().from(botConfigTable).limit(1);
    if (existing && existing.compoundBalance == null) {
      update["compoundBalance"] = existing.positionSizeUsdt;
    }
  }

  const [existing] = await db.select().from(botConfigTable).limit(1);
  let config;
  if (!existing) {
    [config] = await db.insert(botConfigTable).values({ id: 1, ...update }).returning();
  } else {
    [config] = await db.update(botConfigTable)
      .set(update)
      .where(eq(botConfigTable.id, existing.id))
      .returning();
  }
  req.log.info({ enabled: config.enabled, paperMode: config.paperMode, tradingMode: config.tradingMode }, "Bot config updated");
  res.json(config);
});

router.get("/status", async (req, res): Promise<void> => {
  const [config] = await db.select().from(botConfigTable).limit(1);
  const apiConfigured = !!(process.env.GATEIO_API_KEY && process.env.GATEIO_API_SECRET);

  const [openRow] = await db
    .select({ c: count() })
    .from(tradesTable)
    .where(inArray(tradesTable.status, ["open", "paper"]));

  const [totalRow] = await db.select({ c: count() }).from(tradesTable);

  let usdtBalance: number | null = null;
  if (apiConfigured && config && !config.paperMode) {
    try {
      usdtBalance = await getUsdtBalance();
    } catch {
      usdtBalance = null;
    }
  }

  res.json({
    enabled: config?.enabled ?? false,
    paperMode: config?.paperMode ?? true,
    usdtBalance,
    openTrades: openRow?.c ?? 0,
    totalTrades: totalRow?.c ?? 0,
    apiConfigured,
    lastSyncAt: lastSyncAt?.toISOString() ?? null,
  });
});

router.get("/performance", async (req, res): Promise<void> => {
  const trades = await db.select().from(tradesTable);

  const closed = trades.filter((t) => t.status === "closed");
  const open = trades.filter((t) => t.status === "open" || t.status === "paper");
  const paper = trades.filter((t) => t.paperMode);

  const closedWithPnl = closed.filter((t) => t.pnl != null);
  const wins = closedWithPnl.filter((t) => (t.pnl ?? 0) > 0);

  const longClosed = closedWithPnl.filter((t) => t.side === "buy");
  const shortClosed = closedWithPnl.filter((t) => t.side === "sell");

  const totalPnl = closedWithPnl.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const pnlValues = closedWithPnl.map((t) => t.pnl ?? 0);

  res.json({
    totalTrades: trades.length,
    closedTrades: closed.length,
    openTrades: open.length,
    paperTrades: paper.length,
    winRate: closedWithPnl.length > 0 ? wins.length / closedWithPnl.length : null,
    totalPnl,
    avgPnl: closedWithPnl.length > 0 ? totalPnl / closedWithPnl.length : null,
    bestTrade: pnlValues.length > 0 ? Math.max(...pnlValues) : null,
    worstTrade: pnlValues.length > 0 ? Math.min(...pnlValues) : null,
    longWins: longClosed.filter((t) => (t.pnl ?? 0) > 0).length,
    longLosses: longClosed.filter((t) => (t.pnl ?? 0) <= 0).length,
    shortWins: shortClosed.filter((t) => (t.pnl ?? 0) > 0).length,
    shortLosses: shortClosed.filter((t) => (t.pnl ?? 0) <= 0).length,
  });
});

router.post("/test-signal", async (req, res): Promise<void> => {
  const body = req.body as {
    symbol?: string;
    dir?: string;
    tf?: string;
    grade?: string;
    confW?: number;
  };

  const symbol = (body.symbol ?? "BTCUSDT").toUpperCase();
  const dir = (body.dir ?? "LONG") as "LONG" | "SHORT";
  const tf = body.tf ?? "4H";
  const grade = body.grade ?? "A+ Setup";
  const confW = body.confW ?? 75;

  const gateSymbol = toGateSymbol(symbol);
  let price = 0;
  try {
    price = await getLivePrice(gateSymbol);
  } catch (err) {
    req.log.warn({ symbol, err }, "Test signal: could not fetch live price, using 0");
  }

  const slPct = dir === "LONG" ? 0.97 : 1.03;
  const tp1Pct = dir === "LONG" ? 1.02 : 0.98;
  const tp2Pct = dir === "LONG" ? 1.04 : 0.96;
  const tp3Pct = dir === "LONG" ? 1.07 : 0.93;

  const sl = price > 0 ? +(price * slPct).toFixed(2) : null;
  const tp1 = price > 0 ? +(price * tp1Pct).toFixed(2) : null;
  const tp2 = price > 0 ? +(price * tp2Pct).toFixed(2) : null;
  const tp3 = price > 0 ? +(price * tp3Pct).toFixed(2) : null;

  const [signal] = await db.insert(signalsTable).values({
    symbol,
    tf,
    dir,
    mode: "test",
    grade,
    confW,
    conf: Math.round(confW * 0.95),
    riskTier: confW >= 70 ? "HIGH_CONF" : confW >= 50 ? "MID_CONF" : "LOW_CONF",
    entryRef: price > 0 ? price : null,
    sl,
    tp1,
    tp2,
    tp3,
    rr1: price > 0 && sl ? parseFloat(((tp1! - price) / (price - sl!)).toFixed(2)) : null,
    triggered: true,
    blockReason: "OK",
    rawPayload: { _test: true, symbol, dir, tf, grade, confW, livePrice: price },
  }).returning();

  req.log.info({ id: signal.id, symbol, dir, price }, "Test signal created");
  res.status(201).json(signal);

  executeSignal(signal).catch((err: unknown) => {
    req.log.error({ err, signalId: signal.id }, "Test signal executor error");
  });
});

router.get("/equity-curve", async (req, res): Promise<void> => {
  const closed = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.status, "closed"))
    .orderBy(tradesTable.closedAt);

  let cumulative = 0;
  const points = closed
    .filter((t) => t.closedAt != null && t.pnl != null)
    .map((t) => {
      cumulative += t.pnl!;
      const cost = t.entryPrice != null && t.quantity != null ? t.entryPrice * t.quantity : t.positionSizeUsdt;
      const returnPct = cost && cost > 0 ? (t.pnl! / cost) * 100 : null;
      return {
        date: t.closedAt!.toISOString(),
        pnl: t.pnl!,
        cumulative,
        symbol: t.symbol,
        closeReason: t.closeReason ?? null,
        returnPct,
      };
    });

  const totalReturnPct =
    points.length > 0 && points[0].returnPct != null
      ? points.reduce((sum, p) => sum + (p.returnPct ?? 0), 0)
      : null;

  res.json({ points, totalPnl: cumulative, totalReturnPct });
});

// IMPORTANT: must come before /trades/:id
router.get("/trades/by-signal/:signalId", async (req, res): Promise<void> => {
  const signalId = parseInt(req.params.signalId);
  const [trade] = await db
    .select()
    .from(tradesTable)
    .where(eq(tradesTable.signalId, signalId))
    .orderBy(desc(tradesTable.createdAt))
    .limit(1);
  if (!trade) {
    res.status(404).json({ error: "No trade for this signal" });
    return;
  }
  res.json(trade);
});

router.get("/trades", async (req, res): Promise<void> => {
  const limit = parseInt(String(req.query.limit ?? 50));
  const offset = parseInt(String(req.query.offset ?? 0));
  const status = req.query.status as string | undefined;

  const where = status ? eq(tradesTable.status, status) : undefined;

  const [trades, [{ total }]] = await Promise.all([
    db.select().from(tradesTable)
      .where(where)
      .orderBy(desc(tradesTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(tradesTable).where(where),
  ]);

  res.json({ trades, total });
});

router.get("/trades/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, id));
  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }
  res.json(trade);
});

router.delete("/trades/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, id));

  if (!trade) {
    res.status(404).json({ error: "Trade not found" });
    return;
  }

  if (!trade.paperMode) {
    const toCancel = [trade.slOrderId, trade.tp1OrderId, trade.tp2OrderId, trade.tp3OrderId]
      .filter((id): id is string => id != null);

    for (const orderId of toCancel) {
      try {
        await cancelPriceTriggeredOrder(parseInt(orderId), trade.gateSymbol);
        req.log.info({ tradeId: id, orderId }, "Cancelled SL/TP order");
      } catch (err) {
        req.log.warn({ tradeId: id, orderId, err }, "Failed to cancel order");
      }
    }
  }

  const [updated] = await db.update(tradesTable)
    .set({ status: "cancelled", closeReason: "manual", closedAt: new Date() })
    .where(eq(tradesTable.id, id))
    .returning();

  res.json(updated);
});

export default router;
