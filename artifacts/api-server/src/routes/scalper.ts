import { Router } from "express";
import { db, scalperConfigTable, scalperTradesTable } from "@workspace/db";
import { eq, desc, count, inArray } from "drizzle-orm";
import { getUsdtBalance, getLivePrice, placeSpotOrder, cancelPriceTriggeredOrder } from "../services/gateio";
import { scalperLastSyncAt } from "../services/scalper-sync";
import { scalperLoopLastRunAt, scalperLoopLastSignalCount, runScalperScan } from "../services/scalper-loop";
import { getTopUsdtSymbols, fetchCandles, computeBB, computeRSI, computeVolumeRatio } from "../services/scalper-signals";

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────

router.get("/config", async (req, res): Promise<void> => {
  let [config] = await db.select().from(scalperConfigTable).limit(1);
  if (!config) {
    [config] = await db.insert(scalperConfigTable).values({ id: 1 }).returning();
  }
  res.json(config);
});

router.put("/config", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const allowed = [
    "enabled", "paperMode", "longOnly",
    "positionSizeUsdt", "positionSizePct", "targetProfitUsdt", "slPct",
    "maxOpenTrades", "cooldownMinutes",
    "bbPeriod", "bbStdDev",
    "rsiPeriod", "rsiOversold", "rsiOverbought",
    "volumeSpikeMultiplier",
    "compoundingEnabled", "compoundBalance",
    "symbolAllowlist",
  ];
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (key in body && body[key] !== undefined) update[key] = body[key];
  }

  if (body["compoundingEnabled"] === true) {
    const [existing] = await db.select().from(scalperConfigTable).limit(1);
    if (existing && existing.compoundBalance == null) {
      update["compoundBalance"] = existing.positionSizeUsdt;
    }
  }

  const [existing] = await db.select().from(scalperConfigTable).limit(1);
  let config;
  if (!existing) {
    [config] = await db.insert(scalperConfigTable).values({ id: 1, ...update }).returning();
  } else {
    [config] = await db.update(scalperConfigTable).set(update).where(eq(scalperConfigTable.id, existing.id)).returning();
  }
  req.log.info({ enabled: config.enabled, paperMode: config.paperMode }, "Scalper config updated");
  res.json(config);
});

// ── Status ────────────────────────────────────────────────────────────────────

router.get("/status", async (req, res): Promise<void> => {
  const [config] = await db.select().from(scalperConfigTable).limit(1);
  const apiConfigured = !!(process.env.GATEIO_API_KEY && process.env.GATEIO_API_SECRET);

  const [openRow] = await db.select({ c: count() }).from(scalperTradesTable).where(inArray(scalperTradesTable.status, ["open", "paper"]));
  const [totalRow] = await db.select({ c: count() }).from(scalperTradesTable);

  let usdtBalance: number | null = null;
  if (apiConfigured) {
    try { usdtBalance = await getUsdtBalance(); } catch { /* ignore */ }
  }

  res.json({
    enabled: config?.enabled ?? false,
    paperMode: config?.paperMode ?? true,
    usdtBalance,
    openTrades: Number(openRow?.c ?? 0),
    totalTrades: Number(totalRow?.c ?? 0),
    apiConfigured,
    lastSyncAt: scalperLastSyncAt,
    lastScanAt: scalperLoopLastRunAt,
    lastSignalCount: scalperLoopLastSignalCount,
  });
});

// ── Trades ────────────────────────────────────────────────────────────────────

router.get("/trades", async (req, res): Promise<void> => {
  const limit = Math.min(parseInt((req.query["limit"] as string) || "50"), 200);
  const offset = parseInt((req.query["offset"] as string) || "0");
  const status = (req.query["status"] as string) || undefined;

  let query = db.select().from(scalperTradesTable).$dynamic();
  if (status) {
    query = query.where(eq(scalperTradesTable.status, status)) as typeof query;
  }

  const trades = await query.orderBy(desc(scalperTradesTable.createdAt)).limit(limit).offset(offset);
  res.json(trades);
});

