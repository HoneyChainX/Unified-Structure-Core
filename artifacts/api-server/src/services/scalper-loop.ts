/**
 * Scalper scan loop — runs every 2.5 minutes.
 *
 * Live monitor: always scans all 7 timeframes (1m/3m/5m/15m/1h/4h/1d) across
 *   BB+RSI, SMC MSS+OB, CHT, and MRX — results stored in memory and exposed via
 *   GET /api/scalper/scan/live.
 *
 * Execution: only fires on timeframes appropriate for the configured TP mode:
 *   - Fixed USDT TP  → 1m, 3m, 5m       (scalp — MRX evaluates 1m+3m internally)
 *   - Fixed % TP     → 15m, 1h, 4h, 1d  (swing)
 *   - Auto/dynamic BB → all seven
 */

import { db, scalperConfigTable } from "@workspace/db";
import {
  scanForSignals,
  fetchCandles,
  evaluateSignal,
  getTopUsdtSymbols,
  injectCandleCache,
  clearCandleCache,
  type Candle,
  type ScalperSignal,
} from "./scalper-signals";
import { scanForSMCSignals, evaluateSMCSignal } from "./scalper-signals-smc";
import {
  scanForCHTSignals,
  evaluateCHTSignal,
  CHT_HTF_MAP,
  type CHTMarketContext,
} from "./scalper-signals-cht";
import { scanForMRXSignals, evaluateMRXSignal, loadMRXThresholdsFromConfig, MRX_STRATEGY_TAG } from "./scalper-signals-mrx";
import { executeScalperSignal } from "./scalper-executor";
import { notifyMobile } from "./notify-mobile";
import { getMarketStatus } from "./market";
import { logger } from "../lib/logger";

// ── Timeframe configuration ───────────────────────────────────────────────

/** All timeframes scanned by the live monitor (always all 7). */
const ALL_LIVE_TFS = ["1m", "3m", "5m", "15m", "1h", "4h", "1d"] as const;

/** Candle counts per timeframe — sufficient for every indicator window. */
const CANDLE_COUNTS: Record<string, number> = {
  "1m": 200, "3m": 150, "5m": 150, "15m": 150, "1h": 100, "4h": 80, "1d": 60,
};

/**
 * Returns the execution-only timeframes for a given config:
 *   - Fixed USDT TP  → ["1m","3m","5m"]
 *   - Fixed % TP     → ["15m","1h","4h","1d"]
 *   - Auto/dynamic BB → all seven
 */
function getExecutionTimeframes(config: typeof scalperConfigTable.$inferSelect): string[] {
  if (config.dynamicTp) return [...ALL_LIVE_TFS];
  if (config.targetProfitPct != null && config.targetProfitPct > 0) return ["15m", "1h", "4h", "1d"];
  return ["1m", "3m", "5m"];
}

// ── Execution loop state ────────────────────────────────────────────────────

export let scalperLoopLastRunAt: Date | null = null;
export let scalperLoopLastSignalCount = 0;

// ── High-quality-signal push throttle ──────────────────────────────────────
// We push when a scored signal lands on the executor queue. The same setup
// often re-fires every 2.5min until conditions change — without dedup, a
// single oversold pullback would send 10+ notifications in an hour. Key by
// "symbol-side", track first-seen, suppress for SIGNAL_PUSH_TTL_MS.
const SIGNAL_PUSH_TTL_MS = 30 * 60_000;            // 30 minutes
const SIGNAL_PUSH_MIN_QUALITY = 0.7;               // server-side floor; per-device threshold filters further
const _recentSignalPushes = new Map<string, number>();
function maybePushSignal(args: { symbol: string; side: "buy" | "sell"; strategy: string; quality: number }): void {
  if (args.quality < SIGNAL_PUSH_MIN_QUALITY) return;
  const key = `${args.symbol}-${args.side}`;
  const now = Date.now();
  const last = _recentSignalPushes.get(key);
  if (last != null && now - last < SIGNAL_PUSH_TTL_MS) return;
  _recentSignalPushes.set(key, now);
  // Garbage-collect stale entries while we're here (cheap on small map).
  for (const [k, t] of _recentSignalPushes) {
    if (now - t > SIGNAL_PUSH_TTL_MS) _recentSignalPushes.delete(k);
  }
  void notifyMobile.highQualitySignal(args).catch(() => {});
}

