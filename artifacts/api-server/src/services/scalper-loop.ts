/**
 * Scalper scan loop — runs every 2.5 minutes.
 * Execution: uses active strategy only (BB+RSI or SMC).
 * Live display: dual-strategy scan for ALL configured symbols — results
 *   stored in memory and exposed via GET /api/scalper/scan/live.
 */

import { db, scalperConfigTable } from "@workspace/db";
import { scanForSignals, fetchCandles, evaluateSignal, getTopUsdtSymbols } from "./scalper-signals";
import { scanForSMCSignals, evaluateSMCSignal } from "./scalper-signals-smc";
import { scanForCHTSignals, evaluateCHTSignal } from "./scalper-signals-cht";
import { executeScalperSignal } from "./scalper-executor";
import { logger } from "../lib/logger";

// ── Execution loop state ────────────────────────────────────────────────────

export let scalperLoopLastRunAt: Date | null = null;
export let scalperLoopLastSignalCount = 0;

// ── Live dual-scan results (in-memory) ────────────────────────────────────

export interface LiveScanEntry {
  gateSymbol: string;
  lastClose: number;
  /** true = this pair is in the configured allowlist and will actually be traded */
  inAllowlist: boolean;
  bbRsi: {
    detected: boolean;
    side: "buy" | "sell" | null;
    rsi: number | null;
    volumeRatio: number | null;
    tp: number | null;
    sl: number | null;
  };
  smc: {
    detected: boolean;
    side: "buy" | "sell" | null;
    tp: number | null;
    sl: number | null;
    obHigh: number | null;
    obLow: number | null;
    mssLevel: number | null;
  };
  cht: {
    detected: boolean;
    side: "buy" | "sell" | null;
    score: number | null;
    grade: string | null;
    setupType: string | null;
    taoVotes: number | null;
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
    sl: number | null;
    rr: number | null;
  };
}

export let scalperLiveScanResults: LiveScanEntry[] = [];
export let scalperLiveScanAt: Date | null = null;

// ── Dual-strategy scan (display only, no execution) ──────────────────────

async function runLiveDualScan(): Promise<void> {
  const [config] = await db.select().from(scalperConfigTable).limit(1);

  const scanPoolSize = config?.scanPoolSize ?? 20;

  const allowlistRaw = config?.symbolAllowlist?.trim();
  const allowlistSymbols: string[] = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [];

  // Always fetch top-N by volume to fill out the monitor
  let topSymbols: string[] = [];
  try {
    topSymbols = await getTopUsdtSymbols(scanPoolSize);
  } catch (err) {
    logger.error({ err }, "Live dual scan: failed to fetch top symbols");
    topSymbols = [];
  }

  // Priority order: allowlist first, then top-volume pairs not already in allowlist
  const allowlistSet = new Set(allowlistSymbols);
  const fillSymbols = topSymbols.filter((s) => !allowlistSet.has(s));
  const symbols = [
    ...allowlistSymbols,
    ...fillSymbols,
  ].slice(0, scanPoolSize);

  const longOnly = config?.longOnly ?? false;
  const bbParams = {
    bbPeriod: config?.bbPeriod ?? 20,
    bbStdDev: config?.bbStdDev ?? 2,
    rsiPeriod: config?.rsiPeriod ?? 14,
    rsiOversold: config?.rsiOversold ?? 30,
    rsiOverbought: config?.rsiOverbought ?? 70,
    volumeSpikeMultiplier: config?.volumeSpikeMultiplier ?? 1.5,
    longOnly,
    emaFilterEnabled: config?.emaFilterEnabled ?? false,
    emaPeriod: config?.emaPeriod ?? 200,
  };

  // Fetch BTC 5m candles once for CHT spread intelligence (reused across all symbols)
  let btcCandles: Awaited<ReturnType<typeof fetchCandles>> = [];
  try {
    btcCandles = await fetchCandles("BTC_USDT", "5m", 150);
  } catch (err) {
    logger.warn({ err }, "Live dual scan: failed to fetch BTC candles for CHT spread");
  }

  const results: LiveScanEntry[] = [];

  for (const sym of symbols) {
    try {
      // Fetch 5m (BB+RSI/SMC/CHT) and 1h (CHT HTF) concurrently
      const [candles, htfCandles] = await Promise.all([
        fetchCandles(sym, "5m", 150),
        fetchCandles(sym, "1h", 60).catch(() => [] as Awaited<ReturnType<typeof fetchCandles>>),
      ]);
      if (candles.length < 20) continue;

      const lastClose = candles[candles.length - 1]!.close;

      const bbSignal  = evaluateSignal(sym, candles, bbParams);
      const smcSignal = evaluateSMCSignal(sym, candles, { longOnly });
      const chtSignal = htfCandles.length >= 55
        ? evaluateCHTSignal(sym, candles, htfCandles, btcCandles, { longOnly })
        : null;

      results.push({
        gateSymbol: sym,
        lastClose,
        inAllowlist: allowlistSet.size > 0 ? allowlistSet.has(sym) : false,
        bbRsi: {
          detected: bbSignal !== null,
          side: bbSignal ? bbSignal.side : null,
          rsi: bbSignal ? bbSignal.rsi : null,
          volumeRatio: bbSignal ? bbSignal.volumeRatio : null,
          tp: bbSignal?.tpPrice ?? null,
          sl: bbSignal?.slPrice ?? null,
        },
        smc: {
          detected: smcSignal !== null,
          side: smcSignal ? smcSignal.side : null,
          tp: smcSignal?.tpPrice ?? null,
          sl: smcSignal?.slPrice ?? null,
          obHigh: smcSignal ? smcSignal.bbUpper : null,
          obLow: smcSignal ? smcSignal.bbLower : null,
          mssLevel: smcSignal ? smcSignal.bbMid : null,
        },
        cht: {
          detected:  chtSignal !== null,
          side:      chtSignal ? chtSignal.side : null,
          score:     chtSignal?.chtScore     ?? null,
          grade:     chtSignal?.chtGrade     ?? null,
          setupType: chtSignal?.chtSetupType ?? null,
          taoVotes:  chtSignal?.chtTaoVotes  ?? null,
          tp1:       chtSignal?.tp1Price     ?? null,
          tp2:       chtSignal?.tp2Price     ?? null,
          tp3:       chtSignal?.tp3Price     ?? null,
          sl:        chtSignal?.slPrice      ?? null,
          rr:        chtSignal?.chtRr        ?? null,
        },
      });
    } catch (err) {
      logger.error({ sym, err }, "Live dual scan: error for symbol");
    }
  }

  scalperLiveScanResults = results;
  scalperLiveScanAt = new Date();
  logger.debug(
    {
      symbols: results.length,
      bbHits: results.filter((r) => r.bbRsi.detected).length,
      smcHits: results.filter((r) => r.smc.detected).length,
      chtHits: results.filter((r) => r.cht.detected).length,
    },
    "Live dual scan complete",
  );
}

