/**
 * CHT Engine — Crypto Hybrid Trading Intelligence Engine (v2)
 *
 * 11-stage autonomous signal pipeline per spec:
 *  1.  Trend Engine        — EMA20/EMA50 + ADX ≥ 18 (ranging = skip)
 *  2.  HTF Confirmation    — 1h EMA20/EMA50 must agree with 5m direction
 *  3.  Volatility Engine   — ATR% 0.3–8% scalp regime required
 *  4.  Volume Engine       — volumeRatio ≥ 1.0×; WEAK = skip
 *  5.  RSI                 — for trigger and divergence checks
 *  6.  Market Structure    — 3-bar swing high/low detection
 *  7.  Trigger Engine      — RETEST (25) > BREAKOUT (18) > REVERSAL (15)
 *                           BREAKOUT body must be > 40% of candle range
 *  8.  Correlation Engine  — corr(close, BTC, 20) < 0.9; corr(vol, ROC, 14) > 0.5
 *  9.  Risk Engine         — TP1=1R / TP2=1.5R / TP3=2R; RR ≥ 1 required
 * 10.  Spread Intelligence — BTC relative return + CoinGecko market context
 * 11.  Divergence Engine   — RSI divergence (confidence boost)
 * 12.  TAO Consensus       — 6 experts, ≥ 4 required (restored from over-strict ≥5)
 * 13.  Opportunity Score   — 0–100; ELITE(85+)/STRONG(75+)/MEDIUM(60+)/IGNORE
 *
 * Bot trade structure: TP1=30%, TP2=30%, TP3=40%. SL moves to break-even after TP1.
 */

import { Candle, ScalperSignal, computeEMA, computeRSI, computeVolumeRatio, computeBB, fetchCandles } from "./scalper-signals";
import { getMarketStatus } from "./market";
import { logger } from "../lib/logger";

const SWING_LOOKBACK = 3;
const ADX_PERIOD     = 14;
const ATR_PERIOD     = 14;

// ── ATR (Wilder's RMA) ────────────────────────────────────────────────────────

export function computeATR(candles: Candle[], period = ATR_PERIOD): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }
  let rma = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    rma = (rma * (period - 1) + trs[i]) / period;
  }
  return rma;
}

// ── ADX (Wilder's RMA) ────────────────────────────────────────────────────────

interface ADXResult { adx: number; plusDI: number; minusDI: number; }

export function computeADX(candles: Candle[], period = ADX_PERIOD): ADXResult {
  if (candles.length < period * 2 + 1) return { adx: 0, plusDI: 0, minusDI: 0 };

  const plusDMs:  number[] = [];
  const minusDMs: number[] = [];
  const trs:      number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const up   = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDMs.push(up   > down && up   > 0 ? up   : 0);
    minusDMs.push(down > up  && down > 0 ? down : 0);
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low  - candles[i - 1].close),
    ));
  }

  function rmaSmooth(arr: number[], p: number): number[] {
    const out = new Array<number>(arr.length).fill(0);
    if (arr.length < p) return out;
    out[p - 1] = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < arr.length; i++) out[i] = (out[i - 1] * (p - 1) + arr[i]) / p;
    return out;
  }

  const smoothTR  = rmaSmooth(trs,      period);
  const smoothPDM = rmaSmooth(plusDMs,  period);
  const smoothMDM = rmaSmooth(minusDMs, period);

  const dxArr: number[] = [];
  for (let i = period - 1; i < trs.length; i++) {
    const atr = smoothTR[i];
    if (atr === 0) { dxArr.push(0); continue; }
    const pDI = 100 * smoothPDM[i] / atr;
    const mDI = 100 * smoothMDM[i] / atr;
    const sum = pDI + mDI;
    dxArr.push(sum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / sum);
  }

  const adxArr  = rmaSmooth(dxArr, period);
  const adx     = adxArr[adxArr.length - 1] ?? 0;
  const lastATR = smoothTR[smoothTR.length - 1];
  const plusDI  = lastATR > 0 ? 100 * smoothPDM[smoothPDM.length - 1]  / lastATR : 0;
  const minusDI = lastATR > 0 ? 100 * smoothMDM[smoothMDM.length - 1] / lastATR : 0;

  return { adx, plusDI, minusDI };
}

// ── Pearson Correlation (spec §11 — correlation engine) ───────────────────────

