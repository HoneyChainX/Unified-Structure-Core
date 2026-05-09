/**
 * CHT Engine — Crypto Hybrid Trading Intelligence Engine
 *
 * Multi-factor signal engine combining:
 *  - Trend Engine        (EMA20/EMA50 + ADX trending filter)
 *  - HTF Confirmation    (5m → 1h EMA alignment)
 *  - Market Structure    (swing high/low breakouts)
 *  - Trigger Engine      (BREAKOUT / RETEST / REVERSAL — graded 25/18/15)
 *  - Volume Engine       (volumeRatio scored VERY STRONG / GOOD / MEDIUM / WEAK)
 *  - Volatility Engine   (ATR% 0.3–8% scalp regime)
 *  - Spread Intelligence (relative return vs BTC as alt-rotation proxy)
 *  - Divergence Engine   (RSI divergence — adds confidence only)
 *  - TAO Consensus       (6 expert votes, ≥ 4 required)
 *  - Opportunity Score   (0–100, grade ELITE/STRONG/MEDIUM/IGNORE)
 *
 * A signal is emitted ONLY when all major engines align and score ≥ 60.
 * TP = entry ± 1.5 × SL distance (TP2 / 1.5R — balanced RR)
 */

import { Candle, ScalperSignal, computeEMA, computeRSI, computeVolumeRatio, computeBB, fetchCandles } from "./scalper-signals";
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

  const smoothTR  = rmaSmooth(trs,     period);
  const smoothPDM = rmaSmooth(plusDMs, period);
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

// ── Volume score (section 5 of spec) ─────────────────────────────────────────

function volumeScore(volumeRatio: number): number {
  if (volumeRatio >= 1.5) return 1.0;  // VERY STRONG
  if (volumeRatio >= 1.2) return 0.7;  // GOOD
  if (volumeRatio >= 1.0) return 0.4;  // MEDIUM
  return 0.0;                          // WEAK
}

// ── Trigger Engine (section 4 of spec) ───────────────────────────────────────

type SetupType = "BREAKOUT" | "RETEST" | "REVERSAL";

interface TriggerResult {
  type: SetupType;
  sl: number;
  triggerQuality: number;  // max 25 (RETEST=25, BREAKOUT=18, REVERSAL=15)
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

  if (side === "buy") {
    // ── RETEST (highest priority per spec) ───────────────────────────────────
    // Prior swing high was broken (breakout happened), price pulls back and rejects bullishly
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

    // ── BREAKOUT ─────────────────────────────────────────────────────────────
    // Close above recent swing high with volume (section 4A)
    const recentHighs = swingHighs.filter(s => s.index >= last - 40 && s.index < last - 1);
    const nearestHigh = recentHighs[recentHighs.length - 1];
    if (nearestHigh && lastClose > nearestHigh.price && volumeRatio >= 1.2) {
      const sl = nearestHigh.price - atr;
      return { type: "BREAKOUT", sl, triggerQuality: 18 };
    }

    // ── REVERSAL ─────────────────────────────────────────────────────────────
    // Price at demand zone + RSI crosses above 50 (section 4C)
    const recentLows = swingLows.filter(s => s.index >= last - 30 && s.index < last - 1);
    const nearestLow = recentLows[recentLows.length - 1];
    if (nearestLow) {
      const pct = Math.abs(lastClose - nearestLow.price) / nearestLow.price;
      if (pct < 0.015 && rsi >= 48 && rsi <= 56 && lastClose > prevClose) {
        const sl = nearestLow.price - 0.8 * atr;
        return { type: "REVERSAL", sl, triggerQuality: 15 };
      }
    }

  } else {
    // ── RETEST (bearish) ─────────────────────────────────────────────────────
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

    // ── BREAKOUT (bearish) ───────────────────────────────────────────────────
    const recentLows = swingLows.filter(s => s.index >= last - 40 && s.index < last - 1);
    const nearestLow = recentLows[recentLows.length - 1];
    if (nearestLow && lastClose < nearestLow.price && volumeRatio >= 1.2) {
      const sl = nearestLow.price + atr;
      return { type: "BREAKOUT", sl, triggerQuality: 18 };
    }

    // ── REVERSAL (bearish) ───────────────────────────────────────────────────
    const recentHighs = swingHighs.filter(s => s.index >= last - 30 && s.index < last - 1);
    const nearestHigh = recentHighs[recentHighs.length - 1];
    if (nearestHigh) {
      const pct = Math.abs(lastClose - nearestHigh.price) / nearestHigh.price;
      if (pct < 0.015 && rsi >= 44 && rsi <= 52 && lastClose < prevClose) {
        const sl = nearestHigh.price + 0.8 * atr;
        return { type: "REVERSAL", sl, triggerQuality: 15 };
      }
    }
  }

