/**
 * Pre-trade risk guard. Both executors call `checkRiskGuard()` before
 * placing any entry. Returns `null` on green-light, or a human reason
 * string on refusal (which the executor logs and returns to the caller).
 *
 * Centralises:
 *   - global kill switch
 *   - global max open trades (across both systems — see exposure.ts)
 *   - global max notional USDT
 *   - daily realised-loss circuit breaker
 *   - per-position cap as % of equity
 */

import { db, riskConfigTable, tradesTable, scalperTradesTable } from "@workspace/db";
import { and, gte, isNotNull, inArray, sql } from "drizzle-orm";
import { getCombinedOpenExposure } from "./exposure";
import { logger } from "../lib/logger";

export interface RiskGuardInput {
  /** New trade's intended USDT notional. */
  positionSizeUsdt: number;
  /** Current free / total equity in USDT (best estimate available). */
  equityUsdt?: number;
  /** Used for logging only. */
  source: "webhook-bot" | "scalper";
}

export interface RiskGuardResult {
  allowed: boolean;
  reason?: string;
  reasonCode?:
    | "kill_switch"
    | "kill_switch_daily_loss"
    | "max_open_trades"
    | "max_notional"
    | "position_too_large"
    | "daily_loss_breached";
}

async function getRiskConfig() {
  const [row] = await db.select().from(riskConfigTable).limit(1);
  if (row) return row;
  // Auto-seed singleton if migration somehow missed it.
  const [seeded] = await db.insert(riskConfigTable).values({}).returning();
  return seeded;
}

/** Sum of realised PnL on trades closed since UTC midnight, across both systems. */
async function getRealisedPnlSinceUtcMidnight(): Promise<number> {
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const [webhookSum] = await db
    .select({ s: sql<number>`coalesce(sum(${tradesTable.pnl}), 0)` })
    .from(tradesTable)
    .where(and(
      inArray(tradesTable.status, ["closed"]),
      isNotNull(tradesTable.closedAt),
      gte(tradesTable.closedAt, utcMidnight),
    ));

  const [scalperSum] = await db
    .select({ s: sql<number>`coalesce(sum(${scalperTradesTable.pnl}), 0)` })
    .from(scalperTradesTable)
    .where(and(
      inArray(scalperTradesTable.status, ["closed"]),
      isNotNull(scalperTradesTable.closedAt),
      gte(scalperTradesTable.closedAt, utcMidnight),
    ));

  return Number(webhookSum?.s ?? 0) + Number(scalperSum?.s ?? 0);
}

export async function checkRiskGuard(input: RiskGuardInput): Promise<RiskGuardResult> {
  const cfg = await getRiskConfig();

  // 1. Hard kill switch
  if (cfg.killSwitch) {
    return { allowed: false, reasonCode: "kill_switch", reason: "Kill switch is engaged — trading paused" };
  }

  // 2. Position-size sanity
  if (!Number.isFinite(input.positionSizeUsdt) || input.positionSizeUsdt <= 0) {
    return { allowed: false, reasonCode: "position_too_large", reason: "Position size invalid (<=0 or NaN)" };
  }
  if (input.equityUsdt != null && input.equityUsdt > 0 && cfg.maxPositionPctOfEquity > 0) {
    const cap = input.equityUsdt * (cfg.maxPositionPctOfEquity / 100);
    if (input.positionSizeUsdt > cap) {
      return {
        allowed: false,
        reasonCode: "position_too_large",
        reason: `Position ${input.positionSizeUsdt.toFixed(2)} USDT exceeds ${cfg.maxPositionPctOfEquity}% of equity (cap ${cap.toFixed(2)})`,
      };
    }
  }

  // 3. Combined open exposure
  const exposure = await getCombinedOpenExposure();
  if (exposure.openCount >= cfg.globalMaxOpenTrades) {
    return {
      allowed: false,
      reasonCode: "max_open_trades",
      reason: `Combined open trades ${exposure.openCount}/${cfg.globalMaxOpenTrades} (webhook + scalper) — refusing new entry`,
    };
  }
  if (exposure.notionalUsdt + input.positionSizeUsdt > cfg.globalMaxNotionalUsdt) {
    return {
      allowed: false,
      reasonCode: "max_notional",
      reason: `Combined notional ${(exposure.notionalUsdt + input.positionSizeUsdt).toFixed(2)} USDT exceeds global cap ${cfg.globalMaxNotionalUsdt}`,
    };
  }

  // 4. Daily-loss circuit breaker
  if (cfg.dailyLossLimitPct > 0 && input.equityUsdt != null && input.equityUsdt > 0) {
    const realised = await getRealisedPnlSinceUtcMidnight();
    const lossPct = realised < 0 ? (Math.abs(realised) / input.equityUsdt) * 100 : 0;
    if (lossPct >= cfg.dailyLossLimitPct) {
      // Self-trip the kill switch so the dashboard reflects the breach.
      try {
        await db.update(riskConfigTable).set({
          killSwitch: true,
          killReason: 1,
          updatedAt: new Date(),
        });
      } catch (err) {
        logger.warn({ err }, "risk-guard: failed to auto-trip kill switch on daily-loss breach");
      }
      return {
        allowed: false,
        reasonCode: "daily_loss_breached",
        reason: `Daily loss ${lossPct.toFixed(2)}% >= limit ${cfg.dailyLossLimitPct}% — kill switch tripped`,
      };
    }
  }

  return { allowed: true };
}

/** Toggle the kill switch programmatically (used by /api/risk routes). */
export async function setKillSwitch(on: boolean, reason: number | null = null): Promise<void> {
  await db.update(riskConfigTable).set({
    killSwitch: on,
    killReason: on ? reason ?? 0 : null,
    updatedAt: new Date(),
  });
  logger.warn({ killSwitch: on, reason }, on ? "risk-guard: KILL SWITCH ENGAGED" : "risk-guard: kill switch cleared");
}
