import { pgTable, serial, boolean, real, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  paperMode: boolean("paper_mode").notNull().default(true),

  positionSizeUsdt: real("position_size_usdt").notNull().default(50),
  minConfW: real("min_conf_w").notNull().default(60),
  minGrade: text("min_grade").notNull().default("Strong Setup"),

  allowedSymbols: text("allowed_symbols").notNull().default(""),

  longOnly: boolean("long_only").notNull().default(false),

  // Trading mode: "all" | "scalp" | "intraday" | "swing" | "position"
  tradingMode: text("trading_mode").notNull().default("all"),

  // Compounding: reinvest profits into next position size
  compoundingEnabled: boolean("compounding_enabled").notNull().default(false),
  compoundBalance: real("compound_balance"), // null = not initialized; set to positionSizeUsdt on first enable

  maxOpenTrades: integer("max_open_trades").notNull().default(3),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(0),

  slEnabled: boolean("sl_enabled").notNull().default(true),
  tp1Enabled: boolean("tp1_enabled").notNull().default(true),
  tp2Enabled: boolean("tp2_enabled").notNull().default(true),
  tp3Enabled: boolean("tp3_enabled").notNull().default(false),

  tp1Pct: real("tp1_pct").notNull().default(50),
  tp2Pct: real("tp2_pct").notNull().default(30),
  tp3Pct: real("tp3_pct").notNull().default(20),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const updateBotConfigSchema = createInsertSchema(botConfigTable).omit({
  id: true,
  updatedAt: true,
}).partial();
export type UpdateBotConfig = z.infer<typeof updateBotConfigSchema>;
export type BotConfig = typeof botConfigTable.$inferSelect;
