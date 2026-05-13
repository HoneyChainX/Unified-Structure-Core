import { Router } from "express";
import { randomUUID } from "node:crypto";
import { db, scalperConfigTable, scalperTradesTable } from "@workspace/db";
import { eq, desc, count, inArray } from "drizzle-orm";
import { getUsdtBalance, getLivePrice, placeSpotOrder, cancelPriceTriggeredOrder, getApiKeyDetail, fmtForPair } from "../services/gateio";
import { scalperLastSyncAt } from "../services/scalper-sync";
import { scalperLoopLastRunAt, scalperLoopLastSignalCount, scalperLiveScanResults, scalperLiveScanAt, runScalperScan, runLiveDualScan } from "../services/scalper-loop";
import { getTopUsdtSymbols, fetchCandles, computeBB, computeRSI, computeVolumeRatio, computeEMA, evaluateSignal } from "../services/scalper-signals";
import { evaluateSMCSignal } from "../services/scalper-signals-smc";
import { computeADX, computeATR } from "../services/scalper-signals-cht";
import { getMrxStatus, resumeMrx } from "../services/scalper-signals-mrx";

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────────

router.get("/config", async (req, res): Promise<void> => {
  let [config] = await db.select().from(scalperConfigTable).limit(1);
  if (!config) {
    [config] = await db.insert(scalperConfigTable).values({ id: 1 }).returning();
  }
  if (!config.webhookSecret) {
    const secret = randomUUID().replace(/-/g, "");
    [config] = await db.update(scalperConfigTable)
      .set({ webhookSecret: secret })
      .where(eq(scalperConfigTable.id, config.id))
      .returning();
  }
  res.json(config);
});

