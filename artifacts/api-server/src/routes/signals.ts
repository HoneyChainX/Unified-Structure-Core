import { Router } from "express";
import { db, signalsTable } from "@workspace/db";
import { eq, desc, count, avg, and, sql, gte, isNotNull } from "drizzle-orm";
import {
  ReceiveWebhookBody,
  ListSignalsQueryParams,
  GetSignalParams,
  DeleteSignalParams,
} from "@workspace/api-zod";

const router = Router();

// Webhook secret — required unless NODE_ENV=development.
// Send via X-Webhook-Secret header (or ?secret=… query string for legacy TradingView setups).
router.post("/webhook", async (req, res): Promise<void> => {
  const webhookSecret = process.env.WEBHOOK_SECRET;
  const isDev = process.env.NODE_ENV === "development";

  if (!webhookSecret) {
    if (!isDev) {
      req.log.error("Webhook: WEBHOOK_SECRET is not set — refusing all signals");
      res.status(500).json({ error: "Server misconfigured: WEBHOOK_SECRET not set" });
      return;
    }
  } else {
    const headerVal = req.headers["x-webhook-secret"];
    const headerStr = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const provided = headerStr ?? (req.query.secret as string | undefined);
    if (!provided || provided !== webhookSecret) {
      req.log.warn({ ip: req.ip }, "Webhook: rejected — invalid or missing secret");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.query.secret) {
      req.log.warn({ ip: req.ip }, "Webhook: secret in query string — please migrate to X-Webhook-Secret header (query strings can be logged by proxies)");
    }
  }

  const parsed = ReceiveWebhookBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid webhook payload");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const p = parsed.data;

  const triggered =
    p.block_reason === "OK" ||
    p.grade?.includes("TRIGGER") ||
    (p.block_reason == null && p.grade != null && p.grade !== "None");

  const [signal] = await db
    .insert(signalsTable)
    .values({
      symbol: p.symbol,
      tf: p.tf,
      mode: p.mode ?? null,
      macroTf: p.macro_tf ?? null,
      dir: p.dir,
      auth: p.auth ?? null,
      paMss: p.pa_mss ?? null,
      obLow: p.ob_low ?? null,
      obHigh: p.ob_high ?? null,
      zoneLow: p.zone_low ?? null,
      zoneHigh: p.zone_high ?? null,
      entryRef: p.entry_ref ?? null,
      sl: p.sl ?? null,
      rr1: p.rr1 ?? null,
      tp1: p.tp1 ?? null,
      tp2: p.tp2 ?? null,
      tp3: p.tp3 ?? null,
      conf: p.conf ?? null,
      confW: p.conf_w ?? null,
      riskTier: p.risk_tier ?? null,
      grade: p.grade ?? null,
      triggered,
      rot: p.rot ?? null,
      rotScore: p.rot_score ?? null,
      blockReason: p.block_reason ?? null,
      tf2: p.tf2 ?? null,
      tf3: p.tf3 ?? null,
      rawPayload: p as Record<string, unknown>,
    })
    .returning();

  req.log.info({ id: signal.id, symbol: signal.symbol }, "Signal stored");
  res.status(201).json(signal);

  // Fire-and-forget trade execution (don't block the webhook response)
  import("../services/executor").then(({ executeSignal }) => {
    executeSignal(signal).catch((err: unknown) => {
      req.log.error({ err, signalId: signal.id }, "Executor error");
    });
  });
});

router.get("/latest", async (req, res): Promise<void> => {
  const [signal] = await db
    .select()
    .from(signalsTable)
    .orderBy(desc(signalsTable.receivedAt))
    .limit(1);

  if (!signal) {
    res.status(404).json({ error: "No signals yet" });
    return;
  }

  res.json(signal);
});

