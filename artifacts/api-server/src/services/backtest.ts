/**
 * Phase 2 backtester — historical replay of the live signal evaluators.
 *
 * Walks Gate.io candles bar-by-bar, calls the same evaluator the live loop
 * uses, and simulates entry-at-next-bar-open with TP/SL hit detection on the
 * subsequent bars. Net P&L is computed via `pnlFromFills` so taker fees match
 * what the live executor would actually pay.
 *
 * Quality-aware sizing scales the base USDT by [floor + (1-floor) * quality]
 * mirroring the production rule. Kelly sizing grows the closed-trade history
 * inside this run (no DB writes) and applies `computeKellyMultiplier` per
 * trade. Both compose multiplicatively — same composition as the live path.
 *
 * NOT live-aware: zero order placement, zero DB writes, read-only Gate.io.
 */
import { computeKellyMultiplier, type KellyParams } from "./kelly-sizing";
import { pnlFromFills } from "./fees";
import {
  type Candle,
  type ScalperSignal,
  type SignalParams,
  evaluateSignal,
} from "./scalper-signals";
import { evaluateCHTSignal, type CHTMarketContext } from "./scalper-signals-cht";
import {
  evaluateMRXSignal,
  MRX_DEFAULT_THRESHOLDS,
  type MRXThresholds,
} from "./scalper-signals-mrx";
import { evaluateSMCSignal } from "./scalper-signals-smc";

const GATE_BASE = "https://api.gateio.ws/api/v4";
/** Hard ceiling on how many candles the engine will request per range — protects against runaway ranges. */
export const MAX_CANDLES = 5000;
/** Synchronous threshold — ranges above this go async-with-jobid via the router. */
export const SYNC_CANDLE_BUDGET = 1000;

// ── Candle fetching ──────────────────────────────────────────────────────────

/** Interval string → seconds (matches Gate.io candlesticks endpoint). */
export function intervalToSeconds(interval: string): number {
  const m = /^(\d+)([smhd])$/.exec(interval);
  if (!m) throw new Error(`Unsupported interval: ${interval}`);
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    case "d": return n * 86400;
    default:  throw new Error(`Unsupported interval: ${interval}`);
  }
}

/**
 * Fetch historical candles for a custom [from, to] window. Pages through
 * Gate.io's 1000-bar-per-call limit when the range is larger. Returns candles
 * sorted chronologically (oldest first).
 *
 * `fetchImpl` is injected so tests can stub network IO.
 */
export async function fetchHistoricalCandles(
  gateSymbol: string,
  interval: string,
  fromMs: number,
  toMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
  if (toMs <= fromMs) return [];
  const intervalSec = intervalToSeconds(interval);
  const fromSec = Math.floor(fromMs / 1000);
  const toSec = Math.floor(toMs / 1000);

  const totalBars = Math.ceil((toSec - fromSec) / intervalSec);
  if (totalBars > MAX_CANDLES) {
    throw new Error(`Backtest range too large: ${totalBars} candles > ${MAX_CANDLES} cap (narrow the date range or use a coarser timeframe)`);
  }

  const PAGE = 1000;
  const out: Candle[] = [];
  let cursor = fromSec;
  while (cursor < toSec) {
    const pageTo = Math.min(toSec, cursor + PAGE * intervalSec);
    const url = `${GATE_BASE}/spot/candlesticks?currency_pair=${gateSymbol}&interval=${interval}&from=${cursor}&to=${pageTo}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Gate.io candles error for ${gateSymbol}: ${res.status}`);
    const raw = (await res.json()) as string[][];
    for (const c of raw) {
      out.push({
        time:   parseInt(c[0], 10),
        volume: parseFloat(c[1]),
        close:  parseFloat(c[2]),
        high:   parseFloat(c[3]),
        low:    parseFloat(c[4]),
        open:   parseFloat(c[5]),
      });
    }
    if (raw.length === 0) break;
    // Advance cursor past the last bar received to avoid infinite loops if
    // Gate.io returns less than `pageTo` worth of data (sparse symbols).
    const lastTime = parseInt(raw[raw.length - 1][0], 10);
    const nextCursor = lastTime + intervalSec;
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
  }

  // De-dup + sort (the API can echo boundary candles between pages).
  out.sort((a, b) => a.time - b.time);
  const dedup: Candle[] = [];
  let lastT = -1;
  for (const c of out) {
    if (c.time !== lastT) {
      dedup.push(c);
      lastT = c.time;
    }
  }
  return dedup;
}