// ── Execution scan ────────────────────────────────────────────────────────

export async function runScalperScan(): Promise<void> {
  const [config] = await db.select().from(scalperConfigTable).limit(1);
  if (!config || !config.enabled) {
    logger.debug("Scalper loop: bot disabled, skipping scan");
    scalperLoopLastRunAt = new Date();
    return;
  }

  const allowlistRaw = config.symbolAllowlist?.trim();
  const allowlistSymbols = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;

  const scanPoolSize = config.scanPoolSize ?? 20;
  const strategy = config.strategy ?? "bb_rsi";

  // When no allowlist is set, resolve the scan pool from top-N by volume.
  // This ensures execution covers the same breadth as the live monitor.
  let resolvedSymbols: string[] | null = allowlistSymbols;
  if (!allowlistSymbols) {
    try {
      resolvedSymbols = await getTopUsdtSymbols(scanPoolSize);
    } catch (err) {
      logger.error({ err }, "Scalper: failed to fetch top symbols, skipping cycle");
      scalperLoopLastRunAt = new Date();
      scalperLoopLastSignalCount = 0;
      return;
    }
  }

  logger.debug(
    allowlistSymbols
      ? { count: allowlistSymbols.length, symbols: allowlistSymbols, strategy }
      : { strategy, scanPoolSize, symbols: resolvedSymbols?.length, note: "no allowlist — scanning top by volume" },
    "Scalper loop: starting symbol scan"
  );

  let signals;

  if (strategy === "smc_mss") {
    signals = await scanForSMCSignals({ longOnly: config.longOnly, symbols: resolvedSymbols! });
  } else if (strategy === "cht") {
    signals = await scanForCHTSignals({ longOnly: config.longOnly, symbols: resolvedSymbols! });
  } else {
    signals = await scanForSignals({
      bbPeriod: config.bbPeriod,
      bbStdDev: config.bbStdDev,
      rsiPeriod: config.rsiPeriod,
      rsiOversold: config.rsiOversold,
      rsiOverbought: config.rsiOverbought,
      volumeSpikeMultiplier: config.volumeSpikeMultiplier,
      longOnly: config.longOnly,
      emaFilterEnabled: config.emaFilterEnabled,
      emaPeriod: config.emaPeriod,
      symbols: resolvedSymbols ?? undefined,
    });
  }

  scalperLoopLastRunAt = new Date();
  scalperLoopLastSignalCount = signals.length;

  if (signals.length === 0) {
    logger.debug({ strategy }, "Scalper loop: no signals this cycle");
    return;
  }

  logger.info({ count: signals.length, symbols: signals.map((s) => s.gateSymbol), strategy }, "Scalper loop: signals found");

  for (const signal of signals) {
    await executeScalperSignal(signal).catch((err) => {
      logger.error({ symbol: signal.gateSymbol, err }, "Scalper loop: execution error");
    });
  }
}

// ── Loop control ─────────────────────────────────────────────────────────

let scalperLoopInterval: ReturnType<typeof setInterval> | null = null;

export function startScalperLoop(intervalMs = 2.5 * 60_000): void {
  if (scalperLoopInterval) return;

  // Small stagger to avoid tight startup races
  setTimeout(() => {
    runLiveDualScan().catch((err) => logger.error({ err }, "Scalper loop: initial dual scan failed"));
    runScalperScan().catch((err) => logger.error({ err }, "Scalper loop: initial scan failed"));
  }, 10_000);

  scalperLoopInterval = setInterval(() => {
    runLiveDualScan().catch((err) => logger.error({ err }, "Scalper loop: dual scan failed"));
    runScalperScan().catch((err) => logger.error({ err }, "Scalper loop: interval scan failed"));
  }, intervalMs);

  logger.info({ intervalMs }, "Scalper scan loop started");
}

export function stopScalperLoop(): void {
  if (scalperLoopInterval) {
    clearInterval(scalperLoopInterval);
    scalperLoopInterval = null;
  }
}
