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
  // Stop-limit SL offset — limit price placed this % away from the trigger
  // (0.2 = 0.2%). Ensures the limit fills even in a fast drop/spike through
  // the stop level. Configurable per account; default 0.2%.
  slLimitOffsetPct: real("sl_limit_offset_pct").notNull().default(0.2),

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

  // Dynamic TP — when true, executor targets the opposite Bollinger Band instead of a fixed $ or % amount
  dynamicTp: boolean("dynamic_tp").notNull().default(false),

  // TP mode — controls how take-profit is calculated:
  //   "fixed_usdt"  — single TP at fixed $ target (targetProfitUsdt)
  //   "fixed_pct"   — single TP at fixed % of entry (targetProfitPct)
  //   "dynamic_bb"  — TP at opposite Bollinger Band (dynamicTp)
  //   "micro_2usd"  — dual-TP sniper mode: position auto-sized so 1R = targetProfitUsdt ($2 default)
  //                   TP1 at entry+1R (50% qty → $1), break-even SL; TP2 at entry+2R (50% qty → $1 more)
  tpMode: text("tp_mode").notNull().default("fixed_usdt"),

  // TradingView webhook secret — auto-generated UUID on first GET /config
  webhookSecret: text("webhook_secret"),

  // Strategy engine: "bb_rsi" (default BB+RSI+volume) or "smc_mss" (MSS+OB+Fib)
  strategy: text("strategy").notNull().default("bb_rsi"),

  // MRX volatility filter thresholds — tunable per timeframe
  // 1m defaults are looser than 3m because 1m candles are naturally smaller
  mrxAtrPctMin1m: real("mrx_atr_pct_min_1m").notNull().default(0.05),
  mrxAtrPctMax1m: real("mrx_atr_pct_max_1m").notNull().default(2.0),
  mrxBbWidthMin1m: real("mrx_bb_width_min_1m").notNull().default(0.15),
  mrxBbWidthMax1m: real("mrx_bb_width_max_1m").notNull().default(3.0),
  mrxAtrPctMin3m: real("mrx_atr_pct_min_3m").notNull().default(0.3),
  mrxAtrPctMax3m: real("mrx_atr_pct_max_3m").notNull().default(3.0),
  mrxBbWidthMin3m: real("mrx_bb_width_min_3m").notNull().default(0.6),
  mrxBbWidthMax3m: real("mrx_bb_width_max_3m").notNull().default(5.0),

  // Adaptive RSI thresholds (BB+RSI engine). When enabled, rsiOversold /
  // rsiOverbought are replaced with rolling quantiles of the symbol's own
  // RSI distribution over `adaptiveWindow` bars. The floors clamp the
  // adaptive bounds so quiet markets don't fire at RSI 45/55.
  adaptiveThresholds:    boolean("adaptive_thresholds").notNull().default(false),
  adaptiveWindow:        integer("adaptive_window").notNull().default(100),
  adaptiveLowQ:          real("adaptive_low_q").notNull().default(0.05),
  adaptiveHighQ:         real("adaptive_high_q").notNull().default(0.95),
  adaptiveRsiLowFloor:   real("adaptive_rsi_low_floor").notNull().default(35),
  adaptiveRsiHighFloor:  real("adaptive_rsi_high_floor").notNull().default(65),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const updateScalperConfigSchema = createInsertSchema(scalperConfigTable).omit({
  id: true,
  updatedAt: true,
}).partial();
export type UpdateScalperConfig = z.infer<typeof updateScalperConfigSchema>;
export type ScalperConfig = typeof scalperConfigTable.$inferSelect;