// ── Strategy types & dispatch ────────────────────────────────────────────────

export type BacktestStrategy = "bb_rsi" | "cht" | "mrx-hybrid" | "smc_mss";

export interface BacktestSizing {
  /** Base USDT notional per trade. */
  baseUsdt: number;
  /** Quality-aware sizing: scale = floor + (1-floor) * quality (per live config). */
  qualityAwareSizing: boolean;
  /** Floor in pct (0..100) below the base, e.g. 50 = lowest-quality trade gets 50% of base. */
  qualitySizeFloorPct: number;
  /** Fractional-Kelly sizing — uses in-run closed-trade history. */
  kelly: KellyParams;
}

export interface BacktestConfig {
  /** BB+RSI engine knobs (only used when strategy=bb_rsi). */
  signalParams?: SignalParams;
  /** MRX threshold overrides (only used when strategy=mrx-hybrid). */
  mrxThresholds?: MRXThresholds;
  /** longOnly toggle — applied to all evaluators that support it. */
  longOnly?: boolean;
  /** Optional MRX timeframe (1m or 3m). Defaults to "3m". */
  mrxTf?: "1m" | "3m";
}

export interface BacktestTrade {
  entryTime:   number;
  entryPrice:  number;
  exitTime:    number | null;
  exitPrice:   number;
  side:        "buy" | "sell";
  quantity:    number;
  notionalUsdt: number;
  gross:       number;
  fees:        number;
  net:         number;
  quality:     number;
  reason:      "tp" | "sl" | "eod" | "tp1" | "tp2" | "tp3";
  tpPrice:     number | null;
  slPrice:     number | null;
  kellyMultiplier: number;
  qualityMultiplier: number;
}

export interface BacktestSummary {
  totalTrades: number;
  wins:        number;
  losses:      number;
  winRate:     number;
  netPnl:      number;
  grossPnl:    number;
  feesPaid:    number;
  avgQuality:  number;
  sharpe:      number;
  maxDrawdown: number;
  largestWin:  number;
  largestLoss: number;
}

export interface BacktestResult {
  trades:  BacktestTrade[];
  summary: BacktestSummary;
  meta: {
    gateSymbol: string;
    timeframe:  string;
    startTime:  string;
    endTime:    string;
    strategy:   BacktestStrategy;
    candleCount: number;
  };
}

// ── Sharpe + drawdown helpers ─────────────────────────────────────────────────

/**
 * Per-trade Sharpe: mean(returns) / stddev(returns) × √trades.
 * The annualization factor here is √N because the trade cadence is irregular —
 * we report a "per-sample" Sharpe rather than try to fudge a per-year number.
 * Zero variance → 0. Single-sample → 0 (undefined stddev).
 */
export function tradeSharpe(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return 0;
  return (mean / stddev) * Math.sqrt(n);
}

/**
 * Maximum peak-to-trough drawdown of a cumulative-PnL equity curve, in USDT.
 * Returns 0 when the curve is monotonically non-decreasing.
 */