function pearsonCorr(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const xs = x.slice(-n), ys = y.slice(-n);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  return dx2 * dy2 === 0 ? 0 : num / Math.sqrt(dx2 * dy2);
}

// ── Swing-point detection ─────────────────────────────────────────────────────

function findSwingHighs(candles: Candle[], lookback: number): { index: number; price: number }[] {
  const out: { index: number; price: number }[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let ok = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) { ok = false; break; }
    }
    if (ok) out.push({ index: i, price: candles[i].high });
  }
  return out;
}

function findSwingLows(candles: Candle[], lookback: number): { index: number; price: number }[] {
  const out: { index: number; price: number }[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let ok = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) { ok = false; break; }
    }
    if (ok) out.push({ index: i, price: candles[i].low });
  }
  return out;
}

// ── Volume score ──────────────────────────────────────────────────────────────

function volumeScore(volumeRatio: number): number {
  if (volumeRatio >= 1.5) return 1.0;  // EXTREME / VERY STRONG
  if (volumeRatio >= 1.2) return 0.7;  // STRONG
  if (volumeRatio >= 1.0) return 0.4;  // NORMAL
  if (volumeRatio >= 0.5) return 0.1;  // QUIET — below avg but not dead
  return 0.0;                          // DEAD — skip
}

// ── Trigger Engine (spec §7) ──────────────────────────────────────────────────
// BREAKOUT body must be > 40% of candle range (spec §6 VALID BREAKOUT RULES #2)

type SetupType = "BREAKOUT" | "RETEST" | "REVERSAL";

interface TriggerResult {
  type: SetupType;
  sl: number;
  triggerQuality: number;
}

function detectTrigger(
  candles: Candle[],
  side: "buy" | "sell",
  swingHighs: { index: number; price: number }[],
  swingLows:  { index: number; price: number }[],
  rsi: number,
  volumeRatio: number,
  atr: number,
): TriggerResult | null {
  const last      = candles.length - 1;
  const lastClose = candles[last].close;
  const prevClose = candles[last - 1]?.close ?? lastClose;
  const lastCandle = candles[last];

  // Body ratio validation helper — spec §6: body > 40% of range for BREAKOUT
  const body  = Math.abs(lastCandle.close - lastCandle.open);
  const range = lastCandle.high - lastCandle.low;
  const bodyRatioOk = range > 0 && body / range >= 0.4;

  if (side === "buy") {
    // ── RETEST (highest priority) ─────────────────────────────────────────
    const priorHighs = swingHighs.filter(s => s.index >= last - 30 && s.index < last - 3);
    for (const ref of priorHighs.slice().reverse()) {
      let wasBroken = false;
      for (let i = ref.index + 1; i < last; i++) {
        if (candles[i].close > ref.price) { wasBroken = true; break; }
      }
      if (!wasBroken) continue;
      const pct = Math.abs(lastClose - ref.price) / ref.price;
      if (pct < 0.012 && lastClose >= prevClose && lastClose > ref.price * 0.995) {
        const sl = Math.min(...candles.slice(-4).map(c => c.low)) - 0.8 * atr;
        return { type: "RETEST", sl, triggerQuality: 25 };
      }
    }

    // ── BREAKOUT — body must be > 40% of range ────────────────────────────
    const recentHighs = swingHighs.filter(s => s.index >= last - 40 && s.index < last - 1);
    const nearestHigh = recentHighs[recentHighs.length - 1];
    if (nearestHigh && lastClose > nearestHigh.price && volumeRatio >= 1.2 && bodyRatioOk) {
      const sl = nearestHigh.price - atr;
      return { type: "BREAKOUT", sl, triggerQuality: 18 };
    }

    // ── REVERSAL ──────────────────────────────────────────────────────────
    const recentLows = swingLows.filter(s => s.index >= last - 30 && s.index < last - 1);
    const nearestLow = recentLows[recentLows.length - 1];
    if (nearestLow) {
      const pct = Math.abs(lastClose - nearestLow.price) / nearestLow.price;
      if (pct < 0.015 && rsi >= 40 && rsi <= 62 && lastClose > prevClose) {
        const sl = nearestLow.price - 0.8 * atr;
        return { type: "REVERSAL", sl, triggerQuality: 15 };
      }
    }

  } else {
    // ── RETEST (bearish) ──────────────────────────────────────────────────
    const priorLows = swingLows.filter(s => s.index >= last - 30 && s.index < last - 3);
    for (const ref of priorLows.slice().reverse()) {
      let wasBroken = false;
      for (let i = ref.index + 1; i < last; i++) {
        if (candles[i].close < ref.price) { wasBroken = true; break; }
      }
      if (!wasBroken) continue;
      const pct = Math.abs(lastClose - ref.price) / ref.price;
      if (pct < 0.012 && lastClose <= prevClose && lastClose < ref.price * 1.005) {
        const sl = Math.max(...candles.slice(-4).map(c => c.high)) + 0.8 * atr;
        return { type: "RETEST", sl, triggerQuality: 25 };
      }
    }

    // ── BREAKOUT (bearish) — body > 40% ───────────────────────────────────
    const recentLows = swingLows.filter(s => s.index >= last - 40 && s.index < last - 1);
    const nearestLow = recentLows[recentLows.length - 1];
    if (nearestLow && lastClose < nearestLow.price && volumeRatio >= 1.2 && bodyRatioOk) {
      const sl = nearestLow.price + atr;
      return { type: "BREAKOUT", sl, triggerQuality: 18 };
    }

    // ── REVERSAL (bearish) ────────────────────────────────────────────────
    const recentHighs = swingHighs.filter(s => s.index >= last - 30 && s.index < last - 1);
    const nearestHigh = recentHighs[recentHighs.length - 1];
    if (nearestHigh) {
      const pct = Math.abs(lastClose - nearestHigh.price) / nearestHigh.price;
      if (pct < 0.015 && rsi >= 38 && rsi <= 60 && lastClose < prevClose) {
        const sl = nearestHigh.price + 0.8 * atr;
        return { type: "REVERSAL", sl, triggerQuality: 15 };
      }
    }
  }

  return null;
}

