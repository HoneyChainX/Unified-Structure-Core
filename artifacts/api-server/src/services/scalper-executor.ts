/**
 * Scalper executor — takes a confirmed ScalperSignal and:
 *   1. Applies all guards (enabled, max open, cooldown, duplicate)
 *   2. Sizes the position (or uses compound balance)
 *   3. In paper mode: records the trade at live price
 *   4. In live mode: places a market entry + TP limit + SL stop-limit on Gate.io
 *
 * CHT strategy: places 3 TP orders (30%/30%/40%) + 1 SL (100%).
 *   Break-even (SL→entry after TP1) is managed by the scalper-sync loop.
 */

import { db, scalperConfigTable, scalperTradesTable } from "@workspace/db";
import { eq, inArray, and, gte, count } from "drizzle-orm";
import {
  getUsdtBalance,
  getSpotAccounts,
  getSpotOrder,
  getLivePrice,
  placeSpotOrder,
  placePriceTriggeredOrder,
  cancelPriceTriggeredOrder,
  fmtForPair,
  getMinBaseAmount,
} from "./gateio";
import type { ScalperSignal } from "./scalper-signals";
import { logger } from "../lib/logger";
import { checkRiskGuard } from "./risk-guard";
import { pnlFromFills } from "./fees";

/**
 * Emergency-close a position that was opened but failed to receive its SL.
 *
 * Returns the realised net P&L (or null if the market-close itself failed).
 * Caller must update `protection_state` and `status` on the trade row.
 */
async function emergencyCloseScalperPosition(args: {
  tradeId: number;
  gateSymbol: string;
  side: "buy" | "sell";
  qty: number;
  entryPrice: number;
}): Promise<{ closePrice: number; net: number; fees: number } | null> {
  const exitSide = args.side === "buy" ? "sell" : "buy";
  // Gate.io market SELL on spot expects base-currency amount; market BUY expects USDT.
  // Our exit is the opposite of `side`, so:
  //   side="buy"  → exitSide="sell" → amount = base qty
  //   side="sell" → exitSide="buy"  → amount = base qty * price (USDT notional)
  try {
    const livePrice = await getLivePrice(args.gateSymbol);
    const amount =
      exitSide === "sell"
        ? args.qty.toFixed(8)
        : (args.qty * livePrice).toFixed(4);
    const closeOrder = await placeSpotOrder({
      currencyPair: args.gateSymbol,
      side: exitSide,
      amount,
      type: "market",
    });
    const closePrice = parseFloat(closeOrder.avg_deal_price || closeOrder.price || livePrice.toString());
    const fillMath = pnlFromFills({
      side: args.side,
      entryPrice: args.entryPrice,
      closePrice,
      quantity: args.qty,
    });
    logger.warn(
      { tradeId: args.tradeId, closePrice, net: fillMath.net, fees: fillMath.fees },
      "Scalper: EMERGENCY CLOSE executed — SL placement failed, position market-closed",
    );
    return { closePrice, net: fillMath.net, fees: fillMath.fees };
  } catch (err) {
    logger.error(
      { tradeId: args.tradeId, err: err instanceof Error ? err.message : String(err) },
      "Scalper: emergency close FAILED — position may be NAKED on exchange, manual intervention required",
    );
    return null;
  }
}

export interface ExecuteOptions {
  /** When true: skip cooldown and duplicate guards (used for manual entries) */
  force?: boolean;
}

/**
 * Returns null on success, or a human-readable reason string if blocked.
 */
