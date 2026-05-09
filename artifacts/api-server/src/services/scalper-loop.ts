/**
 * Scalper scan loop — runs every 5 minutes.
 * Fetches top-5 USDT symbols, scans all for BB+RSI+volume signals,
 * and fires executeScalperSignal for any confirmed entry.
 */

import { db, scalperConfigTable } from "@workspace/db";
import { scanForSignals } from "./scalper-signals";
import { executeScalperSignal } from "./scalper-executor";
import { logger } from "../lib/logger";

export let scalperLoopLastRunAt: Date | null = null;
export let scalperLoopLastSignalCount = 0;

let scalperLoopInterval: ReturnType<typeof setInterval> | null = null;

export async function runScalperScan(): Promise<void> {
  const [config] = await db.select().from(scalperConfigTable).limit(1);
  if (!config || !config.enabled) {
    logger.debug("Scalper loop: bot disabled, skipping scan");
    scalperLoopLastRunAt = new Date();
    return;
  }

  logger.debug("Scalper loop: starting symbol scan");

  // Determine symbols to scan: allowlist overrides top-5 by volume
  const allowlistRaw = config.symbolAllowlist?.trim();
  const customSymbols = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;

  if (customSymbols) {
    logger.debug({ symbols: customSymbols }, "Scalper loop: scanning allowlist symbols");
  }

  const signals = await scanForSignals({
    bbPeriod: config.bbPeriod,
    bbStdDev: config.bbStdDev,
    rsiPeriod: config.rsiPeriod,
    rsiOversold: config.rsiOversold,
    rsiOverbought: config.rsiOverbought,
    volumeSpikeMultiplier: config.volumeSpikeMultiplier,
    longOnly: config.longOnly,
    symbols: customSymbols ?? undefined,
  });

  scalperLoopLastRunAt = new Date();
  scalperLoopLastSignalCount = signals.length;

  if (signals.length === 0) {
    logger.debug("Scalper loop: no signals this cycle");
    return;
  }

  logger.info({ count: signals.length, symbols: signals.map((s) => s.gateSymbol) }, "Scalper loop: signals found");

  for (const signal of signals) {
    await executeScalperSignal(signal).catch((err) => {
      logger.error({ symbol: signal.gateSymbol, err }, "Scalper loop: execution error");
    });
  }
}

export function startScalperLoop(intervalMs = 5 * 60_000): void {
  if (scalperLoopInterval) return;

  // Small stagger to avoid tight startup races
  setTimeout(() => {
    runScalperScan().catch((err) => logger.error({ err }, "Scalper loop: initial scan failed"));
  }, 10_000);

  scalperLoopInterval = setInterval(() => {
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