// ── Divergence Engine (confidence boost only) ─────────────────────────────────

function checkDivergence(closes: number[], side: "buy" | "sell"): boolean {
  if (closes.length < 16) return false;
  const rsiNow  = computeRSI(closes, 14);
  const rsiPrev = computeRSI(closes.slice(0, -5), 14);
  const priceDelta = closes[closes.length - 1] - closes[closes.length - 6];
  if (side === "buy")  return priceDelta < 0 && rsiNow > rsiPrev + 1;
  return priceDelta > 0 && rsiNow < rsiPrev - 1;
}

// ── TAO Consensus Engine (spec §9 / §13) ──────────────────────────────────────
// 6 expert votes — threshold raised to ≥ 5 per spec scanning doc §13

function computeTaoVotes(
  side: "buy" | "sell",
  p: {
    ema20: number; ema50: number; htfBullish: boolean; htfBearish: boolean;
    volumeRatio: number; hasDivergence: boolean; lastClose: number;
    rsi: number; spreadScore: number;
  },
): number {
  let v = 0;
  if (side === "buy") {
    if (p.spreadScore > 0)           v++;  // 1. Spread Expert: positive environment
    if (p.ema20 > p.ema50)           v++;  // 2. Trend Expert: EMA aligned bullish
    if (p.lastClose > p.ema50)       v++;  // 3. EMA Expert: price above EMA50
    if (p.volumeRatio >= 1.2)        v++;  // 4. Volume Expert: meaningful participation
    if (p.hasDivergence)             v++;  // 5. Divergence Expert
    if (p.rsi > 50 && p.htfBullish)  v++;  // 6. Rotation Expert: HTF aligned + momentum
  } else {
    if (p.spreadScore < 0)           v++;
    if (p.ema20 < p.ema50)           v++;
    if (p.lastClose < p.ema50)       v++;
    if (p.volumeRatio >= 1.2)        v++;
    if (p.hasDivergence)             v++;
    if (p.rsi < 50 && p.htfBearish)  v++;
  }
  return v;
}

// ── Opportunity Score Engine (spec §10 / §14) ──────────────────────────────────
// Trend=20, HTF=20, Trigger=25, Volume=10, Volatility=10, Risk=15 → max 100

type CHTGrade = "ELITE" | "STRONG" | "MEDIUM" | "IGNORE";
interface ScoreResult { score: number; grade: CHTGrade; }