  return null;
}

// ── Divergence (section 11 of spec — confidence boost only) ──────────────────

function checkDivergence(closes: number[], side: "buy" | "sell"): boolean {
  if (closes.length < 16) return false;
  const rsiNow  = computeRSI(closes, 14);
  const rsiPrev = computeRSI(closes.slice(0, -5), 14);
  const priceDelta = closes[closes.length - 1] - closes[closes.length - 6];
  if (side === "buy")  return priceDelta < 0 && rsiNow > rsiPrev + 1; // bullish: lower price, higher RSI
  return priceDelta > 0 && rsiNow < rsiPrev - 1;                       // bearish: higher price, lower RSI
}

// ── TAO Consensus Engine (section 13 of spec) ─────────────────────────────────
// 6 expert votes — requires ≥ 4 for signal emission

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
    if (p.spreadScore > 0)           v++;  // 1. Spread Expert: alt rotation positive
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

// ── Opportunity Score Engine (section 14 of spec) ─────────────────────────────
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
  if      (p.atrPct > 0.3 && p.atrPct < 4.0) score += 10;
  else if (p.atrPct >= 4.0 && p.atrPct < 8.0) score += 4; // high chaos — partial credit
  if      (p.rr >= 2.0) score += 15;
  else if (p.rr >= 1.2) score += 10;
  else if (p.rr >= 1.0) score += 5;

  const grade: CHTGrade =
    score >= 85 ? "ELITE"  :
    score >= 75 ? "STRONG" :
    score >= 60 ? "MEDIUM" : "IGNORE";

  return { score, grade };
}

// ── Public evaluator ──────────────────────────────────────────────────────────