export function maxDrawdown(cumulativePnl: number[]): number {
  let peak = -Infinity;
  let maxDD = 0;
  for (const v of cumulativePnl) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ── Sizing ────────────────────────────────────────────────────────────────────

/**
 * Compose quality-aware × Kelly multipliers exactly as the live executor does:
 *   sizeUsdt = baseUsdt × qualityMult × kellyMult
 */
export function computeSizeUsdt(
  base: number,
  quality: number,
  closedPnls: number[],
  sizing: BacktestSizing,
): { usdt: number; qualityMult: number; kellyMult: number } {
  const qualityMult = sizing.qualityAwareSizing
    ? Math.max(0, sizing.qualitySizeFloorPct / 100) +
      (1 - Math.max(0, sizing.qualitySizeFloorPct / 100)) * Math.min(1, Math.max(0, quality))
    : 1.0;
  const kellyMult = computeKellyMultiplier(closedPnls, sizing.kelly).multiplier;
  return { usdt: base * qualityMult * kellyMult, qualityMult, kellyMult };
}

// ── Evaluator dispatch ───────────────────────────────────────────────────────

function defaultSignalParams(): SignalParams {
  return {
    bbPeriod: 20,
    bbStdDev: 2.0,
    rsiPeriod: 14,
    rsiOversold: 30,
    rsiOverbought: 70,
    volumeSpikeMultiplier: 1.5,
    longOnly: false,
    emaFilterEnabled: false,
    emaPeriod: 50,
  };
}

interface EvaluatorContext {
  /** HTF candles for CHT (1h candles when LTF is 5m, etc.). May be empty. */
  htfCandles: Candle[];
  /** BTC same-TF reference for CHT correlation/spread. May be empty. */
  btcCandles: Candle[];
  /** 15m candles for MRX HTF gate. */
  candles15m: Candle[];
  /** 1h candles for MRX OB confluence. */
  candles1h: Candle[];
  /** Optional CoinGecko-style market context for CHT spread component. */
  marketContext: CHTMarketContext | null;
  /** Per-bar slice helper — returns the prefix of the auxiliary series that does not look ahead. */
  sliceAtTime: (series: Candle[], cutoffTime: number) => Candle[];
}

function dispatchEvaluator(
  strategy: BacktestStrategy,
  gateSymbol: string,
  windowCandles: Candle[],
  cfg: BacktestConfig,
  ctx: EvaluatorContext,
): ScalperSignal | null {
  const cutoff = windowCandles[windowCandles.length - 1].time;
  switch (strategy) {
    case "bb_rsi": {
      const params = { ...defaultSignalParams(), ...cfg.signalParams, longOnly: cfg.longOnly ?? cfg.signalParams?.longOnly ?? false };
      return evaluateSignal(gateSymbol, windowCandles, params);
    }
    case "cht": {
      const htf = ctx.sliceAtTime(ctx.htfCandles, cutoff);
      const btc = ctx.sliceAtTime(ctx.btcCandles, cutoff);
      return evaluateCHTSignal(gateSymbol, windowCandles, htf, btc, {
        longOnly: cfg.longOnly ?? false,
        marketContext: ctx.marketContext,
      });
    }
    case "mrx-hybrid": {
      const c15 = ctx.sliceAtTime(ctx.candles15m, cutoff);
      const c1h = ctx.sliceAtTime(ctx.candles1h, cutoff);
      const { signal } = evaluateMRXSignal(
        gateSymbol,
        windowCandles,
        c15,
        c1h,
        cfg.mrxTf ?? "3m",
        cfg.mrxThresholds ?? MRX_DEFAULT_THRESHOLDS,
      );
      return signal;
    }
    case "smc_mss":
      return evaluateSMCSignal(gateSymbol, windowCandles, { longOnly: cfg.longOnly ?? false });
    default:
      return null;
  }
}

// ── Trade simulation ─────────────────────────────────────────────────────────

/**
 * Walks future candles starting at `bars[0]` (which is the entry bar) and
 * returns the first TP/SL hit + the bar at which it happened. Both legs are
 * checked per bar; when both TP and SL are inside the same candle's
 * high-low range we resolve pessimistically (SL wins) — a realistic
 * assumption since intra-bar sequence is unknown without tick data.
 */
export function simulateExit(
  side: "buy" | "sell",
  entryPrice: number,
  tpPrice: number | null,
  slPrice: number | null,
  /** Default SL if strategy didn't supply one (% from entry). */
  fallbackSlPct: number,
  /** Default TP if strategy didn't supply one (% from entry). */
  fallbackTpPct: number,
  bars: Candle[],
  maxHoldBars: number,
): { exitPrice: number; exitTime: number; reason: "tp" | "sl" | "eod" } {
  const tp = tpPrice ?? (side === "buy"
    ? entryPrice * (1 + fallbackTpPct / 100)
    : entryPrice * (1 - fallbackTpPct / 100));
  const sl = slPrice ?? (side === "buy"
    ? entryPrice * (1 - fallbackSlPct / 100)
    : entryPrice * (1 + fallbackSlPct / 100));

  const limit = Math.min(bars.length, maxHoldBars);
  for (let i = 0; i < limit; i++) {
    const b = bars[i];
    if (side === "buy") {
      const hitSl = b.low <= sl;
      const hitTp = b.high >= tp;
      if (hitSl && hitTp) return { exitPrice: sl, exitTime: b.time, reason: "sl" };
      if (hitSl)          return { exitPrice: sl, exitTime: b.time, reason: "sl" };
      if (hitTp)          return { exitPrice: tp, exitTime: b.time, reason: "tp" };
    } else {
      const hitSl = b.high >= sl;
      const hitTp = b.low  <= tp;
      if (hitSl && hitTp) return { exitPrice: sl, exitTime: b.time, reason: "sl" };
      if (hitSl)          return { exitPrice: sl, exitTime: b.time, reason: "sl" };
      if (hitTp)          return { exitPrice: tp, exitTime: b.time, reason: "tp" };
    }
  }
  // EOD: close at the last bar's close.
  const last = bars[limit - 1] ?? bars[bars.length - 1];
  return { exitPrice: last.close, exitTime: last.time, reason: "eod" };
}

// ── Engine ────────────────────────────────────────────────────────────────────

export interface RunBacktestArgs {
  gateSymbol: string;
  startTime: string | Date;
  endTime:   string | Date;
  timeframe: string;
  strategy:  BacktestStrategy;
  config:    BacktestConfig;
  sizing:    BacktestSizing;
  /** Inject candles directly (testing) — skips the network fetch entirely. */
  candles?: Candle[];
  /** Override the auxiliary HTF/BTC/15m/1h fetches (testing). */
  auxCandles?: {
    htf?: Candle[];
    btc?: Candle[];
    c15m?: Candle[];
    c1h?: Candle[];
    marketContext?: CHTMarketContext | null;
  };
  /** Stop on this number of trades (safety / testing). */
  maxTrades?: number;
  /** Custom fetch impl (testing). */
  fetchImpl?: typeof fetch;
  /** Bars to hold before forcing an EOD exit. Default = candles remaining. */
  maxHoldBars?: number;
}

/** Default fallback SL/TP when an evaluator doesn't supply explicit levels. */
const DEFAULT_TP_PCT = 0.5; // 0.5% — small to fit a wide variety of strategies
const DEFAULT_SL_PCT = 0.5;

export async function runBacktest(args: RunBacktestArgs): Promise<BacktestResult> {
  const startMs = (args.startTime instanceof Date ? args.startTime : new Date(args.startTime)).getTime();
  const endMs   = (args.endTime   instanceof Date ? args.endTime   : new Date(args.endTime  )).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error(`Invalid time range: start=${args.startTime} end=${args.endTime}`);
  }

  // ── Candle ingest ────────────────────────────────────────────────────────
  const candles = args.candles ?? await fetchHistoricalCandles(
    args.gateSymbol, args.timeframe, startMs, endMs, args.fetchImpl,
  );

  const meta: BacktestResult["meta"] = {
    gateSymbol:  args.gateSymbol,
    timeframe:   args.timeframe,
    startTime:   new Date(startMs).toISOString(),
    endTime:     new Date(endMs).toISOString(),
    strategy:    args.strategy,
    candleCount: candles.length,
  };

  if (candles.length === 0) {
    return { trades: [], summary: emptySummary(), meta };
  }

  // ── Min candles needed before the first evaluator call ───────────────────
  const minBars = strategyMinBars(args.strategy);

  const ctx: EvaluatorContext = {
    htfCandles: args.auxCandles?.htf  ?? [],
    btcCandles: args.auxCandles?.btc  ?? [],
    candles15m: args.auxCandles?.c15m ?? [],
    candles1h:  args.auxCandles?.c1h  ?? [],
    marketContext: args.auxCandles?.marketContext ?? null,
    sliceAtTime: (series, cutoff) => {
      if (series.length === 0) return series;
      // Largest prefix where bar.time <= cutoff. The series is sorted by time.
      let hi = series.length;
      while (hi > 0 && series[hi - 1].time > cutoff) hi--;
      return hi === series.length ? series : series.slice(0, hi);
    },
  };

  // ── Walk-forward loop ────────────────────────────────────────────────────
  const closedPnls: number[] = [];
  const trades: BacktestTrade[] = [];
  let inPosition = false;
  let earliestNextOpenIdx = 0;
  const maxTrades = args.maxTrades ?? Number.POSITIVE_INFINITY;

  for (let i = minBars; i < candles.length - 1; i++) {
    if (trades.length >= maxTrades) break;
    // Single-position model — wait for the prior trade to close before
    // arming the evaluator again. We track the bar where the previous exit
    // resolved and only re-evaluate from there on.
    if (inPosition) continue;
    if (i < earliestNextOpenIdx) continue;

    const window = candles.slice(0, i + 1);
    const signal = dispatchEvaluator(args.strategy, args.gateSymbol, window, args.config, ctx);
    if (!signal) continue;

    // ── Entry: next bar's open (no look-ahead). ───────────────────────────
    const entryBar = candles[i + 1];
    if (!entryBar) break;
    const quality = signal.quality ?? 0;
    const { usdt: sizeUsdt, qualityMult, kellyMult } =
      computeSizeUsdt(args.sizing.baseUsdt, quality, closedPnls, args.sizing);
    if (sizeUsdt <= 0) continue;

    const entryPrice = entryBar.open;
    const quantity = sizeUsdt / entryPrice;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    // ── Exit: walk subsequent bars looking for TP/SL hit. ─────────────────
    const remaining = candles.slice(i + 2);
    const holdCap = args.maxHoldBars ?? remaining.length;
    if (remaining.length === 0) {
      // No bars left to evaluate — close at entry bar's close.
      const exit = { exitPrice: entryBar.close, exitTime: entryBar.time, reason: "eod" as const };
      pushTrade(exit, entryBar);
      earliestNextOpenIdx = i + 2;
      continue;
    }
    const exit = simulateExit(
      signal.side,
      entryPrice,
      signal.tpPrice ?? null,
      signal.slPrice ?? null,
      DEFAULT_SL_PCT,
      DEFAULT_TP_PCT,
      remaining,
      holdCap,
    );
    pushTrade(exit, entryBar);

    function pushTrade(
      ex: { exitPrice: number; exitTime: number; reason: "tp" | "sl" | "eod" },
      eBar: Candle,
    ) {
      const { gross, net, fees } = pnlFromFills({
        side: signal!.side,
        entryPrice,
        closePrice: ex.exitPrice,
        quantity,
      });
      const trade: BacktestTrade = {
        entryTime: eBar.time,
        entryPrice,
        exitTime:  ex.exitTime,
        exitPrice: ex.exitPrice,
        side:      signal!.side,
        quantity,
        notionalUsdt: sizeUsdt,
        gross, fees, net,
        quality,
        reason:    ex.reason,
        tpPrice:   signal!.tpPrice ?? null,
        slPrice:   signal!.slPrice ?? null,
        kellyMultiplier:   kellyMult,
        qualityMultiplier: qualityMult,
      };
      trades.push(trade);
      closedPnls.push(net);
      inPosition = false;
      // Skip the next-open candle and resume scanning from the bar AFTER the exit
      // to avoid stacking signals on the same hot patch (matches the live cooldown spirit).
      const exitIdx = Math.max(i + 2, findBarIndex(candles, ex.exitTime));
      earliestNextOpenIdx = exitIdx + 1;
    }
  }

  return {
    trades,
    summary: summarize(trades),
    meta,
  };
}

