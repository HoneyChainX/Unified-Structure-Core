import { pgTable, serial, boolean, real, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const scalperConfigTable = pgTable("scalper_config", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  paperMode: boolean("paper_mode").notNull().default(true),

  positionSizeUsdt: real("position_size_usdt").notNull().default(50),
  positionSizePct: real("position_size_pct"),           // % of live USDT balance per trade (overrides fixed if set)
  targetProfitUsdt: real("target_profit_usdt").notNull().default(2),
  slPct: real("sl_pct").notNull().default(0.5),

  maxOpenTrades: integer("max_open_trades").notNull().default(3),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(5),

  // Symbol allowlist (comma-separated Gate.io pairs, e.g. "BTC_USDT,ETH_USDT")
  // null/empty = scan top-N by volume (N = scanPoolSize). Allowlist pairs are always included first.
  symbolAllowlist: text("symbol_allowlist"),

  // How many symbols to scan for signals when no allowlist is set (or to fill remaining slots).
  // Higher = broader market coverage, more API calls per cycle.
  scanPoolSize: integer("scan_pool_size").notNull().default(20),

  // Bollinger Band params
  bbPeriod: integer("bb_period").notNull().default(20),
  bbStdDev: real("bb_std_dev").notNull().default(2.0),

  // RSI params
  rsiPeriod: integer("rsi_period").notNull().default(14),
  rsiOversold: real("rsi_oversold").notNull().default(30),
  rsiOverbought: real("rsi_overbought").notNull().default(70),

  // Volume spike threshold (multiplier vs 20-period avg)
  volumeSpikeMultiplier: real("volume_spike_multiplier").notNull().default(1.5),

  // TP as % of entry price (overrides fixed USDT target when set)
  targetProfitPct: real("target_profit_pct"),

  // EMA trend filter — only longs above EMA, shorts below
  emaFilterEnabled: boolean("ema_filter_enabled").notNull().default(true),
  emaPeriod: integer("ema_period").notNull().default(50),

  // Compounding
  compoundingEnabled: boolean("compounding_enabled").notNull().default(false),
  compoundBalance: real("compound_balance"),

  // Long/short filter
  longOnly: boolean("long_only").notNull().default(false),

  // Strategy engine: "bb_rsi" (default BB+RSI+volume) or "smc_mss" (MSS+OB+Fib)
  strategy: text("strategy").notNull().default("bb_rsi"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const updateScalperConfigSchema = createInsertSchema(scalperConfigTable).omit({
  id: true,
  updatedAt: true,
}).partial();
export type UpdateScalperConfig = z.infer<typeof updateScalperConfigSchema>;
export type ScalperConfig = typeof scalperConfigTable.$inferSelect;