export function evaluateCHTSignal(
  gateSymbol: string,
  ltfCandles: Candle[],    // 5m — needs 150+ for reliable swing detection
  htfCandles: Candle[],    // 1h — needs 55+ for EMA50
  btcCandles: Candle[],    // BTC 5m — spread intelligence proxy
  params: { longOnly: boolean },
): ScalperSignal | null {
  if (ltfCandles.length < 80 || htfCandles.length < 55) return null;

  const last    = ltfCandles.length - 1;
  const closes  = ltfCandles.map(c => c.close);
  const volumes = ltfCandles.map(c => c.volume);
  const lastClose = closes[last];

  // ── 1. Trend Engine (EMA20 > EMA50, ADX > 18) ────────────────────────────
  const ema20 = computeEMA(closes, 20);
  const ema50 = computeEMA(closes, 50);
  const { adx } = computeADX(ltfCandles, ADX_PERIOD);
  if (adx < 18) return null;  // ranging market — spec says NO TRADE

  const bullishTrend = ema20 > ema50;
  const bearishTrend = ema20 < ema50;

  // ── 2. HTF Confirmation (1h EMA alignment, spec section 2) ───────────────
  const htfCloses  = htfCandles.map(c => c.close);
  const htfEma20   = computeEMA(htfCloses, 20);
  const htfEma50   = computeEMA(htfCloses, 50);
  const htfBullish = htfEma20 > htfEma50;
  const htfBearish = htfEma20 < htfEma50;

  // Determine trade direction — must have LTF + HTF agreement
  let side: "buy" | "sell";
  if      (bullishTrend && htfBullish)                          side = "buy";
  else if (!params.longOnly && bearishTrend && htfBearish)      side = "sell";
  else                                                           return null;

  // ── 3. Volatility Engine (ATR%, spec section 6) ───────────────────────────
  const atr    = computeATR(ltfCandles, ATR_PERIOD);
  const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;
  if (atrPct < 0.3) return null;  // too flat — no trade per spec
  if (atrPct > 8.0) return null;  // HIGH CHAOS — skip

  // ── 4. Volume Engine ─────────────────────────────────────────────────────
  const volumeRatio = computeVolumeRatio(volumes);
  if (volumeScore(volumeRatio) === 0.0) return null;  // WEAK — spec says skip

  // ── 5. RSI ───────────────────────────────────────────────────────────────
  const rsi = computeRSI(closes, 14);

  // ── 6. Market Structure + Trigger Engine ─────────────────────────────────
  const swingHighs = findSwingHighs(ltfCandles, SWING_LOOKBACK);
  const swingLows  = findSwingLows(ltfCandles,  SWING_LOOKBACK);
  const trigger = detectTrigger(ltfCandles, side, swingHighs, swingLows, rsi, volumeRatio, atr);
  if (!trigger) return null;

  // ── 7. Risk Engine — TP1/TP2/TP3, SL validation ──────────────────────────
  const slLevel = trigger.sl;
  const slDist  = Math.abs(lastClose - slLevel);
  if (slDist <= 0) return null;
  if (side === "buy"  && slLevel >= lastClose) return null;
  if (side === "sell" && slLevel <= lastClose) return null;

  // TP2 (1.5R) as bot target — best balance of fill rate vs RR
  const tpPrice = side === "buy"
    ? lastClose + 1.5 * slDist
    : lastClose - 1.5 * slDist;
  const rr = (side === "buy" ? tpPrice - lastClose : lastClose - tpPrice) / slDist;

  // ── 8. Spread Intelligence — alt-rotation proxy vs BTC ───────────────────
  let spreadScore = 0;
  if (btcCandles.length >= 21 && closes.length >= 21) {
    const btcCloses = btcCandles.map(c => c.close);
    const n = Math.min(21, btcCloses.length, closes.length);
    const symRet = (lastClose - closes[closes.length - n]) / closes[closes.length - n];
    const btcRet = (btcCloses[btcCloses.length - 1] - btcCloses[btcCloses.length - n]) / btcCloses[btcCloses.length - n];
    spreadScore  = symRet - btcRet;  // positive = outperforming BTC (bullish rotation)
  }

  // ── 9. Divergence ────────────────────────────────────────────────────────
  const hasDivergence = checkDivergence(closes, side);

  // ── 10. TAO Consensus (≥ 4 of 6 experts) ─────────────────────────────────
  const taoVotes = computeTaoVotes(side, {
    ema20, ema50, htfBullish, htfBearish,
    volumeRatio, hasDivergence, lastClose,
    rsi, spreadScore,
  });
  if (taoVotes < 4) return null;

  // ── 11. Opportunity Score — only emit MEDIUM+ signals ────────────────────
  const { score, grade } = computeOpportunityScore({
    trendOk: side === "buy" ? bullishTrend : bearishTrend,
    htfOk:   side === "buy" ? htfBullish   : htfBearish,
    triggerQuality: trigger.triggerQuality,
    volumeRatio,
    atrPct,
    rr,
  });
  if (grade === "IGNORE") return null;

  // Repurpose BB fields for context display: upper=resistance, lower=support, mid=EMA50
  const bb = computeBB(closes, 20, 2.0);

  logger.debug(
    { gateSymbol, side, score, grade, setupType: trigger.type, taoVotes, atrPct: atrPct.toFixed(2), adx: adx.toFixed(1) },
    "CHT: signal detected",
  );

  return {
    symbol:       gateSymbol.replace("_USDT", "").replace("_", ""),
    gateSymbol,
    side,
    entryPrice:   lastClose,
    tpPrice,
    slPrice:      slLevel,
    bbUpper:      bb.upper,
    bbLower:      bb.lower,
    bbMid:        ema50,
    rsi,
    volumeRatio,
    strategy:     "cht",
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
}): Promise<ScalperSignal[]> {
  // BTC 5m candles fetched once for spread intelligence across all symbols
  let btcCandles: Candle[] = [];
  try {
    btcCandles = await fetchCandles("BTC_USDT", "5m", 150);
  } catch (err) {
    logger.warn({ err }, "CHT scan: failed to fetch BTC candles — spread score will be 0 for all");
  }

  const results = await Promise.allSettled(
    params.symbols.map(async (gateSymbol) => {
      const [ltf, htf] = await Promise.all([
        fetchCandles(gateSymbol, "5m", 150),
        fetchCandles(gateSymbol, "1h", 60),
      ]);
      return evaluateCHTSignal(gateSymbol, ltf, htf, btcCandles, params);
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