function findBarIndex(candles: Candle[], time: number): number {
  // Linear scan from end — exits usually land within a few bars of the search start.
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time <= time) return i;
  }
  return -1;
}

function strategyMinBars(strategy: BacktestStrategy): number {
  switch (strategy) {
    case "bb_rsi":     return 25;    // bbPeriod + a couple bars
    case "cht":        return 80;    // CHT requires 80 LTF bars
    case "mrx-hybrid": return 30;    // MRX requires 30 primary bars + RSI prevBar
    case "smc_mss":    return 20;    // SWING_LOOKBACK*2 + 10
    default:           return 50;
  }
}

function emptySummary(): BacktestSummary {
  return {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    netPnl: 0, grossPnl: 0, feesPaid: 0,
    avgQuality: 0, sharpe: 0, maxDrawdown: 0,
    largestWin: 0, largestLoss: 0,
  };
}

export function summarize(trades: BacktestTrade[]): BacktestSummary {
  if (trades.length === 0) return emptySummary();
  const wins   = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net < 0);
  const netPnl   = trades.reduce((a, t) => a + t.net,   0);
  const grossPnl = trades.reduce((a, t) => a + t.gross, 0);
  const feesPaid = trades.reduce((a, t) => a + t.fees,  0);
  const avgQuality = trades.reduce((a, t) => a + t.quality, 0) / trades.length;

  // Equity curve over closed trades.
  const cum: number[] = [];
  let running = 0;
  for (const t of trades) { running += t.net; cum.push(running); }
  const sharpe = tradeSharpe(trades.map((t) => t.net));
  const dd     = maxDrawdown(cum);
  const largestWin  = wins.length   ? Math.max(...wins.map((t) => t.net))            : 0;
  const largestLoss = losses.length ? Math.min(...losses.map((t) => t.net))          : 0;

  return {
    totalTrades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: wins.length / trades.length,
    netPnl, grossPnl, feesPaid,
    avgQuality, sharpe,
    maxDrawdown: dd,
    largestWin, largestLoss,
  };
}