/** Test-only: reset the push throttle. */
export function _resetSignalPushThrottle(): void {
  _recentSignalPushes.clear();
}

// ── Live multi-TF scan results (in-memory) ────────────────────────────────

export interface LiveScanEntry {
  gateSymbol: string;
  lastClose: number;
  /** true = this pair is in the configured allowlist and will actually be traded */
  inAllowlist: boolean;
  bbRsi: {
    detected: boolean;
    side: "buy" | "sell" | null;
    /** Timeframe on which the signal was detected (e.g. "5m", "1h"). */
    timeframe: string | null;
    rsi: number | null;
    volumeRatio: number | null;
    tp: number | null;
    sl: number | null;
  };
  smc: {
    detected: boolean;
    side: "buy" | "sell" | null;
    timeframe: string | null;
    tp: number | null;
    sl: number | null;
    obHigh: number | null;
    obLow: number | null;
    mssLevel: number | null;
  };
  cht: {
    detected: boolean;
    side: "buy" | "sell" | null;
    timeframe: string | null;
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
  mrx: {
    detected: boolean;
    timeframe: string | null;
    rsi: number | null;
    atrPct: number | null;
    volumeRatio: number | null;
    inOB: boolean;
    tp: number | null;
    sl: number | null;
  };
}

export let scalperLiveScanResults: LiveScanEntry[] = [];
export let scalperLiveScanAt: Date | null = null;

// ── Live scan (display only — always scans all 7 TFs) ─────────────────────

export async function runLiveDualScan(): Promise<void> {
  const [config] = await db.select().from(scalperConfigTable).limit(1);

  // Load MRX thresholds once per scan cycle
  const mrxThresholds = await loadMRXThresholdsFromConfig();

  const scanPoolSize = config?.scanPoolSize ?? 20;

  const allowlistRaw = config?.symbolAllowlist?.trim();
  const allowlistSymbols: string[] = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : [];

  let topSymbols: string[] = [];
  try {
    topSymbols = await getTopUsdtSymbols(scanPoolSize);
  } catch (err) {
    logger.error({ err }, "Live scan: failed to fetch top symbols");
  }

  const allowlistSet = new Set(allowlistSymbols);
  const fillSymbols = topSymbols.filter((s) => !allowlistSet.has(s));
  const symbols = [...allowlistSymbols, ...fillSymbols].slice(0, scanPoolSize);

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

  // Fetch BTC reference candles for all 7 TFs once — shared correlation ref for CHT
  const btcRefMap = new Map<string, Candle[]>();
  await Promise.allSettled(
    (ALL_LIVE_TFS as readonly string[]).map(async (tf) => {
      try {
        btcRefMap.set(tf, await fetchCandles("BTC_USDT", tf, CANDLE_COUNTS[tf]!));
      } catch {}
    }),
  );

  // Fetch CoinGecko market context once (cached 60 s inside getMarketStatus)
  let mktCtx: CHTMarketContext | null = null;
  try {
    const s = await getMarketStatus();
    mktCtx = { btcD: s.btcDominance, othersD: s.othersDominance, stableD: s.stableDominance };
  } catch {}

  // Process symbols in batches of 4 to limit concurrency, and populate candle cache
  const LIVE_BATCH_SIZE = 4;
  const masterCandleCache = new Map<string, Candle[]>();
  const settled: PromiseSettledResult<LiveScanEntry | null>[] = [];

  for (let i = 0; i < symbols.length; i += LIVE_BATCH_SIZE) {
    const batch = symbols.slice(i, i + LIVE_BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (sym): Promise<LiveScanEntry | null> => {
        const tfResults = await Promise.allSettled(
          (ALL_LIVE_TFS as readonly string[]).map(async (tf) => ({
            tf,
            candles: await fetchCandles(sym, tf, CANDLE_COUNTS[tf]!),
          })),
        );

        const tfMap = new Map<string, Candle[]>();
        for (const r of tfResults) {
          if (r.status === "fulfilled") {
            tfMap.set(r.value.tf, r.value.candles);
            masterCandleCache.set(`${sym}:${r.value.tf}`, r.value.candles);
          }
        }

        // Display price from the smallest available TF
        const priceCandles = tfMap.get("1m") ?? tfMap.get("3m") ?? tfMap.get("5m") ?? tfMap.get("15m");
        const lastClose = priceCandles?.at(-1)?.close ?? 0;
        if (lastClose === 0) return null;

        // Scan all TFs for each strategy.
        // BB+RSI / SMC: first (smallest) TF that fires wins.
        // CHT: keep the TF with the highest opportunity score.
        let bbRsiSig: ScalperSignal | null = null;
        let bbRsiTf: string | null = null;
        let smcSig: ScalperSignal | null = null;
        let smcTf: string | null = null;
        let chtSig: ScalperSignal | null = null;
        let chtTf: string | null = null;

        for (const tf of ALL_LIVE_TFS) {
          const ltf = tfMap.get(tf);
          if (!ltf || ltf.length < 20) continue;

          if (!bbRsiSig) {
            const sig = evaluateSignal(sym, ltf, bbParams);
            if (sig) { bbRsiSig = sig; bbRsiTf = tf; }
          }

          if (!smcSig) {
            const sig = evaluateSMCSignal(sym, ltf, { longOnly });
            if (sig) { smcSig = sig; smcTf = tf; }
          }

          const chtHtf = CHT_HTF_MAP[tf] ?? null;
          if (chtHtf) {
            const htf = tfMap.get(chtHtf);
            const btcRef = btcRefMap.get(tf) ?? [];
            if (htf && htf.length >= 55) {
              const sig = evaluateCHTSignal(sym, ltf, htf, btcRef, {
                longOnly,
                marketContext: mktCtx,
                timeframe: tf,
              });
              if (sig && (!chtSig || (sig.chtScore ?? 0) > (chtSig.chtScore ?? 0))) {
                chtSig = sig;
                chtTf = tf;
              }
            }
          }
        }

        // MRX: evaluate 1m first (faster trigger), fall back to 3m
        // HTF refs (15m trend, 1h OB) are the same for both primary TFs
        const mrxC1m  = tfMap.get("1m")  ?? [];
        const mrxC3m  = tfMap.get("3m")  ?? [];
        const mrxC15m = tfMap.get("15m") ?? [];
        const mrxC1h  = tfMap.get("1h")  ?? [];
        let mrxDecision: ReturnType<typeof evaluateMRXSignal> | null = null;
        if (mrxC1m.length >= 30) {
          const d = evaluateMRXSignal(sym, mrxC1m, mrxC15m, mrxC1h, "1m", mrxThresholds);
          mrxDecision = d;
        }
        if ((!mrxDecision || !mrxDecision.signal) && mrxC3m.length >= 30) {
          const d = evaluateMRXSignal(sym, mrxC3m, mrxC15m, mrxC1h, "3m", mrxThresholds);
          if (!mrxDecision || d.signal) mrxDecision = d;
        }
        const mrxSig = mrxDecision?.signal ?? null;

        return {
          gateSymbol: sym,
          lastClose,
          inAllowlist: allowlistSet.size > 0 ? allowlistSet.has(sym) : false,
          bbRsi: {
            detected: bbRsiSig != null,
            side: bbRsiSig?.side ?? null,
            timeframe: bbRsiTf,
            rsi: bbRsiSig?.rsi ?? null,
            volumeRatio: bbRsiSig?.volumeRatio ?? null,
            tp: bbRsiSig?.tpPrice ?? null,
            sl: bbRsiSig?.slPrice ?? null,
          },
          smc: {
            detected: smcSig != null,
            side: smcSig?.side ?? null,
            timeframe: smcTf,
            tp: smcSig?.tpPrice ?? null,
            sl: smcSig?.slPrice ?? null,
            obHigh: smcSig?.bbUpper ?? null,
            obLow: smcSig?.bbLower ?? null,
            mssLevel: smcSig?.bbMid ?? null,
          },
          cht: {
            detected: chtSig != null,
            side: chtSig?.side ?? null,
            timeframe: chtTf,
            score: chtSig?.chtScore ?? null,
            grade: chtSig?.chtGrade ?? null,
            setupType: chtSig?.chtSetupType ?? null,
            taoVotes: chtSig?.chtTaoVotes ?? null,
            tp1: chtSig?.tp1Price ?? null,
            tp2: chtSig?.tp2Price ?? null,
            tp3: chtSig?.tp3Price ?? null,
            sl: chtSig?.slPrice ?? null,
            rr: chtSig?.chtRr ?? null,
          },
          mrx: {
            detected: mrxSig != null,
            timeframe: mrxSig?.timeframe ?? null,
            rsi: mrxDecision?.decision.rsi ?? null,
            atrPct: mrxDecision?.decision.atrPct ?? null,
            volumeRatio: mrxDecision?.decision.volumeRatio ?? null,
            inOB: mrxDecision?.decision.inOB ?? false,
            tp: mrxSig?.tpPrice ?? null,
            sl: mrxSig?.slPrice ?? null,
          },
        };
      }),
    );
    settled.push(...batchResults);
  }

