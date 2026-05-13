import { Router } from "express";
import { db, botConfigTable, tradesTable, signalsTable } from "@workspace/db";
import { eq, desc, count, and, inArray, gte, sql } from "drizzle-orm";
import { getUsdtBalance, cancelPriceTriggeredOrder, getLivePrice, toGateSymbol, placeSpotOrder, fmtForPair, getSpotAccounts } from "../services/gateio";
import { lastSyncAt } from "../services/sync";
import { executeSignal } from "../services/executor";

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────
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
    "regimeGatingEnabled", "blockOnRiskOff",
    "positionSizeUsdt", "minConfW", "minGrade",
    "allowedSymbols", "maxOpenTrades", "cooldownMinutes",
    "slEnabled", "tp1Enabled", "tp2Enabled", "tp3Enabled",
    "tp1Pct", "tp2Pct", "tp3Pct",
  ];
  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (key in body && body[key] !== undefined) update[key] = body[key];
  }

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
    [config] = await db.update(botConfigTable).set(update).where(eq(botConfigTable.id, existing.id)).returning();
  }
  req.log.info({ enabled: config.enabled, paperMode: config.paperMode, tradingMode: config.tradingMode }, "Bot config updated");
  res.json(config);
});

// ── Status ─────────────────────────────────────────────────────────────────────
router.get("/status", async (req, res): Promise<void> => {
  const [config] = await db.select().from(botConfigTable).limit(1);
  const apiConfigured = !!(process.env.GATEIO_API_KEY && process.env.GATEIO_API_SECRET);

  const [openRow] = await db.select({ c: count() }).from(tradesTable).where(inArray(tradesTable.status, ["open", "paper"]));
  const [totalRow] = await db.select({ c: count() }).from(tradesTable);

  let usdtBalance: number | null = null;
  if (apiConfigured && config && !config.paperMode) {
    try { usdtBalance = await getUsdtBalance(); } catch { usdtBalance = null; }
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

// ── Performance ────────────────────────────────────────────────────────────────
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

// ── Analytics ──────────────────────────────────────────────────────────────────
router.get("/analytics", async (req, res): Promise<void> => {
  // Get all closed trades joined with their signals
  const rows = await db
    .select({
      tradeId: tradesTable.id,
      pnl: tradesTable.pnl,
      side: tradesTable.side,
      closeReason: tradesTable.closeReason,
      symbol: tradesTable.symbol,
      paperMode: tradesTable.paperMode,
      positionSizeUsdt: tradesTable.positionSizeUsdt,
      entryPrice: tradesTable.entryPrice,
      quantity: tradesTable.quantity,
      grade: signalsTable.grade,
      mode: signalsTable.mode,
      tf: signalsTable.tf,
      dir: signalsTable.dir,
      confW: signalsTable.confW,
      rr1: signalsTable.rr1,
    })
    .from(tradesTable)
    .leftJoin(signalsTable, eq(tradesTable.signalId, signalsTable.id))
    .where(eq(tradesTable.status, "closed"));

  type DimRow = { count: number; wins: number; totalPnl: number; pnls: number[] };
  function makeDim() { return (): DimRow => ({ count: 0, wins: 0, totalPnl: 0, pnls: [] }); }

  const byGrade: Record<string, DimRow> = {};
  const byMode: Record<string, DimRow> = {};
  const byTf: Record<string, DimRow> = {};
  const bySymbol: Record<string, DimRow> = {};
  const byDir: Record<string, DimRow> = {};
  const byCloseReason: Record<string, DimRow> = {};

  function acc(map: Record<string, DimRow>, key: string, pnl: number) {
    if (!map[key]) map[key] = makeDim()();
    map[key].count++;
    map[key].totalPnl += pnl;
    map[key].pnls.push(pnl);
    if (pnl > 0) map[key].wins++;
  }

  for (const r of rows) {
    const pnl = r.pnl ?? 0;
    acc(byGrade, r.grade ?? "Unknown", pnl);
    acc(byMode, r.mode ?? "Unknown", pnl);
    acc(byTf, r.tf ?? "Unknown", pnl);
    acc(bySymbol, r.symbol, pnl);
    acc(byDir, r.dir ?? (r.side === "buy" ? "LONG" : "SHORT"), pnl);
    acc(byCloseReason, r.closeReason ?? "unknown", pnl);
  }

  function serialize(map: Record<string, DimRow>) {
    return Object.entries(map)
      .map(([key, v]) => ({
        label: key,
        count: v.count,
        wins: v.wins,
        losses: v.count - v.wins,
        winRate: v.count > 0 ? parseFloat((v.wins / v.count).toFixed(4)) : null,
        totalPnl: parseFloat(v.totalPnl.toFixed(4)),
        avgPnl: v.count > 0 ? parseFloat((v.totalPnl / v.count).toFixed(4)) : null,
        bestPnl: v.pnls.length > 0 ? parseFloat(Math.max(...v.pnls).toFixed(4)) : null,
        worstPnl: v.pnls.length > 0 ? parseFloat(Math.min(...v.pnls).toFixed(4)) : null,
      }))
      .sort((a, b) => b.count - a.count);
  }

  res.json({
    totalClosed: rows.length,
    byGrade: serialize(byGrade),
    byMode: serialize(byMode),
    byTf: serialize(byTf),
    bySymbol: serialize(bySymbol),
    byDir: serialize(byDir),
    byCloseReason: serialize(byCloseReason),
  });
});

// ── Backtest ───────────────────────────────────────────────────────────────────
router.post("/backtest", async (req, res): Promise<void> => {
  const body = req.body as {
    minConfW?: number;
    minGrade?: string;
    tradingMode?: string;
    longOnly?: boolean;
    allowedSymbols?: string;
    positionSizeUsdt?: number;
    regimeGatingEnabled?: boolean;
  };

  // Default to current bot config if params not provided
  const [dbConfig] = await db.select().from(botConfigTable).limit(1);
  const cfg = {
    minConfW: body.minConfW ?? dbConfig?.minConfW ?? 0,
    minGrade: body.minGrade ?? dbConfig?.minGrade ?? "Setup",
    tradingMode: body.tradingMode ?? dbConfig?.tradingMode ?? "all",
    longOnly: body.longOnly ?? dbConfig?.longOnly ?? false,
    allowedSymbols: body.allowedSymbols ?? dbConfig?.allowedSymbols ?? "",
    positionSizeUsdt: body.positionSizeUsdt ?? dbConfig?.positionSizeUsdt ?? 50,
  };

  const GRADE_ORDER: Record<string, number> = { "None": 0, "Setup": 1, "Strong Setup": 2, "A+ Setup": 3 };
  function gradeOk(g: string | null | undefined, min: string) {
    return (GRADE_ORDER[g ?? "None"] ?? 0) >= (GRADE_ORDER[min] ?? 0);
  }
  function modeOk(signalMode: string | null | undefined, tradingMode: string) {
    if (tradingMode === "all" || tradingMode === "position") return true;
    if (!signalMode) return true;
    return signalMode.toLowerCase().includes(tradingMode.toLowerCase());
  }

  const MODE_MULT: Record<string, number> = { all: 1, scalp: 0.5, intraday: 1, swing: 1.5, position: 2 };
  const sizeMultiplier = MODE_MULT[cfg.tradingMode] ?? 1;
  const effectiveSize = cfg.positionSizeUsdt * sizeMultiplier;

  const allowedList = cfg.allowedSymbols
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  // Fetch all triggered signals with their linked trade (if any)
  const signals = await db
    .select({
      id: signalsTable.id,
      symbol: signalsTable.symbol,
      tf: signalsTable.tf,
      mode: signalsTable.mode,
      dir: signalsTable.dir,
      grade: signalsTable.grade,
      confW: signalsTable.confW,
      rr1: signalsTable.rr1,
      entryRef: signalsTable.entryRef,
      sl: signalsTable.sl,
      tp1: signalsTable.tp1,
      tp2: signalsTable.tp2,
      tp3: signalsTable.tp3,
      receivedAt: signalsTable.receivedAt,
      tradePnl: tradesTable.pnl,
      tradeStatus: tradesTable.status,
      tradeId: tradesTable.id,
      tradeCloseReason: tradesTable.closeReason,
    })
    .from(signalsTable)
    .leftJoin(tradesTable, eq(tradesTable.signalId, signalsTable.id))
    .where(eq(signalsTable.triggered, true))
    .orderBy(signalsTable.receivedAt);

  const totalSignals = signals.length;

  // Apply filters
  const matched = signals.filter((s) => {
    if (s.confW != null && s.confW < cfg.minConfW) return false;
    if (!gradeOk(s.grade, cfg.minGrade)) return false;
    if (allowedList.length > 0 && !allowedList.includes(s.symbol.toUpperCase())) return false;
    if (!modeOk(s.mode, cfg.tradingMode)) return false;
    if (cfg.longOnly && s.dir === "SHORT") return false;
    return true;
  });

  // Build per-signal result + equity curves
  type BtTrade = {
    signalId: number;
    receivedAt: string;
    symbol: string;
    dir: string;
    grade: string | null;
    mode: string | null;
    tf: string;
    confW: number | null;
    rr: number | null;
    entryPrice: number | null;
    slPrice: number | null;
    tp1Price: number | null;
    hypotheticalWin: number | null;
    hypotheticalLoss: number | null;
    actualPnl: number | null;
    hasActual: boolean;
    actualCloseReason: string | null;
  };

  const trades: BtTrade[] = [];
  const equityOptimistic: { idx: number; pnl: number }[] = [];
  const equityPessimistic: { idx: number; pnl: number }[] = [];
  const equityActual: { idx: number; pnl: number; symbol: string }[] = [];

  let cumOpt = 0;
  let cumPess = 0;
  let cumActual = 0;

  for (const s of matched) {
    const entry = s.entryRef;
    const sl = s.sl;
    const tp1 = s.tp1;
    let winPnl: number | null = null;
    let lossPnl: number | null = null;

    if (entry && sl && tp1) {
      if (s.dir === "LONG") {
        winPnl = parseFloat((effectiveSize * (tp1 - entry) / entry).toFixed(4));
        lossPnl = parseFloat((-effectiveSize * (entry - sl) / entry).toFixed(4));
      } else {
        winPnl = parseFloat((effectiveSize * (entry - tp1) / entry).toFixed(4));
        lossPnl = parseFloat((-effectiveSize * (sl - entry) / entry).toFixed(4));
      }
    }

    const hasActual = s.tradeStatus === "closed" && s.tradePnl != null;
    const actualPnl = hasActual ? s.tradePnl : null;

    trades.push({
      signalId: s.id,
      receivedAt: s.receivedAt.toISOString(),
      symbol: s.symbol,
      dir: s.dir,
      grade: s.grade,
      mode: s.mode,
      tf: s.tf,
      confW: s.confW,
      rr: s.rr1,
      entryPrice: entry,
      slPrice: sl,
      tp1Price: tp1,
      hypotheticalWin: winPnl,
      hypotheticalLoss: lossPnl,
      actualPnl,
      hasActual,
      actualCloseReason: hasActual ? s.tradeCloseReason : null,
    });

    if (winPnl != null) { cumOpt += winPnl; }
    if (lossPnl != null) { cumPess += lossPnl; }
    equityOptimistic.push({ idx: trades.length, pnl: parseFloat(cumOpt.toFixed(4)) });
    equityPessimistic.push({ idx: trades.length, pnl: parseFloat(cumPess.toFixed(4)) });

    if (hasActual && actualPnl != null) {
      cumActual += actualPnl;
      equityActual.push({ idx: trades.length, pnl: parseFloat(cumActual.toFixed(4)), symbol: s.symbol });
    }
  }

  const actualTrades = trades.filter((t) => t.hasActual && t.actualPnl != null);
  const actualWins = actualTrades.filter((t) => (t.actualPnl ?? 0) > 0);
  const optWins = trades.filter((t) => t.hypotheticalWin != null && t.hypotheticalWin > 0);

  res.json({
    config: cfg,
    totalSignals,
    matchedSignals: matched.length,
    filterRate: totalSignals > 0 ? parseFloat((matched.length / totalSignals).toFixed(4)) : 0,
    trades,
    scenarios: {
      optimistic: {
        totalPnl: parseFloat(cumOpt.toFixed(4)),
        winRate: 1.0,
        tradeCount: trades.filter((t) => t.hypotheticalWin != null).length,
        equityCurve: equityOptimistic,
      },
      pessimistic: {
        totalPnl: parseFloat(cumPess.toFixed(4)),
        winRate: 0.0,
        tradeCount: trades.filter((t) => t.hypotheticalLoss != null).length,
        equityCurve: equityPessimistic,
      },
      actual: {
        totalPnl: parseFloat(cumActual.toFixed(4)),
        winRate: actualTrades.length > 0 ? parseFloat((actualWins.length / actualTrades.length).toFixed(4)) : null,
        tradeCount: actualTrades.length,
        equityCurve: equityActual,
      },
    },
  });
});

// ── Test signal ─────────────────────────────────────────────────────────────
router.post("/test-signal", async (req, res): Promise<void> => {
  const body = req.body as { symbol?: string; dir?: string; tf?: string; grade?: string; confW?: number };
  const symbol = (body.symbol ?? "BTCUSDT").toUpperCase();
  const dir = (body.dir ?? "LONG") as "LONG" | "SHORT";
  const tf = body.tf ?? "4H";
  const grade = body.grade ?? "A+ Setup";
  const confW = body.confW ?? 75;

  const gateSymbol = toGateSymbol(symbol);
  let price = 0;
  try { price = await getLivePrice(gateSymbol); } catch (err) {
    req.log.warn({ symbol, err }, "Test signal: could not fetch live price");
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
    symbol, tf, dir, mode: "test", grade, confW,
    conf: Math.round(confW * 0.95),
    riskTier: confW >= 70 ? "HIGH_CONF" : confW >= 50 ? "MID_CONF" : "LOW_CONF",
    entryRef: price > 0 ? price : null,
    sl, tp1, tp2, tp3,
    rr1: price > 0 && sl ? parseFloat(((tp1! - price) / (price - sl!)).toFixed(2)) : null,
    triggered: true, blockReason: "OK",
    rawPayload: { _test: true, symbol, dir, tf, grade, confW, livePrice: price },
  }).returning();

  req.log.info({ id: signal.id, symbol, dir, price }, "Test signal created");
  res.status(201).json(signal);

  executeSignal(signal).catch((err: unknown) => {
    req.log.error({ err, signalId: signal.id }, "Test signal executor error");
  });
});

// ── Equity curve ───────────────────────────────────────────────────────────────
router.get("/equity-curve", async (req, res): Promise<void> => {
  const closed = await db
    .select().from(tradesTable)
    .where(eq(tradesTable.status, "closed"))
    .orderBy(tradesTable.closedAt);

  let cumulative = 0;
  const points = closed
    .filter((t) => t.closedAt != null && t.pnl != null)
    .map((t) => {
      cumulative += t.pnl!;
      const cost = t.entryPrice != null && t.quantity != null ? t.entryPrice * t.quantity : t.positionSizeUsdt;
      return {
        date: t.closedAt!.toISOString(),
        pnl: t.pnl!,
        cumulative,
        symbol: t.symbol,
        closeReason: t.closeReason ?? null,
        returnPct: cost && cost > 0 ? parseFloat(((t.pnl! / cost) * 100).toFixed(2)) : null,
      };
    });

  const totalReturnPct = points.length > 0
    ? points.reduce((sum, p) => sum + (p.returnPct ?? 0), 0)
    : null;

  res.json({ points, totalPnl: cumulative, totalReturnPct });
});

// ── Trades (IMPORTANT: by-signal BEFORE :id) ──────────────────────────────────
router.get("/trades/by-signal/:signalId", async (req, res): Promise<void> => {
  const signalId = parseInt(req.params.signalId);
  const [trade] = await db
    .select().from(tradesTable)
    .where(eq(tradesTable.signalId, signalId))
    .orderBy(desc(tradesTable.createdAt))
    .limit(1);
  if (!trade) { res.status(404).json({ error: "No trade for this signal" }); return; }
  res.json(trade);
});

router.get("/trades", async (req, res): Promise<void> => {
  const limit = parseInt(String(req.query.limit ?? 50));
  const offset = parseInt(String(req.query.offset ?? 0));
  const status = req.query.status as string | undefined;
  const where = status ? eq(tradesTable.status, status) : undefined;

  const [trades, [{ total }]] = await Promise.all([
    db.select().from(tradesTable).where(where).orderBy(desc(tradesTable.createdAt)).limit(limit).offset(offset),
    db.select({ total: count() }).from(tradesTable).where(where),
  ]);

  res.json({ trades, total });
});

router.get("/trades/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, id));
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }
  res.json(trade);
});