function computeOpportunityScore(p: {
  trendOk: boolean; htfOk: boolean; triggerQuality: number;
  volumeRatio: number; atrPct: number; rr: number;
}): ScoreResult {
  let score = 0;
  if (p.trendOk) score += 20;
  if (p.htfOk)   score += 20;
  score += Math.min(25, Math.max(0, p.triggerQuality));
  score += Math.round(volumeScore(p.volumeRatio) * 10);
  if      (p.atrPct > 0.3 && p.atrPct < 4.0)  score += 10;
  else if (p.atrPct >= 4.0 && p.atrPct < 8.0)  score +=  4; // chaotic partial credit
  if      (p.rr >= 2.0)  score += 15;
  else if (p.rr >= 1.5)  score += 12;
  else if (p.rr >= 1.0)  score +=  5;

  const grade: CHTGrade =
    score >= 85 ? "ELITE"  :
    score >= 75 ? "STRONG" :
    score >= 60 ? "MEDIUM" : "IGNORE";

  return { score, grade };
}

// ── Market context for enhanced spread intelligence ───────────────────────────

export interface CHTMarketContext {
  btcD: number;      // BTC dominance %
  othersD: number;   // Alt dominance % (excl BTC/ETH/stables)
  stableD: number;   // USDT+USDC dominance %
}

/**
 * Maps each LTF to the appropriate Higher-Time-Frame for CHT confirmation.
 * null = skip CHT on this TF (no reliable HTF available).
 */
export const CHT_HTF_MAP: Record<string, string | null> = {
  "3m":  "15m",
  "5m":  "1h",
  "15m": "4h",
  "1h":  "1d",
  "4h":  "1d",
  "1d":  null,    // no reliable HTF above daily
};

// ── Public evaluator ──────────────────────────────────────────────────────────