export async function executeScalperSignal(signal: ScalperSignal, opts: ExecuteOptions = {}): Promise<string | null> {
  const { force = false } = opts;

  const [config] = await db.select().from(scalperConfigTable).limit(1);
  if (!config) {
    logger.debug({ symbol: signal.gateSymbol }, "Scalper config not found, skipping");
    return "Scalper config not found";
  }

  if (!config.enabled) {
    logger.debug({ symbol: signal.gateSymbol }, "Scalper disabled, skipping");
    return "Scalper bot is disabled — enable it first";
  }

  // ── Max open trades ──────────────────────────────────────────────────────
  const [openRow] = await db
    .select({ c: count() })
    .from(scalperTradesTable)
    .where(inArray(scalperTradesTable.status, ["open", "paper"]));
  const openCount = Number(openRow?.c ?? 0);
  if (openCount >= config.maxOpenTrades) {
    logger.info({ openCount, maxOpenTrades: config.maxOpenTrades }, "Scalper: max open trades reached");
    return `Max open trades reached (${openCount}/${config.maxOpenTrades})`;
  }

  // ── Duplicate symbol guard ───────────────────────────────────────────────
  if (!force) {
    const [existing] = await db
      .select({ id: scalperTradesTable.id })
      .from(scalperTradesTable)
      .where(
        and(
          eq(scalperTradesTable.gateSymbol, signal.gateSymbol),
          inArray(scalperTradesTable.status, ["open", "paper"])
        )
      )
      .limit(1);

    if (existing) {
      logger.info({ symbol: signal.gateSymbol }, "Scalper: duplicate position, skipping");
      return `Already have an open position for ${signal.gateSymbol}`;
    }
  }

  // ── Cooldown guard ───────────────────────────────────────────────────────
  if (!force && config.cooldownMinutes > 0) {
    const cutoff = new Date(Date.now() - config.cooldownMinutes * 60_000);
    const [recent] = await db
      .select({ id: scalperTradesTable.id })
      .from(scalperTradesTable)
      .where(
        and(
          eq(scalperTradesTable.gateSymbol, signal.gateSymbol),
          gte(scalperTradesTable.createdAt, cutoff)
        )
      )
      .limit(1);

    if (recent) {
      logger.info({ symbol: signal.gateSymbol, cooldownMinutes: config.cooldownMinutes }, "Scalper: cooldown active");
      return `Cooldown active for ${signal.gateSymbol} — wait ${config.cooldownMinutes} min between trades`;
    }
  }

  // ── Trading allowlist guard ──────────────────────────────────────────────
  if (!force && config.symbolAllowlist) {
    const allowed = config.symbolAllowlist
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (allowed.length > 0 && !allowed.includes(signal.gateSymbol.toUpperCase())) {
      logger.info({ symbol: signal.gateSymbol, allowed }, "Scalper: symbol not in trading allowlist");
      return `${signal.gateSymbol} not in your trading allowlist`;
    }
  }

  // ── Position sizing ──────────────────────────────────────────────────────
  let positionSize: number;

  // MRX-Hybrid always uses 100% of available USDT balance
  if (signal.strategy === "mrx-hybrid") {
    try {
      const liveBalance = await getUsdtBalance();
      positionSize = liveBalance;
      logger.debug({ liveBalance }, "MRX: 100% USDT balance position sizing");
    } catch (err) {
      logger.warn({ err }, "MRX: balance fetch failed — falling back to positionSizeUsdt");
      positionSize = config.positionSizeUsdt;
    }
  } else if (config.positionSizePct != null && config.positionSizePct > 0) {
    try {
      const liveBalance = await getUsdtBalance();
      positionSize = liveBalance * (config.positionSizePct / 100);
      logger.debug({ liveBalance, positionSizePct: config.positionSizePct, positionSize }, "Scalper: % position sizing");
    } catch (err) {
      logger.warn({ err }, "Scalper: balance fetch failed — falling back to fixed positionSizeUsdt");
      positionSize = config.positionSizeUsdt;
    }
  } else if (config.compoundingEnabled && config.compoundBalance != null) {
    positionSize = config.compoundBalance;
  } else {
    positionSize = config.positionSizeUsdt;
  }

  const entryPrice = signal.entryPrice;
  const isCht = signal.strategy === "cht" && signal.tp1Price != null && signal.tp2Price != null && signal.tp3Price != null;

  // ── Micro $2 mode: auto-size position so 1R = targetProfitUsdt ───────────
  const isMicro = (config as { tpMode?: string }).tpMode === "micro_2usd";

  // ── MRX fixed mode: TP = +0.28%, SL = −2.5% (hardcoded, LONG ONLY) ───────
  const isMrxFixed = (config as { tpMode?: string }).tpMode === "mrx_fixed"
    || signal.strategy === "mrx-hybrid";

  // ── Quality-aware sizing (Phase 2) ────────────────────────────────────────
  // When enabled, scale positionSize by setup quality so weaker setups risk
  // less and stronger setups get the configured size. Asymmetric by design:
  // no quality value can push size ABOVE the base — only at or below.
  //
  //   scale = floor + (1 - floor) * quality        floor ∈ [0,1], quality ∈ [0,1]
  //
  // Micro mode is risk-defined (1R = fixed USDT) — scaling its size changes
  // the R-multiple contract, so it's opt-in via qualityAwareSizingMicroMode.
  const qCfg = config as {
    qualityAwareSizing?: boolean;
    qualitySizeFloorPct?: number;
    qualityAwareSizingMicroMode?: boolean;
  };
  const applyQualityScaling = qCfg.qualityAwareSizing === true
    && (!isMicro || qCfg.qualityAwareSizingMicroMode === true);
  if (applyQualityScaling) {
    const q = Math.min(1, Math.max(0, signal.quality ?? 0));
    const floor = Math.min(1, Math.max(0, (qCfg.qualitySizeFloorPct ?? 50) / 100));
    const scale = floor + (1 - floor) * q;
    const scaledSize = positionSize * scale;
    logger.info(
      {
        symbol: signal.gateSymbol, quality: q.toFixed(3),
        baseSize: positionSize.toFixed(4), scaledSize: scaledSize.toFixed(4),
        scale: scale.toFixed(3), floor,
      },
      "Scalper: quality-aware sizing applied",
    );
    positionSize = scaledSize;
  }

  let quantity: number;
  let microSlDist: number | null = null;
  let microTp1: number | null = null;
  let microTp2: number | null = null;

  if (isMicro) {
    // Derive SL distance from signal or config slPct fallback
    if (signal.slPrice != null) {
      microSlDist = Math.abs(entryPrice - signal.slPrice);
    } else {
      microSlDist = entryPrice * (config.slPct / 100);
    }

    if (microSlDist <= 0) {
      const msg = "Micro mode: SL distance is zero — cannot size position";
      logger.warn({ symbol: signal.gateSymbol }, msg);
      await db.update(scalperTradesTable).set({ status: "error", errorMessage: msg }).where(eq(scalperTradesTable.id, (await db.insert(scalperTradesTable).values({ symbol: signal.symbol, gateSymbol: signal.gateSymbol, side: signal.side, positionSizeUsdt: 0, paperMode: config.paperMode, strategy: "micro_2usd", status: "pending" }).returning())[0].id));
      return msg;
    }

    const targetPnl = config.targetProfitUsdt ?? 2;   // default $2
    quantity    = targetPnl / microSlDist;             // 1R = $targetPnl
    positionSize = quantity * entryPrice;

    // Cap position at $1000 to prevent runaway sizing on tiny SL
    if (positionSize > 1000) {
      positionSize = 1000;
      quantity = positionSize / entryPrice;
    }

    const dir = signal.side === "buy" ? 1 : -1;
    microTp1 = entryPrice + dir * 1.0 * microSlDist;  // 1R → $targetPnl/2 per 50% exit
    microTp2 = entryPrice + dir * 2.0 * microSlDist;  // 2R → $targetPnl/2 per 50% exit
    logger.info(
      { symbol: signal.gateSymbol, slDist: microSlDist, qty: quantity, positionSize, tp1: microTp1, tp2: microTp2 },
      "Micro mode: position sized",
    );
  } else {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      logger.warn({ symbol: signal.gateSymbol, entryPrice }, "Scalper: refusing trade — entryPrice invalid");
      return `Invalid entry price (${entryPrice}) for ${signal.gateSymbol}`;
    }
    quantity = positionSize / entryPrice;
  }

  // ── Global risk guard (BUG-13: combined exposure across both systems) ─────
  if (!Number.isFinite(quantity) || quantity <= 0) {
    logger.warn({ symbol: signal.gateSymbol, quantity, positionSize, entryPrice }, "Scalper: refusing trade — quantity invalid");
    return `Computed quantity invalid (${quantity}) — refusing trade`;
  }
  let equityForGuard: number | undefined;
  try {
    equityForGuard = await getUsdtBalance();
  } catch {
    equityForGuard = undefined;
  }
  const guard = await checkRiskGuard({
    positionSizeUsdt: positionSize,
    equityUsdt: equityForGuard,
    source: "scalper",
  });
  if (!guard.allowed) {
    logger.warn({ symbol: signal.gateSymbol, reason: guard.reason, code: guard.reasonCode }, "Scalper: refused by risk-guard");
    return guard.reason ?? "Refused by risk guard";
  }

  /** Compute TP/SL from a given fill price, honouring signal geometry first, then config. */
  function computeTpSl(fillPrice: number, fillQty: number): { tp: number; sl: number } {
    let tp: number;
    if (isMrxFixed) {
      // MRX hardcoded levels — always LONG, TP +0.28%, SL −2.5%
      tp = fillPrice * 1.0028;
    } else if (config.dynamicTp) {
      tp = signal.side === "buy" ? signal.bbUpper : signal.bbLower;
    } else if (signal.tpPrice != null) {
      tp = signal.tpPrice;
    } else if (config.targetProfitPct != null && config.targetProfitPct > 0) {
      const move = fillPrice * (config.targetProfitPct / 100);
      tp = signal.side === "buy" ? fillPrice + move : fillPrice - move;
    } else {
      const move = config.targetProfitUsdt / fillQty;
      tp = signal.side === "buy" ? fillPrice + move : fillPrice - move;
    }

    let sl: number;
    if (isMrxFixed) {
      // MRX hardcoded SL −2.5%
      sl = fillPrice * 0.975;
    } else if (signal.slPrice != null) {
      sl = signal.slPrice;
    } else {
      const move = fillPrice * (config.slPct / 100);
      sl = signal.side === "buy" ? fillPrice - move : fillPrice + move;
    }

    return { tp, sl };
  }

  const provisional = isMicro
    ? {
        sl: signal.slPrice ?? (entryPrice - (signal.side === "buy" ? 1 : -1) * (microSlDist ?? 0)),
        tp: microTp2 ?? entryPrice,
      }
    : computeTpSl(entryPrice, quantity);

  // Common fields stored on every trade row
  const sharedFields = {
    symbol:         signal.symbol,
    gateSymbol:     signal.gateSymbol,
    side:           signal.side,
    positionSizeUsdt: parseFloat(positionSize.toFixed(4)),
    slPrice:        parseFloat(provisional.sl.toFixed(8)),
    tpPrice:        parseFloat(provisional.tp.toFixed(8)),
    bbUpper:        signal.bbUpper,
    bbLower:        signal.bbLower,
    bbMid:          signal.bbMid,
    rsi:            signal.rsi,
    volumeRatio:    signal.volumeRatio,
    paperMode:      config.paperMode,
    // Micro mode tags trade as "micro_2usd"; CHT keeps "cht"; others keep signal strategy
    strategy:       isMicro ? "micro_2usd" : (signal.strategy ?? null),
    timeframe:      signal.timeframe ?? null,
    // Micro mode: tp1/tp2 hold the two TP tiers; tp3 unused
    // CHT mode: tp1/tp2/tp3 hold 1R/1.5R/2R tiers
    tp1Price:       isMicro
                      ? parseFloat((microTp1 ?? 0).toFixed(8))
                      : isCht ? parseFloat(signal.tp1Price!.toFixed(8)) : undefined,
    tp2Price:       isMicro
                      ? parseFloat((microTp2 ?? 0).toFixed(8))
                      : isCht ? parseFloat(signal.tp2Price!.toFixed(8)) : undefined,
    tp3Price:       isCht ? parseFloat(signal.tp3Price!.toFixed(8)) : undefined,
    // Shared 0..1 quality score; null when the signal engine didn't populate it.
    quality:        signal.quality != null ? signal.quality.toFixed(6) : null,
  };

  const [trade] = await db.insert(scalperTradesTable).values({
    ...sharedFields,
    status: "pending",
  }).returning();

  // ── Paper trade ──────────────────────────────────────────────────────────
  if (config.paperMode) {
    let livePrice = entryPrice;
    try {
      livePrice = await getLivePrice(signal.gateSymbol);
    } catch (err) {
      logger.warn({ tradeId: trade.id, err }, "Scalper paper: using signal price as fallback");
    }

    const qty = isMicro ? quantity : positionSize / livePrice;

    // For Micro mode: recalculate 2-TP levels at actual fill price
    if (isMicro) {
      const actualSlDist = signal.slPrice != null
        ? Math.abs(livePrice - signal.slPrice)
        : livePrice * (config.slPct / 100);
      const actualSl = signal.slPrice ?? (livePrice - (signal.side === "buy" ? 1 : -1) * actualSlDist);
      const dir = signal.side === "buy" ? 1 : -1;
      const mTp1 = livePrice + dir * 1.0 * actualSlDist;
      const mTp2 = livePrice + dir * 2.0 * actualSlDist;

      await db.update(scalperTradesTable).set({
        status: "paper", entryPrice: livePrice, livePrice,
        quantity: parseFloat(qty.toFixed(8)),
        tpPrice:  parseFloat(mTp2.toFixed(8)),
        slPrice:  parseFloat(actualSl.toFixed(8)),
        tp1Price: parseFloat(mTp1.toFixed(8)),
        tp2Price: parseFloat(mTp2.toFixed(8)),
        pnl: 0,
      }).where(eq(scalperTradesTable.id, trade.id));

      logger.info(
        { tradeId: trade.id, symbol: signal.symbol, livePrice, positionSize: qty * livePrice, tp1: mTp1, tp2: mTp2, sl: actualSl },
        "Micro paper trade recorded",
      );
      return null;
    }

    const { tp: paperTp, sl: paperSl } = computeTpSl(livePrice, qty);

    // For CHT, recalculate the 3-TP prices at actual fill price
    let chtPaperTps: { tp1Price?: number; tp2Price?: number; tp3Price?: number } = {};
    if (isCht && signal.slPrice != null) {
      const slDist = Math.abs(livePrice - signal.slPrice);
      if (slDist > 0) {
        const dir = signal.side === "buy" ? 1 : -1;
        chtPaperTps = {
          tp1Price: parseFloat((livePrice + dir * 1.0 * slDist).toFixed(8)),
          tp2Price: parseFloat((livePrice + dir * 1.5 * slDist).toFixed(8)),
          tp3Price: parseFloat((livePrice + dir * 2.0 * slDist).toFixed(8)),
        };
      }
    }

    await db.update(scalperTradesTable).set({
      status:     "paper",
      entryPrice: livePrice,
      livePrice,
      quantity:   parseFloat(qty.toFixed(8)),
      tpPrice:    parseFloat(paperTp.toFixed(8)),
      slPrice:    parseFloat(paperSl.toFixed(8)),
      ...chtPaperTps,
      pnl: 0,
    }).where(eq(scalperTradesTable.id, trade.id));

    logger.info(
      {
        tradeId: trade.id, symbol: signal.symbol, side: signal.side,
        entryPrice: livePrice, positionSize,
        tpPrice: paperTp, slPrice: paperSl,
        ...(isCht ? { tp1: chtPaperTps.tp1Price, tp2: chtPaperTps.tp2Price, tp3: chtPaperTps.tp3Price, strategy: "cht" } : {}),
      },
      "Scalper paper trade recorded",
    );
    return null;
  }

  // ── Live execution ───────────────────────────────────────────────────────
  try {
    const balance = await getUsdtBalance();
    if (balance < positionSize) {
      throw new Error(`Insufficient balance: ${balance.toFixed(2)} USDT, need ${positionSize}`);
    }

    let livePrice = entryPrice;
    if (signal.side === "sell") {
      livePrice = await getLivePrice(signal.gateSymbol);
      // fix #4: for SELL entries Gate.io requires holding the base currency, not USDT.
      // The USDT balance check above is insufficient — verify actual base-currency balance.
      const baseCurrency = signal.gateSymbol.split("_")[0]!;
      const neededBaseQty = positionSize / livePrice;
      const accounts = await getSpotAccounts().catch((err: unknown) => {
        throw new Error(`${baseCurrency} balance check failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      const baseAcc = accounts.find((a) => a.currency === baseCurrency);
      const baseAvail = baseAcc ? parseFloat(baseAcc.available) : 0;
      if (baseAvail < neededBaseQty) {
        throw new Error(`Insufficient ${baseCurrency} balance: ${baseAvail.toFixed(6)} available, ${neededBaseQty.toFixed(6)} needed for SELL entry`);
      }
    }

    const orderAmount =
      signal.side === "buy"
        ? positionSize.toString()
        : (positionSize / livePrice).toFixed(6);

    // ── B1: size guardrails — validate before any exchange order ─────────────
    if (positionSize < 3) {
      throw new Error(`Position too small: ${positionSize.toFixed(4)} USDT (minimum 3 USDT)`);
    }
    const minBaseAmt = await getMinBaseAmount(signal.gateSymbol);
    if (minBaseAmt > 0 && quantity < minBaseAmt) {
      throw new Error(`Quantity too small: ${quantity.toFixed(8)} < ${minBaseAmt} minimum base qty for ${signal.gateSymbol}`);
    }

    const entryOrder = await placeSpotOrder({
      currencyPair: signal.gateSymbol,
      side: signal.side,
      amount: orderAmount,
      type: "market",
    });

    const filledPrice = parseFloat(entryOrder.avg_deal_price || entryOrder.price);
    // fix #5: for BUY market orders, filled_amount = base currency received.
    // NEVER fall back to entryOrder.amount which is USDT spent (wrong unit for sizing TP/SL).
    // If filled_amount is missing/zero, re-query the order — never substitute amount.
    let filledQty = parseFloat(entryOrder.filled_amount ?? "");
    if (!(filledQty > 0)) {
      const freshOrder = await getSpotOrder(entryOrder.id, signal.gateSymbol);
      filledQty = parseFloat(freshOrder.filled_amount ?? "");
      if (!(filledQty > 0)) {
        throw new Error(`Entry order ${entryOrder.id}: filled_amount unavailable after re-query — refusing to size TP/SL with USDT amount`);
      }
      logger.info({ tradeId: trade.id, orderId: entryOrder.id, filledQty }, "fix #5: re-queried entry order to obtain filled_amount");
    }

    // ── Fetch actual available base currency balance for SL/TP sizing ─────
    // Gate.io deducts trading fees from the received tokens on a BUY, so the
    // wallet may hold slightly less than filled_amount.  Using the live spot
    // balance avoids placing SL/TP orders that Gate.io rejects for exceeding
    // the available quantity.  We cap at filledQty to avoid over-ordering
    // when a pre-existing balance is present.
    const baseCurrency = signal.gateSymbol.split("_")[0]!;
    let slTpQty = filledQty;
    try {
      const accounts = await getSpotAccounts();
      const baseAcc = accounts.find((a) => a.currency === baseCurrency);
      const availableBase = baseAcc ? parseFloat(baseAcc.available) : 0;
      if (availableBase > 0) {
        slTpQty = Math.min(filledQty, availableBase);
        if (slTpQty < filledQty) {
          logger.info(
            { tradeId: trade.id, filledQty, availableBase, feeDiff: filledQty - slTpQty },
            "Scalper: using available base balance for SL/TP sizing (fee adjustment)"
          );
        }
      }
    } catch (err) {
      // Fallback: apply known GT taker-fee rate so we never overshoot available balance.
      // GATEIO_TAKER_FEE_RATE env var lets you override (default 0.0009 = 0.09% GT rate).
      const takerFee = parseFloat(process.env.GATEIO_TAKER_FEE_RATE ?? "0.0009");
      slTpQty = filledQty * (1 - takerFee);
      logger.warn(
        { tradeId: trade.id, err, takerFee, slTpQtyFallback: slTpQty },
        "Scalper: could not fetch base balance — applying GT fee-rate fallback to filledQty"
      );
    }

    // ── Micro mode: recalculate 2-TP levels at actual fill price ─────────
    const actualSlDist = signal.slPrice != null
      ? Math.abs(filledPrice - signal.slPrice)
      : filledPrice * (config.slPct / 100);
    const dir = signal.side === "buy" ? 1 : -1;

    let actualTp: number;
    let actualSl: number;
    let micro2TpPrices: { tp1Price?: number; tp2Price?: number } = {};

    if (isMrxFixed) {
      // MRX fixed — recalculate at actual fill price
      actualTp = filledPrice * 1.0028;
      actualSl = filledPrice * 0.975;
    } else if (isMicro) {
      actualSl = signal.slPrice ?? (filledPrice - dir * actualSlDist);
      const mTp1 = filledPrice + dir * 1.0 * actualSlDist;
      const mTp2 = filledPrice + dir * 2.0 * actualSlDist;
      actualTp  = mTp2;
      micro2TpPrices = {
        tp1Price: parseFloat(mTp1.toFixed(8)),
        tp2Price: parseFloat(mTp2.toFixed(8)),
      };
    } else if (config.dynamicTp) {
      actualTp = signal.side === "buy" ? signal.bbUpper : signal.bbLower;
      actualSl = signal.slPrice ?? (filledPrice - dir * actualSlDist);
    } else if (signal.tpPrice != null) {
      actualTp = signal.tpPrice;
      actualSl = signal.slPrice ?? (filledPrice - dir * actualSlDist);
    } else if (config.targetProfitPct != null && config.targetProfitPct > 0) {
      const tpMove = filledPrice * (config.targetProfitPct / 100);
      actualTp = signal.side === "buy" ? filledPrice + tpMove : filledPrice - tpMove;
      actualSl = signal.slPrice ?? (filledPrice - dir * actualSlDist);
    } else {
      const tpMove = config.targetProfitUsdt / slTpQty;
      actualTp = signal.side === "buy" ? filledPrice + tpMove : filledPrice - tpMove;
      actualSl = signal.slPrice ?? (filledPrice - dir * actualSlDist);
    }

    // Recalculate CHT TPs at actual fill if slPrice available
    let cht3TpPrices: { tp1Price?: number; tp2Price?: number; tp3Price?: number } = {};
    if (!isMicro && isCht && signal.slPrice != null) {
      const slDist = Math.abs(filledPrice - signal.slPrice);
      if (slDist > 0) {
        const d = signal.side === "buy" ? 1 : -1;
        actualTp = filledPrice + d * 1.5 * slDist;     // TP2 is primary
        cht3TpPrices = {
          tp1Price: parseFloat((filledPrice + d * 1.0 * slDist).toFixed(8)),
          tp2Price: parseFloat(actualTp.toFixed(8)),
          tp3Price: parseFloat((filledPrice + d * 2.0 * slDist).toFixed(8)),
        };
      }
    }

    await db.update(scalperTradesTable).set({
      entryOrderId: entryOrder.id,
      entryPrice:   filledPrice,
      livePrice:    filledPrice,
      quantity:     parseFloat(slTpQty.toFixed(8)),
      tpPrice:      parseFloat(actualTp.toFixed(8)),
      slPrice:      parseFloat(actualSl.toFixed(8)),
      ...cht3TpPrices,
      ...micro2TpPrices,
      status: "open",
      pnl:    0,
    }).where(eq(scalperTradesTable.id, trade.id));

    logger.info({ tradeId: trade.id, filledPrice, filledQty, slTpQty, tpPrice: actualTp, slPrice: actualSl, strategy: isMicro ? "micro_2usd" : signal.strategy }, "Scalper: entry filled");

    // ── Stop-limit SL: compute limit price at configurable offset from trigger ──
    // slLimitOffsetPct (default 0.2%) is set below the trigger for longs and above
    // for shorts — ensures the limit fills even in a fast gap through the stop level.
    const slOffsetFactor = (config.slLimitOffsetPct ?? 0.2) / 100;
    const actualSlLimitPrice = signal.side === "buy"
      ? actualSl * (1 - slOffsetFactor)   // long: limit slightly below trigger
      : actualSl * (1 + slOffsetFactor);  // short: limit slightly above trigger
    logger.info(
      { tradeId: trade.id, slTrigger: actualSl, slLimitPrice: actualSlLimitPrice, offsetPct: config.slLimitOffsetPct ?? 0.2 },
      "Scalper: SL stop-limit params computed"
    );

    // ── Post-fill quantity validation ─────────────────────────────────────
    // Validate every order slice against the pair's minBaseAmount BEFORE
    // touching Gate.io, so we skip orders that would be rejected rather than
    // fire-and-fail silently.  minBaseAmt was fetched above for the B1 check
    // and is cached in-process — this is a synchronous cache hit, zero extra
    // API calls.
    function isAboveMin(qty: number): boolean {
      return minBaseAmt <= 0 || qty >= minBaseAmt;
    }

    const slQtyOk      = isAboveMin(slTpQty);         // SL always covers 100%
    const microTpQtyOk = isAboveMin(slTpQty * 0.50);  // Micro: 50%/50% split
    const chtTp30QtyOk = isAboveMin(slTpQty * 0.30);  // CHT: TP1 (30%) + TP2 (30%)
    const chtTp40QtyOk = isAboveMin(slTpQty * 0.40);  // CHT: TP3 (40%)

    if (!slQtyOk) {
      logger.error(
        { tradeId: trade.id, slTpQty, minBaseAmount: minBaseAmt, symbol: signal.gateSymbol },
        "Scalper: available qty below minBaseAmount — all SL/TP orders will be skipped; position is UNPROTECTED"
      );
    } else {
      if (isMicro && !microTpQtyOk) {
        logger.warn(
          { tradeId: trade.id, tpSliceQty: parseFloat((slTpQty * 0.50).toFixed(8)), minBaseAmount: minBaseAmt },
          "Scalper: Micro TP slice (50%) below minBaseAmount — TP orders skipped, SL still placed"
        );
      }
      if (isCht && !chtTp30QtyOk) {
        logger.warn(
          { tradeId: trade.id, tp1tp2SliceQty: parseFloat((slTpQty * 0.30).toFixed(8)), minBaseAmount: minBaseAmt },
          "Scalper: CHT TP1/TP2 slice (30%) below minBaseAmount — TP1 and TP2 orders skipped"
        );
      }
      if (isCht && chtTp30QtyOk && !chtTp40QtyOk) {
        logger.warn(
          { tradeId: trade.id, tp3SliceQty: parseFloat((slTpQty * 0.40).toFixed(8)), minBaseAmount: minBaseAmt },
          "Scalper: CHT TP3 slice (40%) below minBaseAmount — TP3 order skipped"
        );
      }
    }

    const orderUpdates: Record<string, string | undefined> = {};
    const orderErrors: string[] = [];

    // ── Micro $2 mode: 2 TP orders (50%/50%) + 1 full-position SL ────────
    if (isMicro && micro2TpPrices.tp1Price && micro2TpPrices.tp2Price) {
      const q1 = slTpQty * 0.50;
      const q2 = slTpQty * 0.50;
      const triggerRule = signal.side === "buy" ? ">=" : "<=";
      const slRule      = signal.side === "buy" ? "<=" : ">=";
      const exitSide    = signal.side === "buy" ? "sell" : "buy";

      const [fmtTp1, fmtTp2, fmtSl, fmtSlLimit] = await Promise.all([
        fmtForPair(signal.gateSymbol, micro2TpPrices.tp1Price, q1),
        fmtForPair(signal.gateSymbol, micro2TpPrices.tp2Price, q2),
        fmtForPair(signal.gateSymbol, actualSl, slTpQty),
        fmtForPair(signal.gateSymbol, actualSlLimitPrice, slTpQty),
      ]);

      // TP1 (1R, 50%)
      if (microTpQtyOk) {
        try {
          const o = await placePriceTriggeredOrder({
            currencyPair: signal.gateSymbol,
            triggerPrice: fmtTp1.price, triggerRule,
            side: exitSide, amount: fmtTp1.amount, orderPrice: fmtTp1.price,
          });
          orderUpdates.tp1OrderId = o.id.toString();
          logger.info({ tradeId: trade.id, tp1OrderId: o.id, price: fmtTp1.price }, "Micro: TP1 order placed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          orderErrors.push(`TP1: ${msg}`);
          logger.warn({ tradeId: trade.id, err: msg }, "Micro: TP1 order failed");
        }
      } else {
        orderErrors.push(`TP1 skipped: qty ${parseFloat((slTpQty * 0.50).toFixed(8))} below minBaseAmount ${minBaseAmt}`);
      }

      // TP2 (2R, 50%)
      if (microTpQtyOk) {
        try {
          const o = await placePriceTriggeredOrder({
            currencyPair: signal.gateSymbol,
            triggerPrice: fmtTp2.price, triggerRule,
            side: exitSide, amount: fmtTp2.amount, orderPrice: fmtTp2.price,
          });
          orderUpdates.tp2OrderId = o.id.toString();
          logger.info({ tradeId: trade.id, tp2OrderId: o.id, price: fmtTp2.price }, "Micro: TP2 order placed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          orderErrors.push(`TP2: ${msg}`);
          logger.warn({ tradeId: trade.id, err: msg }, "Micro: TP2 order failed");
        }
      } else {
        orderErrors.push(`TP2 skipped: qty ${parseFloat((slTpQty * 0.50).toFixed(8))} below minBaseAmount ${minBaseAmt}`);
      }

      // SL — market order covering 100% until TP1 fires, then sync shrinks it
      if (slQtyOk) {
        try {
          const o = await placePriceTriggeredOrder({
            currencyPair: signal.gateSymbol,
            triggerPrice: fmtSl.price, triggerRule: slRule,
            side: exitSide, amount: fmtSl.amount,
            orderPrice: fmtSlLimit.price, orderType: "limit",
          });
          orderUpdates.slOrderId = o.id.toString();
          logger.info({ tradeId: trade.id, slOrderId: o.id, trigger: fmtSl.price, limitPrice: fmtSlLimit.price }, "Micro: SL stop-limit placed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          orderErrors.push(`SL: ${msg}`);
          logger.warn({ tradeId: trade.id, err: msg }, "Micro: SL order failed");
        }
      } else {
        orderErrors.push(`SL skipped: qty ${slTpQty} below minBaseAmount ${minBaseAmt}`);
      }

    // ── CHT: 3 TP orders + 1 SL covering full position ───────────────────
    } else if (isCht && cht3TpPrices.tp1Price && cht3TpPrices.tp2Price && cht3TpPrices.tp3Price) {
      const q1 = slTpQty * 0.30;
      const q2 = slTpQty * 0.30;
      const q3 = slTpQty * 0.40;
      const triggerRule = signal.side === "buy" ? ">=" : "<=";
      const exitSide    = signal.side === "buy" ? "sell" : "buy";

      const [fmt1, fmt2, fmt3, fmtSl, fmtSlLimit] = await Promise.all([
        fmtForPair(signal.gateSymbol, cht3TpPrices.tp1Price, q1),
        fmtForPair(signal.gateSymbol, cht3TpPrices.tp2Price, q2),
        fmtForPair(signal.gateSymbol, cht3TpPrices.tp3Price, q3),
        fmtForPair(signal.gateSymbol, actualSl, slTpQty),
        fmtForPair(signal.gateSymbol, actualSlLimitPrice, slTpQty),
      ]);

      // TP1 (1R, 30%)
      if (chtTp30QtyOk) {
        try {
          const o = await placePriceTriggeredOrder({
            currencyPair: signal.gateSymbol,
            triggerPrice: fmt1.price, triggerRule,
            side: exitSide, amount: fmt1.amount, orderPrice: fmt1.price,
          });
          orderUpdates.tp1OrderId = o.id.toString();
          logger.info({ tradeId: trade.id, tp1OrderId: o.id, price: fmt1.price }, "CHT: TP1 order placed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          orderErrors.push(`TP1: ${msg}`);
          logger.warn({ tradeId: trade.id, err: msg }, "CHT: TP1 order failed");
        }
      } else {
        orderErrors.push(`TP1 skipped: qty ${parseFloat((slTpQty * 0.30).toFixed(8))} below minBaseAmount ${minBaseAmt}`);
      }

      // TP2 (1.5R, 30%)
      if (chtTp30QtyOk) {
        try {
          const o = await placePriceTriggeredOrder({
            currencyPair: signal.gateSymbol,
            triggerPrice: fmt2.price, triggerRule,
            side: exitSide, amount: fmt2.amount, orderPrice: fmt2.price,
          });
          orderUpdates.tp2OrderId = o.id.toString();
          logger.info({ tradeId: trade.id, tp2OrderId: o.id, price: fmt2.price }, "CHT: TP2 order placed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          orderErrors.push(`TP2: ${msg}`);
          logger.warn({ tradeId: trade.id, err: msg }, "CHT: TP2 order failed");
        }
      } else {
        orderErrors.push(`TP2 skipped: qty ${parseFloat((slTpQty * 0.30).toFixed(8))} below minBaseAmount ${minBaseAmt}`);
      }

      // TP3 (2R, 40%)
      if (chtTp40QtyOk) {
        try {
          const o = await placePriceTriggeredOrder({
            currencyPair: signal.gateSymbol,
            triggerPrice: fmt3.price, triggerRule,
            side: exitSide, amount: fmt3.amount, orderPrice: fmt3.price,
          });
          orderUpdates.tp3OrderId = o.id.toString();
          logger.info({ tradeId: trade.id, tp3OrderId: o.id, price: fmt3.price }, "CHT: TP3 order placed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          orderErrors.push(`TP3: ${msg}`);
          logger.warn({ tradeId: trade.id, err: msg }, "CHT: TP3 order failed");
        }
      } else {
        orderErrors.push(`TP3 skipped: qty ${parseFloat((slTpQty * 0.40).toFixed(8))} below minBaseAmount ${minBaseAmt}`);
      }

      // SL — market order covering full position (protects 100% until TP1 fires, then sync replaces it)
      const slRule = signal.side === "buy" ? "<=" : ">=";
      if (slQtyOk) {
        try {
          const o = await placePriceTriggeredOrder({
            currencyPair: signal.gateSymbol,
            triggerPrice: fmtSl.price, triggerRule: slRule,
            side: exitSide, amount: fmtSl.amount,
            orderPrice: fmtSlLimit.price, orderType: "limit",
          });
          orderUpdates.slOrderId = o.id.toString();
          logger.info({ tradeId: trade.id, slOrderId: o.id, trigger: fmtSl.price, limitPrice: fmtSlLimit.price }, "CHT: SL stop-limit placed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          orderErrors.push(`SL: ${msg}`);
          logger.warn({ tradeId: trade.id, err: msg }, "CHT: SL order failed");
        }
      } else {
        orderErrors.push(`SL skipped: qty ${slTpQty} below minBaseAmount ${minBaseAmt}`);
      }

    } else {
      // ── Standard single TP + SL (BB+RSI / SMC) ──────────────────────────
      const [tpFmt, slFmt, slLimitFmt] = await Promise.all([
        fmtForPair(signal.gateSymbol, actualTp, slTpQty),
        fmtForPair(signal.gateSymbol, actualSl, slTpQty),
        fmtForPair(signal.gateSymbol, actualSlLimitPrice, slTpQty),
      ]);

      if (slQtyOk) {
        try {
          const tpOrder = await placePriceTriggeredOrder({
            currencyPair: signal.gateSymbol,
            triggerPrice: tpFmt.price,
            triggerRule:  signal.side === "buy" ? ">=" : "<=",
            side:         signal.side === "buy" ? "sell" : "buy",
            amount:       tpFmt.amount,
            orderPrice:   tpFmt.price,
          });
          orderUpdates.tpOrderId = tpOrder.id.toString();
          logger.info({ tradeId: trade.id, tpOrderId: tpOrder.id }, "Scalper: TP order placed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ tradeId: trade.id, err: msg }, "Scalper: TP order failed");
          orderErrors.push(`TP: ${msg}`);
        }

        try {
          const slOrder = await placePriceTriggeredOrder({
            currencyPair: signal.gateSymbol,
            triggerPrice: slFmt.price,
            triggerRule:  signal.side === "buy" ? "<=" : ">=",
            side:         signal.side === "buy" ? "sell" : "buy",
            amount:       slFmt.amount,
            orderPrice:   slLimitFmt.price,
            orderType:    "limit",
          });
          orderUpdates.slOrderId = slOrder.id.toString();
          logger.info({ tradeId: trade.id, slOrderId: slOrder.id, trigger: slFmt.price, limitPrice: slLimitFmt.price }, "Scalper: SL stop-limit placed");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ tradeId: trade.id, err: msg }, "Scalper: SL order failed");
          orderErrors.push(`SL: ${msg}`);
        }
      } else {
        orderErrors.push(`TP/SL skipped: qty ${slTpQty} below minBaseAmount ${minBaseAmt}`);
      }
    }

    if (orderErrors.length > 0) {
      orderUpdates.errorMessage = orderErrors.join(" | ");
    }

    // ── Atomic SL/TP placement: SL is mandatory; TP is best-effort ──────────
    const slMissing = !orderUpdates.slOrderId;
    const anyTpMissing = isCht
      ? !(orderUpdates.tp1OrderId && orderUpdates.tp2OrderId && orderUpdates.tp3OrderId)
      : isMicro
        ? !(orderUpdates.tp1OrderId && orderUpdates.tp2OrderId)
        : !orderUpdates.tpOrderId;

    let protectionState: "protected" | "degraded" | "emergency_closed" = "protected";
    if (slMissing) {
      protectionState = "emergency_closed";
      const close = await emergencyCloseScalperPosition({
        tradeId: trade.id,
        gateSymbol: signal.gateSymbol,
        side: signal.side as "buy" | "sell",
        qty: slTpQty,
        entryPrice: filledPrice,
      });
      // Cancel any TPs we managed to place — they would otherwise sit live with no position.
      for (const key of ["tp1OrderId", "tp2OrderId", "tp3OrderId", "tpOrderId"] as const) {
        const oid = orderUpdates[key];
        if (oid) {
          try { await cancelPriceTriggeredOrder(oid, signal.gateSymbol); } catch (err) {
            logger.warn({ tradeId: trade.id, key, oid, err }, "Scalper: failed to cancel orphan TP after emergency close");
          }
        }
      }
      Object.assign(orderUpdates, {
        status: "closed",
        closePrice: close?.closePrice,
        closeReason: "emergency_no_sl",
        pnl: close?.net,
        feesUsdt: close?.fees,
        closedAt: new Date(),
        // Wipe TP order IDs since we cancelled them
        tp1OrderId: null, tp2OrderId: null, tp3OrderId: null, tpOrderId: null,
      } as Record<string, unknown>);
    } else if (anyTpMissing) {
      protectionState = "degraded";
    }
    (orderUpdates as Record<string, unknown>).protectionState = protectionState;

    if (Object.keys(orderUpdates).length > 0) {
      await db.update(scalperTradesTable).set(orderUpdates as Partial<typeof scalperTradesTable.$inferInsert>).where(eq(scalperTradesTable.id, trade.id));
    }

    if (slMissing) {
      return "Emergency close: SL placement failed, position market-closed";
    }
    return null;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ tradeId: trade.id, symbol: signal.symbol, err: msg }, "Scalper: execution failed");
    await db.update(scalperTradesTable).set({ status: "error", errorMessage: msg }).where(eq(scalperTradesTable.id, trade.id));
    return msg;
  }
}