router.delete("/trades/:id", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id);
  const [trade] = await db.select().from(tradesTable).where(eq(tradesTable.id, id));
  if (!trade) { res.status(404).json({ error: "Trade not found" }); return; }

  if (!trade.paperMode && trade.status === "open") {
    // fix #1: close the actual spot position BEFORE cancelling TP/SL orders.
    // Previously only price-triggered orders were cancelled, leaving the spot
    // holding open on Gate.io with funds trapped.
    const closeSide: "buy" | "sell" = trade.side === "buy" ? "sell" : "buy";

    // Determine close quantity: use stored filled quantity, fall back to live balance.
    let closeQty = trade.quantity ?? 0;
    if (closeQty <= 0) {
      try {
        const baseCurrency = trade.gateSymbol.split("_")[0]!;
        const accounts = await getSpotAccounts();
        const acc = accounts.find((a) => a.currency === baseCurrency);
        closeQty = acc ? parseFloat(acc.available) : 0;
        req.log.info({ tradeId: id, baseCurrency, closeQty }, "Cancel: using live balance as close quantity (stored qty was zero)");
      } catch (balErr) {
        req.log.warn({ tradeId: id, balErr }, "Cancel: could not fetch base-currency balance for close");
      }
    }

    if (closeQty > 0) {
      // Fetch live price for fmtForPair (amount precision only; market orders ignore price).
      let livePrice = trade.entryPrice ?? 1;
      try { livePrice = await getLivePrice(trade.gateSymbol); } catch { /* non-fatal */ }

      try {
        const exitFmt = await fmtForPair(trade.gateSymbol, livePrice, closeQty);
        const closeOrder = await placeSpotOrder({
          currencyPair: trade.gateSymbol,
          side: closeSide,
          amount: exitFmt.amount,
          type: "market",
        });
        const closePrice = parseFloat(closeOrder.avg_deal_price || closeOrder.price || "0");
        req.log.info({ tradeId: id, closeSide, closePrice, closeQty }, "Cancel: spot position closed on Gate.io");

        // fix #1: only cancel TP/SL after position is confirmed closed
        for (const orderId of [trade.slOrderId, trade.tp1OrderId, trade.tp2OrderId, trade.tp3OrderId].filter((x): x is string => x != null)) {
          try { await cancelPriceTriggeredOrder(orderId, trade.gateSymbol); }
          catch (err) { req.log.warn({ tradeId: id, orderId, err }, "Cancel: trigger order already gone or filled"); }
        }
      } catch (closeErr) {
        const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        // fix #1: do NOT cancel SL on failure — position is still open, SL must keep guarding
        req.log.error({ tradeId: id, err: msg }, "Cancel: market close FAILED — SL left active, aborting cancel");
        res.status(502).json({
          error: `Gate.io close failed: ${msg}. SL order left active to protect the open position. Use force-close or resolve manually.`,
        });
        return;
      }
    } else {
      // No quantity to close (position already flat) — just cancel trigger orders
      req.log.warn({ tradeId: id }, "Cancel: closeQty=0, skipping market exit, cancelling trigger orders only");
      for (const orderId of [trade.slOrderId, trade.tp1OrderId, trade.tp2OrderId, trade.tp3OrderId].filter((x): x is string => x != null)) {
        try { await cancelPriceTriggeredOrder(orderId, trade.gateSymbol); }
        catch (err) { req.log.warn({ tradeId: id, orderId, err }, "Failed to cancel order"); }
      }
    }
  } else if (!trade.paperMode) {
    // Non-open live trade (e.g. error/pending): cancel any residual trigger orders only
    for (const orderId of [trade.slOrderId, trade.tp1OrderId, trade.tp2OrderId, trade.tp3OrderId].filter((x): x is string => x != null)) {
      try { await cancelPriceTriggeredOrder(orderId, trade.gateSymbol); }
      catch (err) { req.log.warn({ tradeId: id, orderId, err }, "Failed to cancel order"); }
    }
  }

  const [updated] = await db.update(tradesTable)
    .set({ status: "cancelled", closeReason: "manual", closedAt: new Date() })
    .where(eq(tradesTable.id, id))
    .returning();

  res.json(updated);
});

export default router;