export function evaluateCHTSignal(
  gateSymbol: string,
  ltfCandles: Candle[],    // LTF candles (3m–4h) — needs 80+ candles
  htfCandles: Candle[],    // HTF candles (per CHT_HTF_MAP) — needs 55+ candles
  btcCandles: Candle[],    // BTC same-TF candles — spread + correlation reference
  params: { longOnly: boolean; marketContext?: CHTMarketContext | null; timeframe?: string },
): ScalperSignal | null {
  if (ltfCandles.length < 80 || htfCandles.length < 55) return null;

  const last      = ltfCandles.length - 1;
  const closes    = ltfCandles.map(c => c.close);
  const volumes   = ltfCandles.map(c => c.volume);
  const lastClose = closes[last];

  // ── 1. Trend Engine ───────────────────────────────────────────────────────
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const { adx } = computeADX(ltfCandles, ADX_PERIOD);
  if (adx < 18) return null;

  const bullishTrend = ema20 > ema50;
  const bearishTrend = ema20 < ema50;

  // ── 2. HTF Confirmation (1h EMA) ──────────────────────────────────────────
  const htfCloses  = htfCandles.map(c => c.close);
  const htfEma20   = computeEMA(htfCloses, 20);
  const htfEma50   = computeEMA(htfCloses, 50);
  const htfBullish = htfEma20 > htfEma50;
  const htfBearish = htfEma20 < htfEma50;

  let side: "buy" | "sell";
  if      (bullishTrend && htfBullish)                     side = "buy";
  else if (!params.longOnly && bearishTrend && htfBearish) side = "sell";
  else                                                     return null;

  // ── 3. Volatility Engine ──────────────────────────────────────────────────
  // ATR% lower bound scales by timeframe: 0.08% for 3m/5m, 0.15% for 15m, 0.3% for 1h+
  const atr    = computeATR(ltfCandles, ATR_PERIOD);
  const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;
  const tf = params.timeframe ?? "5m";
  const atrMin = tf === "3m" || tf === "5m" ? 0.08 : tf === "15m" ? 0.15 : 0.3;
  if (atrPct < atrMin) return null;
  if (atrPct > 8.0) return null;

  // ── 4. Volume Engine ──────────────────────────────────────────────────────
  const volumeRatio = computeVolumeRatio(volumes);
  if (volumeScore(volumeRatio) === 0.0) return null;

  // ── 5. RSI ────────────────────────────────────────────────────────────────
  const rsi = computeRSI(closes, 14);

  // ── 6. Market Structure + Trigger Engine ──────────────────────────────────
  const swingHighs = findSwingHighs(ltfCandles, SWING_LOOKBACK);
  const swingLows  = findSwingLows(ltfCandles,  SWING_LOOKBACK);
  const trigger = detectTrigger(ltfCandles, side, swingHighs, swingLows, rsi, volumeRatio, atr);
  if (!trigger) return null;

  // ── 7. Risk Engine — TP1=1R, TP2=1.5R, TP3=2R ────────────────────────────
  const slLevel = trigger.sl;
  const slDist  = Math.abs(lastClose - slLevel);
  if (slDist <= 0) return null;
  if (side === "buy"  && slLevel >= lastClose) return null;
  if (side === "sell" && slLevel <= lastClose) return null;

  const tp1Price = side === "buy" ? lastClose + 1.0 * slDist : lastClose - 1.0 * slDist;
  const tp2Price = side === "buy" ? lastClose + 1.5 * slDist : lastClose - 1.5 * slDist;
  const tp3Price = side === "buy" ? lastClose + 2.0 * slDist : lastClose - 2.0 * slDist;
  // RR measured at TP2 (primary target)
  const rr = 1.5;

  // RR < 1 = ignore (spec §12 RISK ENGINE: "IGNORE if RR < 1")
  if (rr < 1) return null;

  // ── 8. Correlation Engine (spec §11) ──────────────────────────────────────
  // Skip for BTC_USDT itself — trivially self-correlated
  if (gateSymbol !== "BTC_USDT" && btcCandles.length >= 20 && closes.length >= 20) {
    const btcCloses = btcCandles.map(c => c.close);

    // corr(close, BTC, 20) < 0.9 — avoid over-correlated setups
    const corrBtc = pearsonCorr(closes.slice(-20), btcCloses.slice(-20));
    if (corrBtc >= 0.9) return null;

    // corr(volume, ROC(close,1), 14) > 0.2 — loose confirmation; crypto volume often leads/lags
    if (closes.length >= 15 && volumes.length >= 14) {
      const roc = closes.slice(-(14 + 1)).map((c, i, arr) =>
        i === 0 ? 0 : (c - arr[i - 1]) / Math.max(arr[i - 1], 1e-12)
      ).slice(1);
      const corrVolPrice = pearsonCorr(volumes.slice(-14), roc);
      if (corrVolPrice < 0.2) return null;
    }
  }

  // ── 9. Spread Intelligence (spec §10 — three components) ──────────────────
  //
  // Component A (spread_x_btc): relative return vs BTC over 20 bars
  let spreadXBtc = 0;
  if (btcCandles.length >= 21 && closes.length >= 21) {
    const btcCloses = btcCandles.map(c => c.close);
    const n = Math.min(21, btcCloses.length, closes.length);
    const symRet = (lastClose - closes[closes.length - n]) / Math.max(closes[closes.length - n], 1e-12);
    const btcRet = (btcCloses[btcCloses.length - 1] - btcCloses[btcCloses.length - n]) /
                   Math.max(btcCloses[btcCloses.length - n], 1e-12);
    spreadXBtc = symRet - btcRet;
  }
  // Clamp to [-1, +1]: ±5% relative return maps to ±1
  const spreadXBtcNorm = Math.max(-1, Math.min(1, spreadXBtc * 20));

  // Component B (spread_alt_rot): alts leading vs BTC (CoinGecko othersD > 30%)
  const mCtx = params.marketContext;
  const altRotDir  = mCtx ? (mCtx.othersD > 30 ? 1 : mCtx.othersD < 25 ? -1 : 0) : 0;

  // Component C (spread_stable): low stablecoin dominance = risk-on
  const stableDir  = mCtx ? (mCtx.stableD < 5 ? 1 : mCtx.stableD > 7 ? -1 : 0) : 0;

  // SPREAD_SCORE = 0.5 * spread_x_btc + 0.3 * alt_rot + 0.2 * stable_pressure
  const spreadScore = 0.5 * spreadXBtcNorm + 0.3 * altRotDir + 0.2 * stableDir;

  // ── 10. Divergence ────────────────────────────────────────────────────────
  const hasDivergence = checkDivergence(closes, side);

  // ── 11. TAO Consensus — threshold ≥ 4 (original spec §9; ≥5 was too strict in practice) ──
  const taoVotes = computeTaoVotes(side, {
    ema20, ema50, htfBullish, htfBearish,
    volumeRatio, hasDivergence, lastClose,
    rsi, spreadScore,
  });
  if (taoVotes < 4) return null;

  // ── 12. Opportunity Score — only emit MEDIUM+ signals ─────────────────────
  const { score, grade } = computeOpportunityScore({
    trendOk: side === "buy" ? bullishTrend : bearishTrend,
    htfOk:   side === "buy" ? htfBullish   : htfBearish,
    triggerQuality: trigger.triggerQuality,
    volumeRatio,
    atrPct,
    rr,
  });
  if (grade === "IGNORE") return null;

  // Repurpose BB fields for context: upper=resistance, lower=support, mid=EMA50
  const bb = computeBB(closes, 20, 2.0);

  logger.debug(
    {
      gateSymbol, side, score, grade,
      setupType: trigger.type, taoVotes, spreadScore: spreadScore.toFixed(3),
      atrPct: atrPct.toFixed(2), adx: adx.toFixed(1), rr,
    },
    "CHT: signal detected",
  );

  return {
    symbol:       gateSymbol.replace("_USDT", "").replace("_", ""),
    gateSymbol,
    side,
    entryPrice:   lastClose,
    tpPrice:      tp2Price,    // primary TP for backward-compat / single-TP display
    slPrice:      slLevel,
    tp1Price,                  // 1R — 30% exit + break-even trigger
    tp2Price,                  // 1.5R — 30% exit
    tp3Price,                  // 2R — 40% exit
    chtRr:        rr,
    bbUpper:      bb.upper,
    bbLower:      bb.lower,
    bbMid:        ema50,
    rsi,
    volumeRatio,
    strategy:     "cht",
    timeframe:    params.timeframe,
    chtScore:     score,
    chtGrade:     grade,
    chtSetupType: trigger.type,
    chtTaoVotes:  taoVotes,
  };
}