router.delete("/trades/:id/cancel", async (req, res): Promise<void> => {
  const tradeId = parseInt(req.params["id"]);
  const [trade] = await db.select().from(scalperTradesTable).where(eq(scalperTradesTable.id, tradeId));
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }

  if (!["open", "paper"].includes(trade.status)) {
    res.status(400).json({ error: "Trade is not open" });
    return;
  }

  let exitPrice: number | null = null;
  let exitError: string | null = null;

  if (!trade.paperMode) {
    // 1. Cancel TP/SL trigger orders so they don't fire after we exit
    const cancelIds = [trade.tpOrderId, trade.slOrderId].filter(Boolean) as string[];
    for (const orderId of cancelIds) {
      try { await cancelPriceTriggeredOrder(parseInt(orderId), trade.gateSymbol); } catch { /* ignore */ }
    }

    // 2. Place a market exit order to close the actual position on Gate.io
    if (trade.quantity && trade.quantity > 0) {
      const exitSide = trade.side === "buy" ? "sell" : "buy";
      try {
        // For a sell exit: amount = quantity of base currency held
        // For a buy-back exit (short close): amount = USDT value / price
        let amount: string;
        if (exitSide === "sell") {
          amount = trade.quantity.toFixed(8);
        } else {
          const livePrice = await getLivePrice(trade.gateSymbol);
          amount = (trade.positionSizeUsdt! / livePrice).toFixed(6);
        }
        const exitOrder = await placeSpotOrder({
          currencyPair: trade.gateSymbol,
          side: exitSide,
          amount,
          type: "market",
        });
        exitPrice = parseFloat(exitOrder.avg_deal_price || exitOrder.price);
        req.log.info({ tradeId, gateSymbol: trade.gateSymbol, exitSide, exitPrice }, "Scalper: market exit placed on cancel");
      } catch (err) {
        exitError = err instanceof Error ? err.message : String(err);
        req.log.error({ tradeId, err: exitError }, "Scalper: failed to place exit order on cancel");
      }
    }
  } else {
    // Paper mode: use live price as exit
    try {
      exitPrice = await getLivePrice(trade.gateSymbol);
    } catch { /* ignore */ }
  }

  // Compute final P&L if we have an exit price
  let pnl = trade.pnl ?? null;
  if (exitPrice != null && trade.entryPrice != null && trade.quantity != null) {
    if (trade.side === "buy") {
      pnl = (exitPrice - trade.entryPrice) * trade.quantity;
    } else {
      pnl = (trade.entryPrice - exitPrice) * trade.quantity;
    }
  }

  await db.update(scalperTradesTable).set({
    status: "cancelled",
    closedAt: new Date(),
    closePrice: exitPrice,
    closeReason: "manual",
    pnl: pnl != null ? parseFloat(pnl.toFixed(6)) : null,
  }).where(eq(scalperTradesTable.id, tradeId));

  res.json({ ok: true, exitPrice, exitError });
});

// ── Performance ───────────────────────────────────────────────────────────────

router.get("/performance", async (req, res): Promise<void> => {
  const closed = await db.select().from(scalperTradesTable).where(eq(scalperTradesTable.status, "closed"));
  const wins = closed.filter((t) => (t.pnl ?? 0) > 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const pnls = closed.map((t) => t.pnl ?? 0);

  res.json({
    totalClosed: closed.length,
    wins: wins.length,
    losses: closed.length - wins.length,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    totalPnl: parseFloat(totalPnl.toFixed(4)),
    avgPnl: closed.length > 0 ? parseFloat((totalPnl / closed.length).toFixed(4)) : null,
    bestPnl: pnls.length > 0 ? parseFloat(Math.max(...pnls).toFixed(4)) : null,
    worstPnl: pnls.length > 0 ? parseFloat(Math.min(...pnls).toFixed(4)) : null,
  });
});

// ── Market scan (read-only preview) ──────────────────────────────────────────

router.get("/scan", async (req, res): Promise<void> => {
  const [config] = await db.select().from(scalperConfigTable).limit(1);

  let symbols: string[];
  try {
    symbols = await getTopUsdtSymbols(5);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch top symbols from Gate.io" });
    return;
  }

  const results = await Promise.allSettled(
    symbols.map(async (gateSymbol) => {
      const candles = await fetchCandles(gateSymbol, "5m", 60);
      const closes = candles.map((c) => c.close);
      const volumes = candles.map((c) => c.volume);
      const bbPeriod = config?.bbPeriod ?? 20;
      const bbStdDev = config?.bbStdDev ?? 2.0;
      const rsiPeriod = config?.rsiPeriod ?? 14;

      const bb = computeBB(closes, bbPeriod, bbStdDev);
      const rsi = computeRSI(closes, rsiPeriod);
      const volumeRatio = computeVolumeRatio(volumes);
      const lastClose = closes[closes.length - 1];

      return {
        gateSymbol,
        lastClose,
        bbUpper: parseFloat(bb.upper.toFixed(8)),
        bbLower: parseFloat(bb.lower.toFixed(8)),
        bbMid: parseFloat(bb.mid.toFixed(8)),
        rsi: parseFloat(rsi.toFixed(2)),
        volumeRatio: parseFloat(volumeRatio.toFixed(3)),
        nearLower: lastClose <= bb.lower * 1.001,
        nearUpper: lastClose >= bb.upper * 0.999,
      };
    })
  );

  const rows = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return { gateSymbol: symbols[i], error: String((r as PromiseRejectedResult).reason) };
  });

  res.json({ symbols: rows, scannedAt: new Date() });
});

// ── Manual scan trigger ───────────────────────────────────────────────────────

router.post("/scan/trigger", async (req, res): Promise<void> => {
  runScalperScan().catch((err) => req.log.error({ err }, "Manual scalper scan failed"));
  res.json({ ok: true, message: "Scan triggered" });
});

// ── Scan a single user-specified symbol ──────────────────────────────────────