  // Inject collected candles so the exec scan can reuse them without re-fetching
  injectCandleCache(masterCandleCache);

  scalperLiveScanResults = settled
    .filter(
      (r): r is PromiseFulfilledResult<LiveScanEntry> =>
        r.status === "fulfilled" && r.value != null,
    )
    .map((r) => r.value);

  scalperLiveScanAt = new Date();
  logger.debug(
    {
      symbols: scalperLiveScanResults.length,
      tfs: [...ALL_LIVE_TFS],
      bbHits:  scalperLiveScanResults.filter((r) => r.bbRsi.detected).length,
      smcHits: scalperLiveScanResults.filter((r) => r.smc.detected).length,
      chtHits: scalperLiveScanResults.filter((r) => r.cht.detected).length,
      mrxHits: scalperLiveScanResults.filter((r) => r.mrx.detected).length,
    },
    "Live scan complete (multi-timeframe)",
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

  const execTfs = getExecutionTimeframes(config);

  logger.debug(
    { strategy, timeframes: execTfs, symbols: resolvedSymbols?.length ?? 0 },
    "Scalper loop: starting multi-TF execution scan",
  );

  // Scan each execution TF; dedupe by symbol — first (smallest) TF hit wins
  const signalsBySymbol = new Map<string, ScalperSignal>();

  for (const tf of execTfs) {
    let tfSignals: ScalperSignal[];

    if (strategy === "smc_mss") {
      tfSignals = await scanForSMCSignals({
        longOnly: config.longOnly,
        symbols: resolvedSymbols!,
        timeframe: tf,
      });
    } else if (strategy === "cht") {
      tfSignals = await scanForCHTSignals({
        longOnly: config.longOnly,
        symbols: resolvedSymbols!,
        timeframe: tf,
        fundingFilterEnabled: config.chtFundingFilterEnabled,
        fundingThresholdPct: config.chtFundingThresholdPct,
      });
    } else if (strategy === MRX_STRATEGY_TAG) {
      // MRX scans both 1m and 3m internally — call once on the "3m" iteration
      // (scanForMRXSignals fetches its own 1m+3m candles regardless of tf loop)
      if (tf !== "3m") continue;
      tfSignals = await scanForMRXSignals({
        symbols: resolvedSymbols!,
        candleCache: new Map(), // executor cycle has no pre-populated cache here
        fundingFilterEnabled: config.mrxFundingFilterEnabled,
        fundingThresholdPct: config.mrxFundingThresholdPct,
      });
    } else {
      tfSignals = await scanForSignals({
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
        timeframe: tf,
        adaptiveThresholds:   config.adaptiveThresholds,
        adaptiveWindow:       config.adaptiveWindow,
        adaptiveLowQ:         config.adaptiveLowQ,
        adaptiveHighQ:        config.adaptiveHighQ,
        adaptiveRsiLowFloor:  config.adaptiveRsiLowFloor,
        adaptiveRsiHighFloor: config.adaptiveRsiHighFloor,
      });
    }

    // Per-symbol dedup: keep the higher-quality signal when the same symbol
    // fires across multiple timeframes (e.g. 3m + 5m). Quality is the shared
    // 0..1 score populated by adaptive BB+RSI / CHT / SMC. Signals without a
    // quality score (legacy fixed-threshold path) are treated as quality=0,
    // so any scored signal beats an unscored one for the same symbol.
    for (const sig of tfSignals) {
      const existing = signalsBySymbol.get(sig.gateSymbol);
      const newQ = sig.quality ?? 0;
      const oldQ = existing?.quality ?? 0;
      if (!existing || newQ > oldQ) {
        signalsBySymbol.set(sig.gateSymbol, sig);
      }
    }
  }

  // Global ranking: sort by quality DESC so the executor tries the best
  // candidates first when maxOpenTrades is near its cap. Unscored signals
  // fall to the end of the queue but are still executed if slots remain.
  const signals = [...signalsBySymbol.values()].sort(
    (a, b) => (b.quality ?? 0) - (a.quality ?? 0),
  );
  scalperLoopLastRunAt = new Date();
  scalperLoopLastSignalCount = signals.length;

  if (signals.length === 0) {
    logger.debug({ strategy, tfs: execTfs }, "Scalper loop: no signals this cycle");
    return;
  }

  logger.info(
    {
      count: signals.length,
      signals: signals.map((s) => `${s.gateSymbol}@${s.timeframe ?? "?"}:${s.side}`),
      strategy,
    },
    "Scalper loop: signals found",
  );

  // Push high-quality signals to opted-in mobile devices (dedup + throttle
  // applied inside maybePushSignal). Fires regardless of whether the executor
  // accepts the trade — the operator wants to see strong setups even when
  // exposure caps prevent execution.
  for (const sig of signals) {
    if (sig.quality != null) {
      maybePushSignal({
        symbol: sig.symbol,
        side: sig.side,
        strategy: sig.strategy ?? strategy,
        quality: sig.quality,
      });
    }
  }

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

  setTimeout(() => {
    void (async () => {
      await runLiveDualScan().catch((err) => logger.error({ err }, "Scalper loop: initial dual scan failed"));
      await runScalperScan().catch((err) => logger.error({ err }, "Scalper loop: initial scan failed"));
      clearCandleCache();
    })();
  }, 10_000);

  scalperLoopInterval = setInterval(() => {
    void (async () => {
      await runLiveDualScan().catch((err) => logger.error({ err }, "Scalper loop: dual scan failed"));
      await runScalperScan().catch((err) => logger.error({ err }, "Scalper loop: interval scan failed"));
      clearCandleCache();
    })();
  }, intervalMs);

  logger.info({ intervalMs }, "Scalper scan loop started");
}

export function stopScalperLoop(): void {
  if (scalperLoopInterval) {
    clearInterval(scalperLoopInterval);
    scalperLoopInterval = null;
  }
}
