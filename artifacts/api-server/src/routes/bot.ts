import { Router } from "express";
import { db, botConfigTable, tradesTable } from "@workspace/db";
import { eq, desc, count, and, sql } from "drizzle-orm";
import { getUsdtBalance, cancelPriceTriggeredOrder } from "../services/gateio";

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
    "enabled", "paperMode", "positionSizeUsdt", "minConfW", "minGrade",
    "allowedSymbols", "slEnabled", "tp1Enabled", "tp2Enabled", "tp3Enabled",
    "tp1Pct", "tp2Pct", "tp3Pct",
  ];
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (key in body && body[key] !== undefined) {
      update[key] = body[key];
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
  req.log.info({ enabled: config.enabled, paperMode: config.paperMode }, "Bot config updated");
  res.json(config);
});

router.get("/status", async (req, res): Promise<void> => {
  const [config] = await db.select().from(botConfigTable).limit(1);
  const apiConfigured = !!(process.env.GATEIO_API_KEY && process.env.GATEIO_API_SECRET);

  const [openRow] = await db
    .select({ c: count() })
    .from(tradesTable)
    .where(eq(tradesTable.status, "open"));

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
  });
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
    .set({ status: "cancelled", closedAt: new Date() })
    .where(eq(tradesTable.id, id))
    .returning();

  res.json(updated);
});

export default router;