router.put("/config", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const allowed = [
    "enabled", "paperMode", "longOnly", "dynamicTp", "tpMode",
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

  if (!["open", "paper", "error"].includes(trade.status)) {
    res.status(400).json({ error: "Trade is not open" });
    return;
  }

  let exitPrice: number | null = null;
  let exitError: string | null = null;

  if (!trade.paperMode) {
    // 1. Cancel TP/SL trigger orders so they don't fire after we exit
    const cancelIds = [trade.tpOrderId, trade.slOrderId].filter(Boolean) as string[];
    for (const orderId of cancelIds) {
      try { await cancelPriceTriggeredOrder(orderId, trade.gateSymbol); } catch { /* ignore */ }
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

  // ── Per-strategy breakdown ─────────────────────────────────────────────────
  type StratDim = { count: number; wins: number; totalPnl: number };
  const byStrategy: Record<string, StratDim> = {};
  for (const t of withPnl) {
    const key = t.strategy ?? "bb_rsi";
    if (!byStrategy[key]) byStrategy[key] = { count: 0, wins: 0, totalPnl: 0 };
    byStrategy[key].count++;
    byStrategy[key].totalPnl += t.pnl ?? 0;
    if ((t.pnl ?? 0) > 0) byStrategy[key].wins++;
  }
  const strategyStats = Object.entries(byStrategy).map(([strategy, d]) => ({
    strategy,
    count: d.count,
    wins: d.wins,
    losses: d.count - d.wins,
    winRate: d.count > 0 ? parseFloat(((d.wins / d.count) * 100).toFixed(1)) : null,
    totalPnl: parseFloat(d.totalPnl.toFixed(4)),
    avgPnl: d.count > 0 ? parseFloat((d.totalPnl / d.count).toFixed(4)) : null,
  })).sort((a, b) => (b.winRate ?? -Infinity) - (a.winRate ?? -Infinity));

  // ── Market regime detection from BTC 5m candles ────────────────────────────
  type Regime = "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "VOLATILE" | "NEUTRAL";
  interface MarketCondition {
    regime: Regime;
    adx: number;
    atrPct: number;
    btcTrend: "BULLISH" | "BEARISH" | "NEUTRAL";
    label: string;
    description: string;
    favoredStrategy: "bb_rsi" | "smc_mss" | "cht" | "mrx-hybrid";
    favoredReason: string;
  }

  let marketCondition: MarketCondition | null = null;
  try {
    const btcCandles = await fetchCandles("BTC_USDT", "5m", 150);
    if (btcCandles.length >= 60) {
      const closes = btcCandles.map((c) => c.close);
      const lastClose = closes[closes.length - 1];
      const ema20 = computeEMA(closes, 20);
      const ema50 = computeEMA(closes, 50);
      const { adx } = computeADX(btcCandles, 14);
      const atr = computeATR(btcCandles, 14);
      const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;

      const btcTrend: MarketCondition["btcTrend"] =
        ema20 > ema50 * 1.002 ? "BULLISH" : ema20 < ema50 * 0.998 ? "BEARISH" : "NEUTRAL";

      let regime: Regime;
      if (atrPct > 2.0) {
        regime = "VOLATILE";
      } else if (adx >= 22 && btcTrend === "BULLISH") {
        regime = "TRENDING_BULL";
      } else if (adx >= 22 && btcTrend === "BEARISH") {
        regime = "TRENDING_BEAR";
      } else if (adx < 18) {
        regime = "RANGING";
      } else {
        regime = "NEUTRAL";
      }

      // Strategy fit per regime (0–1)
      // MRX is a mean-reversion strategy: thrives in RANGING, suffers in trends
      const REGIME_FIT: Record<Regime, Record<"bb_rsi" | "smc_mss" | "cht" | "mrx-hybrid", number>> = {
        TRENDING_BULL: { bb_rsi: 0.20, smc_mss: 1.00, cht: 0.85, "mrx-hybrid": 0.30 },
        TRENDING_BEAR: { bb_rsi: 0.20, smc_mss: 1.00, cht: 0.75, "mrx-hybrid": 0.10 },
        RANGING:       { bb_rsi: 1.00, smc_mss: 0.40, cht: 0.30, "mrx-hybrid": 0.95 },
        VOLATILE:      { bb_rsi: 0.30, smc_mss: 0.55, cht: 0.90, "mrx-hybrid": 0.20 },
        NEUTRAL:       { bb_rsi: 0.60, smc_mss: 0.65, cht: 0.60, "mrx-hybrid": 0.65 },
      };

      const fit = REGIME_FIT[regime];
      const topFit = (Object.entries(fit) as [MarketCondition["favoredStrategy"], number][])
        .sort((a, b) => b[1] - a[1])[0];

      const REGIME_LABELS: Record<Regime, string> = {
        TRENDING_BULL: "TRENDING ↑",
        TRENDING_BEAR: "TRENDING ↓",
        RANGING: "RANGING",
        VOLATILE: "HIGH VOLATILITY",
        NEUTRAL: "NEUTRAL",
      };

      const REGIME_DESC: Record<Regime, string> = {
        TRENDING_BULL: `BTC trending up — ADX ${adx.toFixed(0)}, EMA20 > EMA50`,
        TRENDING_BEAR: `BTC trending down — ADX ${adx.toFixed(0)}, EMA20 < EMA50`,
        RANGING:       `BTC ranging — ADX ${adx.toFixed(0)} (< 18), price oscillating`,
        VOLATILE:      `BTC high volatility — ATR ${atrPct.toFixed(2)}%, elevated moves`,
        NEUTRAL:       `BTC neutral — ADX ${adx.toFixed(0)}, trend unclear`,
      };

      const FAVORED_REASON: Record<Regime, Record<"bb_rsi" | "smc_mss" | "cht" | "mrx-hybrid", string>> = {
        TRENDING_BULL: {
          bb_rsi:        "Mean reversion underperforms in trends",
          smc_mss:       "Structure breaks & retests thrive in uptrends",
          cht:           "11-stage trend confirmation suits directional moves",
          "mrx-hybrid":  "Trending market limits mean-reversion snap opportunity",
        },
        TRENDING_BEAR: {
          bb_rsi:        "Mean reversion underperforms in downtrends",
          smc_mss:       "Bearish MSS breakdowns excel in trending down markets",
          cht:           "CHT trend engine aligned bearish; good structural setups",
          "mrx-hybrid":  "Long-only MRX unfavorable in bearish trend — SL risk high",
        },
        RANGING: {
          bb_rsi:        "Price bounces BB extremes when market oscillates",
          smc_mss:       "Structure breaks often fail in ranging conditions",
          cht:           "CHT ADX filter blocks most signals in ranging markets",
          "mrx-hybrid":  "MRX oversold snaps excel when price coils in BB — ideal regime",
        },
        VOLATILE: {
          bb_rsi:        "Wide bands reduce signal clarity in volatile conditions",
          smc_mss:       "Structure levels can break false in high-volatility",
          cht:           "ATR-gated engine filters noise and selects clean setups",
          "mrx-hybrid":  "High volatility blows past −2.5% SL — MRX sidelined",
        },
        NEUTRAL: {
          bb_rsi:        "Moderate mean-reversion opportunity in neutral market",
          smc_mss:       "Structural signals remain valid in neutral conditions",
          cht:           "CHT consensus engine adapts to mixed conditions",
          "mrx-hybrid":  "Neutral chop with RSI extremes creates reliable MRX setups",
        },
      };

      marketCondition = {
        regime,
        adx: parseFloat(adx.toFixed(1)),
        atrPct: parseFloat(atrPct.toFixed(3)),
        btcTrend,
        label: REGIME_LABELS[regime],
        description: REGIME_DESC[regime],
        favoredStrategy: topFit[0],
        favoredReason: FAVORED_REASON[regime][topFit[0]],
      };
    }
  } catch {
    // market condition is optional — skip on error
  }

  // ── Best mode now: 40% historical win rate + 30% live signals + 30% market fit ──
  const live = scalperLiveScanResults;
  const totalScanned = live.length;
  const liveHits = {
    bb_rsi:         live.filter((r) => r.bbRsi.detected).length,
    smc_mss:        live.filter((r) => r.smc.detected).length,
    cht:            live.filter((r) => r.cht.detected).length,
    "mrx-hybrid":   live.filter((r) => r.mrx.detected).length,
  };

  // Regime fit lookup (default 0.5 if no condition data)
  type StratKey = "bb_rsi" | "smc_mss" | "cht" | "mrx-hybrid";
  const REGIME_FIT_DEFAULT: Record<StratKey, number> = { bb_rsi: 0.5, smc_mss: 0.5, cht: 0.5, "mrx-hybrid": 0.5 };
  const regimeFit: Record<StratKey, number> = marketCondition
    ? (() => {
        const REGIME_FIT: Record<string, Record<StratKey, number>> = {
          TRENDING_BULL: { bb_rsi: 0.20, smc_mss: 1.00, cht: 0.85, "mrx-hybrid": 0.30 },
          TRENDING_BEAR: { bb_rsi: 0.20, smc_mss: 1.00, cht: 0.75, "mrx-hybrid": 0.10 },
          RANGING:       { bb_rsi: 1.00, smc_mss: 0.40, cht: 0.30, "mrx-hybrid": 0.95 },
          VOLATILE:      { bb_rsi: 0.30, smc_mss: 0.55, cht: 0.90, "mrx-hybrid": 0.20 },
          NEUTRAL:       { bb_rsi: 0.60, smc_mss: 0.65, cht: 0.60, "mrx-hybrid": 0.65 },
        };
        return (REGIME_FIT[marketCondition.regime] ?? REGIME_FIT_DEFAULT) as Record<StratKey, number>;
      })()
    : REGIME_FIT_DEFAULT;

  const ALL_STRATEGIES: StratKey[] = ["bb_rsi", "smc_mss", "cht", "mrx-hybrid"];
  const bestModeScores = ALL_STRATEGIES.map((strat) => {
    const hist = byStrategy[strat];
    const histWr = hist ? hist.wins / hist.count : 0;
    const liveRate = totalScanned > 0 ? liveHits[strat] / totalScanned : 0;
    const fit = regimeFit[strat];
    // 40% historical win rate + 30% live signal rate + 30% market regime fit
    const hasHistory = (hist?.count ?? 0) > 0;
    const score = hasHistory
      ? histWr * 0.40 + liveRate * 0.30 + fit * 0.30
      : liveRate * 0.50 + fit * 0.50;
    return {
      strategy: strat,
      score: parseFloat(score.toFixed(4)),
      winRate: hist ? parseFloat(((hist.wins / hist.count) * 100).toFixed(1)) : null,
      tradeCount: hist?.count ?? 0,
      liveSignals: liveHits[strat],
      totalScanned,
      marketFit: parseFloat((fit * 100).toFixed(0)),
    };
  }).sort((a, b) => b.score - a.score);

  const bestModeNow = bestModeScores[0]?.score > 0 ? bestModeScores[0] : null;

  // MRX status (auto-pause + WR monitor state)
  const mrxStatus = getMrxStatus();

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
    strategyStats,
    bestModeNow,
    marketCondition,
    mrxStatus,
  });
});

