import { Router } from "express";
import { db, scalperConfigTable, scalperTradesTable } from "@workspace/db";
import { eq, desc, count, inArray } from "drizzle-orm";
import { getUsdtBalance, getLivePrice, placeSpotOrder, cancelPriceTriggeredOrder, getApiKeyDetail } from "../services/gateio";
import { scalperLastSyncAt } from "../services/scalper-sync";
import { scalperLoopLastRunAt, scalperLoopLastSignalCount, scalperLiveScanResults, scalperLiveScanAt, runScalperScan } from "../services/scalper-loop";
import { getTopUsdtSymbols, fetchCandles, computeBB, computeRSI, computeVolumeRatio, computeEMA, evaluateSignal } from "../services/scalper-signals";
import { evaluateSMCSignal } from "../services/scalper-signals-smc";

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
    "positionSizeUsdt", "positionSizePct", "targetProfitUsdt", "targetProfitPct", "slPct",
    "maxOpenTrades", "cooldownMinutes",
    "bbPeriod", "bbStdDev",
    "rsiPeriod", "rsiOversold", "rsiOverbought",
    "volumeSpikeMultiplier",
    "emaFilterEnabled", "emaPeriod",
    "compoundingEnabled", "compoundBalance",
    "symbolAllowlist",
    "scanPoolSize",
    "strategy",
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

// ── Gate.io API key allowlist (read from Gate.io directly) ───────────────────