router.post("/scan/symbol", async (req, res): Promise<void> => {
  const raw = ((req.body as Record<string, unknown>)["symbol"] as string | undefined)?.trim().toUpperCase();
  if (!raw) { res.status(400).json({ error: "symbol is required" }); return; }

  // Normalise: "BTC" → "BTC_USDT", "BTCUSDT" → "BTC_USDT", "BTC_USDT" → "BTC_USDT"
  let gateSymbol: string;
  if (raw.includes("_")) {
    gateSymbol = raw.endsWith("_USDT") ? raw : `${raw}_USDT`;
  } else if (raw.endsWith("USDT")) {
    gateSymbol = `${raw.slice(0, -4)}_USDT`;
  } else {
    gateSymbol = `${raw}_USDT`;
  }

  const [config] = await db.select().from(scalperConfigTable).limit(1);
  const bbPeriod = config?.bbPeriod ?? 20;
  const bbStdDev = config?.bbStdDev ?? 2.0;
  const rsiPeriod = config?.rsiPeriod ?? 14;
  const rsiOversold = config?.rsiOversold ?? 35;
  const rsiOverbought = config?.rsiOverbought ?? 65;
  const volumeSpikeMultiplier = config?.volumeSpikeMultiplier ?? 1.5;

  try {
    const candles = await fetchCandles(gateSymbol, "5m", 60);
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

    const bb = computeBB(closes, bbPeriod, bbStdDev);
    const rsi = computeRSI(closes, rsiPeriod);
    const volumeRatio = computeVolumeRatio(volumes);
    const lastClose = closes[closes.length - 1];

    const hasVolumeSpike = volumeRatio >= volumeSpikeMultiplier;
    const nearLower = lastClose <= bb.lower * 1.001;
    const nearUpper = lastClose >= bb.upper * 0.999;
    const longSignal = lastClose <= bb.lower && rsi <= rsiOversold && hasVolumeSpike;
    const shortSignal = lastClose >= bb.upper && rsi >= rsiOverbought && hasVolumeSpike;

    req.log.info({ gateSymbol, lastClose, rsi, volumeRatio }, "Manual symbol scan");

    res.json({
      gateSymbol,
      lastClose: parseFloat(lastClose.toFixed(8)),
      bbUpper: parseFloat(bb.upper.toFixed(8)),
      bbLower: parseFloat(bb.lower.toFixed(8)),
      bbMid: parseFloat(bb.mid.toFixed(8)),
      rsi: parseFloat(rsi.toFixed(2)),
      volumeRatio: parseFloat(volumeRatio.toFixed(3)),
      nearLower,
      nearUpper,
      longSignal,
      shortSignal,
      hasVolumeSpike,
      scannedAt: new Date(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Failed to fetch data for ${gateSymbol}: ${msg}` });
  }
});

// ── Manual trade entry (force-enter regardless of indicator conditions) ───────

router.post("/trade/manual", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const raw = (body["symbol"] as string | undefined)?.trim().toUpperCase();
  const side = body["side"] as string | undefined;

  if (!raw) { res.status(400).json({ error: "symbol is required" }); return; }
  if (side !== "buy" && side !== "sell") { res.status(400).json({ error: "side must be 'buy' or 'sell'" }); return; }

  let gateSymbol: string;
  if (raw.includes("_")) {
    gateSymbol = raw.endsWith("_USDT") ? raw : `${raw}_USDT`;
  } else if (raw.endsWith("USDT")) {
    gateSymbol = `${raw.slice(0, -4)}_USDT`;
  } else {
    gateSymbol = `${raw}_USDT`;
  }

  const [config] = await db.select().from(scalperConfigTable).limit(1);
  if (!config?.enabled) {
    res.status(400).json({ error: "Scalper bot is disabled — enable it first" });
    return;
  }

  const bbPeriod = config.bbPeriod ?? 20;
  const bbStdDev = config.bbStdDev ?? 2.0;
  const rsiPeriod = config.rsiPeriod ?? 14;

  try {
    const candles = await fetchCandles(gateSymbol, "5m", 60);
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

    const bb = computeBB(closes, bbPeriod, bbStdDev);
    const rsi = computeRSI(closes, rsiPeriod);
    const volumeRatio = computeVolumeRatio(volumes);
    const lastClose = closes[closes.length - 1];
    const symbol = gateSymbol.replace("_USDT", "");

    const signal = {
      symbol,
      gateSymbol,
      side: side as "buy" | "sell",
      entryPrice: lastClose,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      bbMid: bb.mid,
      rsi,
      volumeRatio,
    };

    req.log.info({ gateSymbol, side, lastClose }, "Manual trade entry requested");

    const { executeScalperSignal } = await import("../services/scalper-executor.js");
    const blocked = await executeScalperSignal(signal, { force: true });

    if (blocked) {
      res.status(400).json({ error: blocked });
      return;
    }

    res.json({ ok: true, gateSymbol, side, entryPrice: lastClose });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: msg });
  }
});

export default router;
