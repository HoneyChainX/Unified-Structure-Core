/**
 * Fee-aware P&L helpers. Single source of truth for trading-fee math.
 *
 * All bot/scalper executors and sync loops must use these helpers when
 * computing realized P&L or compound-balance deltas. Without them the
 * compound balance drifts upward by ~2 × fee_rate per round-trip and the
 * dashboard win-rate is overstated.
 */

const DEFAULT_TAKER_FEE_RATE = 0.0009; // Gate.io default spot taker = 0.09 %
const DEFAULT_MAKER_FEE_RATE = 0.0009; // identical on Gate.io spot until tiered

export type FeeRole = "taker" | "maker";

export interface FeeRates {
  taker: number;
  maker: number;
}

function readEnvFee(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 0.01) return fallback;
  return n;
}

export function getFeeRates(): FeeRates {
  return {
    taker: readEnvFee("GATEIO_TAKER_FEE_RATE", DEFAULT_TAKER_FEE_RATE),
    maker: readEnvFee("GATEIO_MAKER_FEE_RATE", DEFAULT_MAKER_FEE_RATE),
  };
}

/** Fee charged on a single fill (entry or exit), in USDT. */
export function singleSideFee(notionalUsdt: number, role: FeeRole = "taker"): number {
  const rates = getFeeRates();
  const rate = role === "maker" ? rates.maker : rates.taker;
  return Math.max(0, notionalUsdt) * rate;
}

/**
 * Round-trip fees for a position that was opened then fully exited.
 * Both legs default to taker — most executors hit the book.
 */
export function roundTripFees(
  entryNotionalUsdt: number,
  exitNotionalUsdt: number,
  entryRole: FeeRole = "taker",
  exitRole: FeeRole = "taker",
): number {
  return singleSideFee(entryNotionalUsdt, entryRole) + singleSideFee(exitNotionalUsdt, exitRole);
}

/**
 * Net realized P&L after fees. Pass the raw gross P&L (mark-to-market
 * difference × qty) and the entry / exit USDT notionals.
 */
export function netPnl(
  grossPnl: number,
  entryNotionalUsdt: number,
  exitNotionalUsdt: number,
  entryRole: FeeRole = "taker",
  exitRole: FeeRole = "taker",
): { netPnl: number; fees: number } {
  const fees = roundTripFees(entryNotionalUsdt, exitNotionalUsdt, entryRole, exitRole);
  return { netPnl: grossPnl - fees, fees };
}

/**
 * Convenience: given fill geometry, return both gross and net P&L plus fees.
 * `side` is the entry direction.
 */
export function pnlFromFills(args: {
  side: "buy" | "sell";
  entryPrice: number;
  closePrice: number;
  quantity: number;
  entryRole?: FeeRole;
  exitRole?: FeeRole;
}): { gross: number; net: number; fees: number } {
  const { side, entryPrice, closePrice, quantity, entryRole = "taker", exitRole = "taker" } = args;
  const gross = (side === "buy" ? closePrice - entryPrice : entryPrice - closePrice) * quantity;
  const entryNotional = entryPrice * quantity;
  const exitNotional = closePrice * quantity;
  const { netPnl: net, fees } = netPnl(gross, entryNotional, exitNotional, entryRole, exitRole);
  return { gross, net, fees };
}