router.get("/stats", async (req, res): Promise<void> => {
  const [totals] = await db
    .select({
      total: count(),
      triggered: sql<number>`cast(sum(case when ${signalsTable.triggered} then 1 else 0 end) as int)`,
      blocked: sql<number>`cast(sum(case when not ${signalsTable.triggered} then 1 else 0 end) as int)`,
      longs: sql<number>`cast(sum(case when ${signalsTable.dir} = 'LONG' then 1 else 0 end) as int)`,
      shorts: sql<number>`cast(sum(case when ${signalsTable.dir} = 'SHORT' then 1 else 0 end) as int)`,
      avgConfW: avg(signalsTable.confW),
      highConf: sql<number>`cast(sum(case when ${signalsTable.riskTier} = 'HIGH_CONF' then 1 else 0 end) as int)`,
      midConf: sql<number>`cast(sum(case when ${signalsTable.riskTier} = 'MID_CONF' then 1 else 0 end) as int)`,
      lowConf: sql<number>`cast(sum(case when ${signalsTable.riskTier} = 'LOW_CONF' then 1 else 0 end) as int)`,
    })
    .from(signalsTable);

  const symbolBreakdown = await db
    .select({
      symbol: signalsTable.symbol,
      count: count(),
    })
    .from(signalsTable)
    .groupBy(signalsTable.symbol)
    .orderBy(desc(count()));

  const gradeBreakdown = await db
    .select({
      grade: signalsTable.grade,
      count: count(),
    })
    .from(signalsTable)
    .groupBy(signalsTable.grade)
    .orderBy(desc(count()));

  res.json({
    total: totals.total ?? 0,
    triggered: totals.triggered ?? 0,
    blocked: totals.blocked ?? 0,
    longs: totals.longs ?? 0,
    shorts: totals.shorts ?? 0,
    avgConfW: totals.avgConfW ? Number(totals.avgConfW) : null,
    highConf: totals.highConf ?? 0,
    midConf: totals.midConf ?? 0,
    lowConf: totals.lowConf ?? 0,
    symbolBreakdown,
    gradeBreakdown: gradeBreakdown.map((g) => ({
      grade: g.grade ?? "Unknown",
      count: g.count,
    })),
  });
});

router.get("/", async (req, res): Promise<void> => {
  const parsed = ListSignalsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { limit = 50, offset = 0, symbol, dir, triggered } = parsed.data;

  const filters = [];
  if (symbol) filters.push(eq(signalsTable.symbol, symbol));
  if (dir) filters.push(eq(signalsTable.dir, dir));
  if (triggered !== undefined)
    filters.push(eq(signalsTable.triggered, triggered));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const [signals, [{ total }]] = await Promise.all([
    db
      .select()
      .from(signalsTable)
      .where(where)
      .orderBy(desc(signalsTable.receivedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(signalsTable)
      .where(where),
  ]);

  res.json({ signals, total, limit, offset });
});

router.get("/:id", async (req, res): Promise<void> => {
  const parsed = GetSignalParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const [signal] = await db
    .select()
    .from(signalsTable)
    .where(eq(signalsTable.id, parsed.data.id));

  if (!signal) {
    res.status(404).json({ error: "Signal not found" });
    return;
  }

  res.json(signal);
});

router.delete("/:id", async (req, res): Promise<void> => {
  const parsed = DeleteSignalParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  await db
    .delete(signalsTable)
    .where(eq(signalsTable.id, parsed.data.id));

  res.status(204).send();
});

// ── Quality observability (Phase 2) ───────────────────────────────────────
// Histogram + summary stats over signals with a populated `quality` score.
// Window defaults to 7 days; pass ?hours=N to override.
router.get("/quality-stats", async (req, res): Promise<void> => {
  const hours = Math.max(1, Math.min(720, parseInt(String(req.query.hours ?? "168"), 10) || 168));
  const since = new Date(Date.now() - hours * 60 * 60_000);

  const rows = await db
    .select({ quality: signalsTable.quality, triggered: signalsTable.triggered, receivedAt: signalsTable.receivedAt })
    .from(signalsTable)
    .where(and(gte(signalsTable.receivedAt, since), isNotNull(signalsTable.quality)));

  // 10 bins, [0,0.1), [0.1,0.2), … [0.9,1.0]
  const bins = Array.from({ length: 10 }, () => ({ count: 0, triggered: 0 }));
  let sum = 0;
  let triggeredSum = 0;
  let triggeredCount = 0;
  for (const r of rows) {
    const q = r.quality != null ? parseFloat(r.quality) : null;
    if (q == null || !Number.isFinite(q)) continue;
    const clamped = Math.max(0, Math.min(0.9999, q));
    const idx = Math.floor(clamped * 10);
    bins[idx].count++;
    if (r.triggered) bins[idx].triggered++;
    sum += q;
    if (r.triggered) {
      triggeredSum += q;
      triggeredCount++;
    }
  }
  const total = rows.length;
  res.json({
    windowHours: hours,
    since: since.toISOString(),
    total,
    triggered: triggeredCount,
    avgQuality:           total > 0 ? sum / total : null,
    avgQualityTriggered:  triggeredCount > 0 ? triggeredSum / triggeredCount : null,
    histogram: bins.map((b, i) => ({
      bucket: i / 10,
      bucketLabel: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`,
      count: b.count,
      triggered: b.triggered,
    })),
  });
});

export default router;