router.get("/gateio-allowlist", async (req, res): Promise<void> => {
  try {
    const detail = await getApiKeyDetail();
    res.json({ pairs: detail.currency_pairs ?? [], unrestricted: (detail.currency_pairs ?? []).length === 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("account permission")) {
      res.status(403).json({ error: "API key missing Account (Read Only) permission — enable it on Gate.io" });
    } else {
      res.status(500).json({ error: msg });
    }
  }
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
  const limit = Math.min(parseInt((req.query["limit"] as string) || "200"), 500);
  const offset = parseInt((req.query["offset"] as string) || "0");
  const statusParam = (req.query["status"] as string) || undefined;

  let query = db.select().from(scalperTradesTable).$dynamic();
  if (statusParam) {
    // Support comma-separated statuses: ?status=open,paper
    const statuses = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) {
      query = query.where(eq(scalperTradesTable.status, statuses[0]!)) as typeof query;
    } else {
      query = query.where(inArray(scalperTradesTable.status, statuses)) as typeof query;
    }
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
  // Include manually-cancelled trades — they have real exit P&L
  const closed = await db.select().from(scalperTradesTable)
    .where(inArray(scalperTradesTable.status, ["closed", "cancelled"]));

  const withPnl = closed.filter((t) => t.pnl != null);
  const wins = withPnl.filter((t) => (t.pnl ?? 0) > 0);
  const losses = withPnl.filter((t) => (t.pnl ?? 0) <= 0);
  const totalPnl = withPnl.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const pnls = withPnl.map((t) => t.pnl ?? 0);

  res.json({
    totalClosed: closed.length,
    withPnl: withPnl.length,
    wins: wins.length,
    losses: losses.length,
    winRate: withPnl.length > 0 ? (wins.length / withPnl.length) * 100 : null,
    totalPnl: parseFloat(totalPnl.toFixed(4)),
    avgPnl: withPnl.length > 0 ? parseFloat((totalPnl / withPnl.length).toFixed(4)) : null,
    bestPnl: pnls.length > 0 ? parseFloat(Math.max(...pnls).toFixed(4)) : null,
    worstPnl: pnls.length > 0 ? parseFloat(Math.min(...pnls).toFixed(4)) : null,
  });
});

// ── Live dual-strategy scan results ──────────────────────────────────────

router.get("/scan/live", (_req, res): void => {
  res.json({ results: scalperLiveScanResults, scannedAt: scalperLiveScanAt });
});

// ── Market scan (read-only preview) ──────────────────────────────────────────

router.get("/scan", async (req, res): Promise<void> => {
  const [config] = await db.select().from(scalperConfigTable).limit(1);
  const strategy = config?.strategy ?? "bb_rsi";
  const longOnly = config?.longOnly ?? false;
  const bbPeriod = config?.bbPeriod ?? 20;
  const bbStdDev = config?.bbStdDev ?? 2.0;
  const rsiPeriod = config?.rsiPeriod ?? 14;

  let symbols: string[];
  try {
    symbols = await getTopUsdtSymbols(5);
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch top symbols from Gate.io" });
    return;
  }

  const results = await Promise.allSettled(
    symbols.map(async (gateSymbol) => {
      // 150 candles covers both BB+RSI (needs ~60) and SMC (needs swing history)
      const candles = await fetchCandles(gateSymbol, "5m", 150);
      const closes = candles.map((c) => c.close);
      const volumes = candles.map((c) => c.volume);

      const bb = computeBB(closes, bbPeriod, bbStdDev);
      const rsi = computeRSI(closes, rsiPeriod);
      const volumeRatio = computeVolumeRatio(volumes);
      const lastClose = closes[closes.length - 1];

      // Evaluate the active strategy engine
      let detectedSignal = null;
      if (strategy === "smc_mss") {
        detectedSignal = evaluateSMCSignal(gateSymbol, candles, { longOnly });
      } else {
        detectedSignal = evaluateSignal(gateSymbol, candles, {
          bbPeriod, bbStdDev, rsiPeriod,
          rsiOversold: config?.rsiOversold ?? 30,
          rsiOverbought: config?.rsiOverbought ?? 70,
          volumeSpikeMultiplier: config?.volumeSpikeMultiplier ?? 1.5,
          longOnly,
          emaFilterEnabled: config?.emaFilterEnabled ?? true,
          emaPeriod: config?.emaPeriod ?? 50,
        });
      }

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
        signalDetected: detectedSignal != null,
        signalSide: detectedSignal?.side ?? null,
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
  const strategy = config?.strategy ?? "bb_rsi";
  const bbPeriod = config?.bbPeriod ?? 20;
  const bbStdDev = config?.bbStdDev ?? 2.0;
  const rsiPeriod = config?.rsiPeriod ?? 14;
  const rsiOversold = config?.rsiOversold ?? 30;
  const rsiOverbought = config?.rsiOverbought ?? 70;
  const volumeSpikeMultiplier = config?.volumeSpikeMultiplier ?? 1.5;
  const emaFilterEnabled = config?.emaFilterEnabled ?? true;
  const emaPeriod = config?.emaPeriod ?? 50;
  const longOnly = config?.longOnly ?? false;

  try {
    // 150 candles — enough for SMC swing detection (12.5h of 5m data)
    const candles = await fetchCandles(gateSymbol, "5m", 150);
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

    // Always compute BB/RSI/EMA for display regardless of active strategy
    const bb = computeBB(closes, bbPeriod, bbStdDev);
    const rsi = computeRSI(closes, rsiPeriod);
    const volumeRatio = computeVolumeRatio(volumes);
    const ema = computeEMA(closes, emaPeriod);
    const lastClose = closes[closes.length - 1];

    const hasVolumeSpike = volumeRatio >= volumeSpikeMultiplier;
    const nearLower = lastClose <= bb.lower * 1.001;
    const nearUpper = lastClose >= bb.upper * 0.999;
    const trendAllowsLong = !emaFilterEnabled || lastClose > ema;
    const trendAllowsShort = !emaFilterEnabled || lastClose < ema;
    const longSignal = lastClose <= bb.lower && rsi <= rsiOversold && hasVolumeSpike && trendAllowsLong;
    const shortSignal = lastClose >= bb.upper && rsi >= rsiOverbought && hasVolumeSpike && trendAllowsShort;

    // ── Run the active strategy evaluator ─────────────────────────────────────
    let detectedSignal: ReturnType<typeof evaluateSignal> = null;
    let smcDetails: { obHigh: number; obLow: number; mssLevel: number } | null = null;

    if (strategy === "smc_mss") {
      const smcSignal = evaluateSMCSignal(gateSymbol, candles, { longOnly });
      if (smcSignal) {
        // SMC repurposes BB fields: bbUpper=OB high, bbLower=OB low, bbMid=MSS level
        smcDetails = {
          obHigh: parseFloat(smcSignal.bbUpper.toFixed(8)),
          obLow:  parseFloat(smcSignal.bbLower.toFixed(8)),
          mssLevel: parseFloat(smcSignal.bbMid.toFixed(8)),
        };
        detectedSignal = smcSignal;
      }
    } else {
      detectedSignal = evaluateSignal(gateSymbol, candles, {
        bbPeriod, bbStdDev, rsiPeriod, rsiOversold, rsiOverbought,
        volumeSpikeMultiplier, longOnly, emaFilterEnabled, emaPeriod,
      });
    }

    req.log.info(
      { gateSymbol, lastClose, rsi, volumeRatio, strategy, signalDetected: detectedSignal != null },
      "Manual symbol scan"
    );

    res.json({
      gateSymbol,
      strategy,
      lastClose: parseFloat(lastClose.toFixed(8)),
      bbUpper: parseFloat(bb.upper.toFixed(8)),
      bbLower: parseFloat(bb.lower.toFixed(8)),
      bbMid: parseFloat(bb.mid.toFixed(8)),
      rsi: parseFloat(rsi.toFixed(2)),
      volumeRatio: parseFloat(volumeRatio.toFixed(3)),
      ema: parseFloat(ema.toFixed(8)),
      emaPeriod,
      emaFilterEnabled,
      trendAllowsLong,
      trendAllowsShort,
      nearLower,
      nearUpper,
      longSignal,
      shortSignal,
      hasVolumeSpike,
      // Detected signal from the active strategy engine
      signal: detectedSignal ? {
        side: detectedSignal.side,
        entryPrice: parseFloat(detectedSignal.entryPrice.toFixed(8)),
        tpPrice: detectedSignal.tpPrice != null ? parseFloat(detectedSignal.tpPrice.toFixed(8)) : null,
        slPrice: detectedSignal.slPrice != null ? parseFloat(detectedSignal.slPrice.toFixed(8)) : null,
        strategy: detectedSignal.strategy ?? strategy,
      } : null,
      smcDetails,
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
  // Optional: pre-computed TP/SL from strategy scan (carries geometry through to executor)
  const tpPriceOverride = typeof body["tpPrice"] === "number" ? (body["tpPrice"] as number) : undefined;
  const slPriceOverride = typeof body["slPrice"] === "number" ? (body["slPrice"] as number) : undefined;
  const strategyHint   = typeof body["strategy"] === "string" ? (body["strategy"] as string) : undefined;

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
      // Pass through strategy geometry when available (SMC Fib TP, OB-edge SL)
      tpPrice: tpPriceOverride,
      slPrice: slPriceOverride,
      strategy: strategyHint,
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

// ── Force-close a stuck live trade ───────────────────────────────────────────
// Cancels any pending TP/SL price-triggered orders on Gate.io, then places a
// market sell/buy to immediately close the spot position. Use for trades where
// the SL limit order failed to fill (e.g. price gapped through the limit level).

router.post("/trade/:id/close", async (req, res): Promise<void> => {
  const tradeId = parseInt(req.params["id"] ?? "");
  if (isNaN(tradeId)) { res.status(400).json({ error: "Invalid trade ID" }); return; }

  const [trade] = await db
    .select()
    .from(scalperTradesTable)
    .where(eq(scalperTradesTable.id, tradeId))
    .limit(1);

  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  if (trade.status !== "open") {
    res.status(400).json({ error: `Trade is not open (status: ${trade.status})` });
    return;
  }
  if (trade.paperMode) {
    res.status(400).json({ error: "Paper trades cannot be force-closed via Gate.io — use Cancel instead" });
    return;
  }
  if (!trade.quantity || !trade.gateSymbol) {
    res.status(400).json({ error: "Trade is missing quantity or symbol — cannot close" });
    return;
  }

  // Cancel any pending TP/SL price-triggered orders (non-fatal if already gone)
  for (const orderId of [trade.tpOrderId, trade.slOrderId]) {
    if (!orderId) continue;
    try {
      await cancelPriceTriggeredOrder(Number(orderId), trade.gateSymbol);
      req.log.info({ tradeId, orderId }, "Force close: cancelled companion order");
    } catch (err) {
      req.log.warn({ tradeId, orderId, err }, "Force close: could not cancel companion order (may already be gone)");
    }
  }

  // Place an immediate market order to close the spot position
  try {
    const closeSide: "buy" | "sell" = trade.side === "buy" ? "sell" : "buy";
    const closeOrder = await placeSpotOrder({
      currencyPair: trade.gateSymbol,
      side: closeSide,
      amount: trade.quantity.toString(),
      type: "market",
    });

    const closePrice = parseFloat(closeOrder.avg_deal_price || closeOrder.price);
    const filledQty  = parseFloat(closeOrder.filled_amount  || closeOrder.amount);
    const pnl =
      trade.entryPrice != null && filledQty > 0
        ? (trade.side === "buy"
            ? closePrice - trade.entryPrice
            : trade.entryPrice - closePrice) * filledQty
        : null;

    await db.update(scalperTradesTable).set({
      status:      "closed",
      closePrice,
      closeReason: "manual",
      pnl:         pnl != null ? parseFloat(pnl.toFixed(4)) : null,
      closedAt:    new Date(),
    }).where(eq(scalperTradesTable.id, tradeId));

    req.log.info({ tradeId, closePrice, filledQty, pnl }, "Scalper: trade force-closed by user");
    res.json({ ok: true, closePrice, filledQty, pnl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ tradeId, err: msg }, "Scalper: force close failed");
    res.status(502).json({ error: msg });
  }
});

export default router;