// ── MRX resume (clear auto-pause) ─────────────────────────────────────────────
router.post("/mrx/resume", (_req, res): void => {
  resumeMrx();
  res.json({ ok: true });
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
  runLiveDualScan().catch((err) => req.log.error({ err }, "Manual live dual scan failed"));
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

// ── TradingView webhook receiver ──────────────────────────────────────────────
// Rotate secret — call from UI "Regenerate" button
router.post("/webhook/regenerate", async (req, res): Promise<void> => {
  const [config] = await db.select().from(scalperConfigTable).limit(1);
  if (!config) { res.status(503).json({ error: "Scalper not configured" }); return; }
  const secret = randomUUID().replace(/-/g, "");
  await db.update(scalperConfigTable).set({ webhookSecret: secret }).where(eq(scalperConfigTable.id, config.id));
  req.log.info("Scalper webhook secret rotated");
  res.json({ ok: true, webhookSecret: secret });
});

// Receive alert from TradingView — validates secret, fetches live candles,
// builds a ScalperSignal, and runs the executor with normal guards.
// Payload: { symbol, side } — also accepts { ticker, action } for TV variables.
// Optional: { tp: 1.23, sl: 0.98, force: true }
router.post("/webhook", async (req, res): Promise<void> => {
  const [config] = await db.select().from(scalperConfigTable).limit(1);
  if (!config) { res.status(503).json({ error: "Scalper not configured" }); return; }

  if (config.webhookSecret) {
    const provided = (req.query["secret"] as string | undefined)
      ?? (req.headers["x-webhook-secret"] as string | undefined);
    if (!provided || provided !== config.webhookSecret) {
      req.log.warn({ ip: req.ip }, "Scalper webhook: rejected — invalid secret");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const body = req.body as Record<string, unknown>;
  const rawSymbol = ((body["symbol"] ?? body["ticker"]) as string | undefined)?.trim().toUpperCase();
  const rawSide   = ((body["side"]   ?? body["action"]) as string | undefined)?.trim().toLowerCase();
  const tpPrice   = typeof body["tp"] === "number" ? (body["tp"] as number) : undefined;
  const slPrice   = typeof body["sl"] === "number" ? (body["sl"] as number) : undefined;
  const forceEntry = body["force"] === true;

  if (!rawSymbol) { res.status(400).json({ error: "symbol (or ticker) is required" }); return; }

  const side = rawSide === "buy"  || rawSide === "long"
    ? "buy"
    : rawSide === "sell" || rawSide === "short"
    ? "sell"
    : null;
  if (!side) { res.status(400).json({ error: "side must be buy/long or sell/short" }); return; }

  let gateSymbol: string;
  if (rawSymbol.includes("_")) {
    gateSymbol = rawSymbol.endsWith("_USDT") ? rawSymbol : `${rawSymbol}_USDT`;
  } else if (rawSymbol.endsWith("USDT")) {
    gateSymbol = `${rawSymbol.slice(0, -4)}_USDT`;
  } else {
    gateSymbol = `${rawSymbol}_USDT`;
  }

  try {
    const candles = await fetchCandles(gateSymbol, "5m", 60);
    const closes  = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

    const bb          = computeBB(closes, config.bbPeriod ?? 20, config.bbStdDev ?? 2.0);
    const rsi         = computeRSI(closes, config.rsiPeriod ?? 14);
    const volumeRatio = computeVolumeRatio(volumes);
    const lastClose   = closes[closes.length - 1];
    const symbol      = gateSymbol.replace("_USDT", "");

    const signal = {
      symbol,
      gateSymbol,
      side: side as "buy" | "sell",
      entryPrice: lastClose,
      bbUpper: bb.upper,
      bbLower: bb.lower,
      bbMid:   bb.mid,
      rsi,
      volumeRatio,
      tpPrice,
      slPrice,
      strategy: "webhook",
    };

    req.log.info({ gateSymbol, side, lastClose, forceEntry }, "Scalper webhook: signal received");

    const { executeScalperSignal } = await import("../services/scalper-executor.js");
    const blocked = await executeScalperSignal(signal, { force: forceEntry });

    if (blocked) {
      res.json({ ok: false, blocked, gateSymbol, side, entryPrice: lastClose });
      return;
    }
    res.json({ ok: true, gateSymbol, side, entryPrice: lastClose });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Scalper webhook: error");
    res.status(502).json({ error: msg });
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
      await cancelPriceTriggeredOrder(orderId, trade.gateSymbol);
      req.log.info({ tradeId, orderId }, "Force close: cancelled companion order");
    } catch (err) {
      req.log.warn({ tradeId, orderId, err }, "Force close: could not cancel companion order (may already be gone)");
    }
  }

  // Place an immediate market order to close the spot position
  const livePrice = await getLivePrice(trade.gateSymbol).catch(() => 0);
  try {
    const closeSide: "buy" | "sell" = trade.side === "buy" ? "sell" : "buy";
    // Use pair-aware precision for the exit amount (e.g. amount_precision=0 pairs need integers)
    const exitFmt = await fmtForPair(trade.gateSymbol, livePrice, trade.quantity);
    const closeOrder = await placeSpotOrder({
      currencyPair: trade.gateSymbol,
      side: closeSide,
      amount: exitFmt.amount,
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

    // BALANCE_NOT_ENOUGH means the TP or SL already executed on Gate.io and the asset
    // is gone — the position is closed. Mark the DB record accordingly using live price.
    if (msg.includes("BALANCE_NOT_ENOUGH") || msg.includes("balance")) {
      const closePrice = livePrice || trade.entryPrice || 0;
      const pnl =
        trade.entryPrice != null && trade.quantity != null && closePrice > 0
          ? (trade.side === "buy"
              ? closePrice - trade.entryPrice
              : trade.entryPrice - closePrice) * trade.quantity
          : null;

      await db.update(scalperTradesTable).set({
        status:      "closed",
        closePrice,
        closeReason: "terminal",
        pnl:         pnl != null ? parseFloat(pnl.toFixed(4)) : null,
        closedAt:    new Date(),
      }).where(eq(scalperTradesTable.id, tradeId));

      req.log.warn({ tradeId, closePrice, pnl }, "Scalper: force close — balance already gone (TP/SL filled), trade auto-closed at live price");
      res.json({ ok: true, closePrice, filledQty: trade.quantity, pnl, note: "Position was already closed on Gate.io (TP/SL executed). Record updated." });
      return;
    }

    req.log.error({ tradeId, err: msg }, "Scalper: force close failed");
    res.status(502).json({ error: msg });
  }
});

export default router;

