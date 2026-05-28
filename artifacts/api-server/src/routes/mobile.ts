/**
 * Mobile companion app API.
 *
 * Read-only views optimised for small-screen rendering plus device-registration
 * for push notifications. All endpoints require a bearer token matching the
 * MOBILE_API_TOKEN env var. When the env var is unset, requests are rejected
 * to prevent accidental exposure.
 *
 * Routes:
 *   GET  /api/mobile/dashboard          — equity, daily P&L, open count by protection_state
 *   GET  /api/mobile/positions          — open trades across both engines
 *   GET  /api/mobile/signals?since=ISO  — recent signals with quality
 *   POST /api/mobile/devices/register   — register/upsert FCM device token
 *   PUT  /api/mobile/devices/:id        — update per-device preferences
 *   DELETE /api/mobile/devices/:id      — unregister
 *   POST /api/positions/:id/close       — close an open position at market (proxied)
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import {
  db,
  tradesTable,
  scalperTradesTable,
  mobileDevicesTable,
  signalsTable,
  insertMobileDeviceSchema,
  updateMobileDeviceSchema,
} from "@workspace/db";
import { and, eq, desc, gte, inArray, sql } from "drizzle-orm";
import { getUsdtBalance } from "../services/gateio";
import { logger } from "../lib/logger";

const router = Router();

// ── Auth middleware ────────────────────────────────────────────────────────
function mobileAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MOBILE_API_TOKEN;
  if (!expected) {
    res.status(503).json({ error: "Mobile API not configured. Set MOBILE_API_TOKEN." });
    return;
  }
  const header = req.headers.authorization;
  const got = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (got !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}
router.use(mobileAuth);

// ── Dashboard ──────────────────────────────────────────────────────────────
router.get("/dashboard", async (_req, res) => {
  const utcMidnight = new Date();
  utcMidnight.setUTCHours(0, 0, 0, 0);

  const [
    usdtBalance,
    [webhookPnl],
    [scalperPnl],
    webhookOpen,
    scalperOpen,
  ] = await Promise.all([
    getUsdtBalance().catch(() => null),
    db.select({ s: sql<number>`coalesce(sum(${tradesTable.pnl}), 0)` })
      .from(tradesTable)
      .where(and(eq(tradesTable.status, "closed"), gte(tradesTable.closedAt, utcMidnight))),
    db.select({ s: sql<number>`coalesce(sum(${scalperTradesTable.pnl}), 0)` })
      .from(scalperTradesTable)
      .where(and(eq(scalperTradesTable.status, "closed"), gte(scalperTradesTable.closedAt, utcMidnight))),
    db.select({ ps: tradesTable.protectionState, c: sql<number>`count(*)::int` })
      .from(tradesTable)
      .where(inArray(tradesTable.status, ["open", "paper"]))
      .groupBy(tradesTable.protectionState),
    db.select({ ps: scalperTradesTable.protectionState, c: sql<number>`count(*)::int` })
      .from(scalperTradesTable)
      .where(inArray(scalperTradesTable.status, ["open", "paper"]))
      .groupBy(scalperTradesTable.protectionState),
  ]);

  const byProtection: Record<string, number> = {};
  for (const r of [...webhookOpen, ...scalperOpen]) {
    byProtection[r.ps] = (byProtection[r.ps] ?? 0) + Number(r.c);
  }

  res.json({
    equityUsdt: usdtBalance,
    dailyRealisedPnl: Number(webhookPnl?.s ?? 0) + Number(scalperPnl?.s ?? 0),
    openTradesByProtection: byProtection,
    totalOpen: Object.values(byProtection).reduce((a, b) => a + b, 0),
    asOf: new Date().toISOString(),
  });
});

// ── Open positions across both engines ─────────────────────────────────────
router.get("/positions", async (_req, res) => {
  const [webhook, scalper] = await Promise.all([
    db.select({
      id: tradesTable.id,
      engine: sql<string>`'webhook'`,
      symbol: tradesTable.symbol,
      side: tradesTable.side,
      entryPrice: tradesTable.entryPrice,
      livePrice: tradesTable.livePrice,
      quantity: tradesTable.quantity,
      pnl: tradesTable.pnl,
      protectionState: tradesTable.protectionState,
      createdAt: tradesTable.createdAt,
      strategy: sql<string | null>`null`,
      quality: sql<string | null>`null`,
    }).from(tradesTable).where(inArray(tradesTable.status, ["open", "paper"])),
    db.select({
      id: scalperTradesTable.id,
      engine: sql<string>`'scalper'`,
      symbol: scalperTradesTable.symbol,
      side: scalperTradesTable.side,
      entryPrice: scalperTradesTable.entryPrice,
      livePrice: scalperTradesTable.livePrice,
      quantity: scalperTradesTable.quantity,
      pnl: scalperTradesTable.pnl,
      protectionState: scalperTradesTable.protectionState,
      createdAt: scalperTradesTable.createdAt,
      strategy: scalperTradesTable.strategy,
      quality: scalperTradesTable.quality,
    }).from(scalperTradesTable).where(inArray(scalperTradesTable.status, ["open", "paper"])),
  ]);
  res.json({ positions: [...webhook, ...scalper].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)) });
});

// ── Recent signals with quality (ranked) ───────────────────────────────────
router.get("/signals", async (req, res) => {
  const sinceParam = typeof req.query.since === "string" ? req.query.since : null;
  const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 24 * 60 * 60_000);
  if (Number.isNaN(+since)) {
    res.status(400).json({ error: "Invalid 'since' ISO timestamp" });
    return;
  }
  const rows = await db
    .select({
      id: signalsTable.id,
      symbol: signalsTable.symbol,
      tf: signalsTable.tf,
      dir: signalsTable.dir,
      grade: signalsTable.grade,
      quality: signalsTable.quality,
      triggered: signalsTable.triggered,
      receivedAt: signalsTable.receivedAt,
    })
    .from(signalsTable)
    .where(gte(signalsTable.receivedAt, since))
    .orderBy(desc(signalsTable.receivedAt))
    .limit(50);
  res.json({ signals: rows });
});

// ── Device registration ────────────────────────────────────────────────────
router.post("/devices/register", async (req, res) => {
  const parsed = insertMobileDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const now = new Date();
  // Upsert by token — re-registration just refreshes lastSeenAt and preferences.
  const [row] = await db
    .insert(mobileDevicesTable)
    .values({ ...parsed.data, lastSeenAt: now })
    .onConflictDoUpdate({
      target: mobileDevicesTable.token,
      set: { ...parsed.data, lastSeenAt: now },
    })
    .returning();
  logger.info({ deviceId: row.id, platform: row.platform }, "Mobile: device registered");
  res.json(row);
});

router.put("/devices/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid device id" });
    return;
  }
  const parsed = updateMobileDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(mobileDevicesTable)
    .set({ ...parsed.data, lastSeenAt: new Date() })
    .where(eq(mobileDevicesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  res.json(row);
});

router.delete("/devices/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid device id" });
    return;
  }
  await db.delete(mobileDevicesTable).where(eq(mobileDevicesTable.id, id));
  res.json({ ok: true });
});

router.get("/devices", async (_req, res) => {
  const rows = await db.select().from(mobileDevicesTable).orderBy(desc(mobileDevicesTable.registeredAt));
  res.json({ devices: rows });
});

export default router;
