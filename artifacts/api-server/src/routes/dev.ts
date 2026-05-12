import { Router } from "express";
import { logger } from "../lib/logger";
import { fmtForPair, getSpotAccounts } from "../services/gateio";
import { getSlLimitOffsetPct, computeSlLimitPrice } from "../services/scalper-sync";

const router = Router();

/**
 * POST /api/dev/dry-run-order
 *
 * Builds and returns the full TP + SL stop-limit order payloads that the live
 * executor would send to Gate.io — WITHOUT placing any order.  Calls the same
 * helpers as the production path (fmtForPair, computeSlLimitPrice,
 * getSlLimitOffsetPct, getSpotAccounts fee fallback) so every formatting and
 * rounding decision is exercised identically.
 *
 * Gated behind DRY_RUN_ENABLED=true env var — returns 403 otherwise.
 */
router.post("/dry-run-order", async (req, res): Promise<void> => {
  if (process.env["DRY_RUN_ENABLED"] !== "true") {
    res.status(403).json({ error: "DRY_RUN_ENABLED is not set to 'true' — this endpoint is disabled in production" });
    return;
  }

  const { symbol, side, rawAmount, slPrice, tpPrice } = req.body as Record<string, unknown>;

  // Manual validation — no zod dep needed
  if (typeof symbol !== "string" || symbol.length === 0) {
    res.status(400).json({ error: "symbol must be a non-empty string" }); return;
  }
  if (side !== "buy" && side !== "sell") {
    res.status(400).json({ error: "side must be 'buy' or 'sell'" }); return;
  }
  if (typeof rawAmount !== "number" || rawAmount <= 0) {
    res.status(400).json({ error: "rawAmount must be a positive number" }); return;
  }
  if (typeof slPrice !== "number" || slPrice <= 0) {
    res.status(400).json({ error: "slPrice must be a positive number" }); return;
  }
  if (typeof tpPrice !== "number" || tpPrice <= 0) {
    res.status(400).json({ error: "tpPrice must be a positive number" }); return;
  }

  const sideVal      = side as "buy" | "sell";
  const rawAmountVal = rawAmount as number;
  const slPriceVal   = slPrice as number;
  const tpPriceVal   = tpPrice as number;
  const exitSide = side === "buy" ? "sell" : "buy";
  const slRule   = side === "buy" ? "<=" : ">=";
  const tpRule   = side === "buy" ? ">=" : "<=";

  // ── 1. Available-balance / fee resolution (mirrors live executor path) ──────
  let availableQty      = rawAmount;
  let feeRateUsed: number | null = null;
  let balanceFetchError: string | null = null;
  let balanceSource: "live_spot_accounts" | "fee_rate_fallback" = "live_spot_accounts";

  try {
    const accounts = await getSpotAccounts();
    const baseCurrency = symbol.split("_")[0]!;
    const baseAcc      = accounts.find((a) => a.currency === baseCurrency);
    const availableBase = baseAcc ? parseFloat(baseAcc.available) : 0;
    if (availableBase > 0) {
      availableQty = Math.min(rawAmount, availableBase);
    }
  } catch (err) {
    const takerFee = parseFloat(process.env["GATEIO_TAKER_FEE_RATE"] ?? "0.0009");
    feeRateUsed      = takerFee;
    balanceFetchError = err instanceof Error ? err.message : String(err);
    availableQty     = rawAmount * (1 - takerFee);
    balanceSource    = "fee_rate_fallback";
  }

  // ── 2. SL stop-limit offset ───────────────────────────────────────────────
  const slOffsetPct  = await getSlLimitOffsetPct();
  const slLimitPrice = computeSlLimitPrice(slPrice, side, slOffsetPct);

  // ── 3. Format via fmtForPair — this is where the FLOOR log fires ──────────
  const [fmtSl, fmtSlLimit, fmtTp] = await Promise.all([
    fmtForPair(symbol, slPrice,      availableQty),
    fmtForPair(symbol, slLimitPrice, availableQty),
    fmtForPair(symbol, tpPrice,      availableQty),
  ]);

  // Derive precision from the formatted amount string (decimal place count)
  const amountPrecision = fmtSl.amount.includes(".")
    ? fmtSl.amount.split(".")[1]!.length
    : 0;

  // ── 4. Build would-be payloads (identical fields to placePriceTriggeredOrder calls) ──
  const wouldBeSlOrder = {
    currencyPair: symbol,
    triggerPrice: fmtSl.price,
    triggerRule:  slRule,
    side:         exitSide,
    amount:       fmtSl.amount,
    orderPrice:   fmtSlLimit.price,
    orderType:    "limit",
  };

  const wouldBeTpOrder = {
    currencyPair: symbol,
    triggerPrice: fmtTp.price,
    triggerRule:  tpRule,
    side:         exitSide,
    amount:       fmtTp.amount,
    orderPrice:   fmtTp.price,
  };

  const result = {
    input: { symbol, side, rawAmount, slPrice, tpPrice },
    feeResolution: {
      balanceSource,
      balanceFetchError,
      feeRateUsed,
      availableQtyAfterFee: availableQty,
    },
    amountDetail: {
      rawAmount,
      availableQty,
      amountPrecision,
      flooredSlAmount: fmtSl.amount,
      flooredTpAmount: fmtTp.amount,
    },
    slStopLimitParams: {
      slLimitOffsetPct:  slOffsetPct,
      triggerPrice:      fmtSl.price,
      triggerRule:       slRule,
      rawSlLimitPrice:   slLimitPrice,
      limitPrice:        fmtSlLimit.price,
      side:              exitSide,
      amount:            fmtSl.amount,
    },
    tpOrderParams: {
      triggerPrice: fmtTp.price,
      triggerRule:  tpRule,
      limitPrice:   fmtTp.price,
      side:         exitSide,
      amount:       fmtTp.amount,
    },
    wouldBeSlOrder,
    wouldBeTpOrder,
    note: "NO Gate.io order was placed. This is a dry-run simulation only.",
  };

  logger.info(
    {
      symbol, side, rawAmount,
      availableQtyAfterFee: availableQty,
      balanceSource,
      feeRateUsed,
      slOffsetPct,
      slTrigger:   fmtSl.price,
      slLimit:     fmtSlLimit.price,
      tpTrigger:   fmtTp.price,
      amountPrecision,
      flooredAmt:  fmtSl.amount,
    },
    "DRY-RUN: would-be SL stop-limit + TP order params (no Gate.io order placed)",
  );

  res.status(200).json(result);
});

export default router;