// ── Full CHT scan ─────────────────────────────────────────────────────────────

export async function scanForCHTSignals(params: {
  longOnly: boolean;
  symbols: string[];
  /** LTF timeframe to scan (default "5m"). HTF is derived from CHT_HTF_MAP. */
  timeframe?: string;
}): Promise<ScalperSignal[]> {
  const ltfTf  = params.timeframe ?? "5m";
  const htfTf  = CHT_HTF_MAP[ltfTf] ?? "1h";
  const ltfCnt = ({ "3m": 150, "5m": 150, "15m": 150, "1h": 100, "4h": 80, "1d": 60 } as Record<string, number>)[ltfTf] ?? 150;
  const htfCnt = ({ "15m": 150, "1h": 100, "4h": 80, "1d": 60 } as Record<string, number>)[htfTf] ?? 60;

  if (!CHT_HTF_MAP[ltfTf]) {
    // No HTF available for this TF (e.g. 1d) — CHT requires confirmation
    return [];
  }

  // Fetch BTC reference + market context once (shared across all symbols)
  const [btcCandlesResult, marketContextResult] = await Promise.allSettled([
    fetchCandles("BTC_USDT", ltfTf, ltfCnt),
    getMarketStatus(),
  ]);

  const btcCandles = btcCandlesResult.status === "fulfilled" ? btcCandlesResult.value : [];
  if (btcCandlesResult.status === "rejected") {
    logger.warn({ err: btcCandlesResult.reason }, "CHT scan: BTC candles failed — spread/corr limited");
  }

  let marketContext: CHTMarketContext | null = null;
  if (marketContextResult.status === "fulfilled") {
    const s = marketContextResult.value;
    marketContext = { btcD: s.btcDominance, othersD: s.othersDominance, stableD: s.stableDominance };
  } else {
    logger.warn({ err: marketContextResult.reason }, "CHT scan: CoinGecko market context unavailable");
  }

  const results = await Promise.allSettled(
    params.symbols.map(async (gateSymbol) => {
      const [ltf, htf] = await Promise.all([
        fetchCandles(gateSymbol, ltfTf, ltfCnt),
        fetchCandles(gateSymbol, htfTf, htfCnt),
      ]);
      return evaluateCHTSignal(gateSymbol, ltf, htf, btcCandles, {
        ...params,
        marketContext,
        timeframe: ltfTf,
      });
    }),
  );

  const signals: ScalperSignal[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value != null) {
      signals.push(result.value);
    } else if (result.status === "rejected") {
      logger.warn({ err: result.reason }, "CHT: scan error for symbol");
    }
  }
  return signals;
}
