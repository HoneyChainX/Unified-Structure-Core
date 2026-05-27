import { pgTable, serial, boolean, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const riskConfigTable = pgTable("risk_config", {
  id: serial("id").primaryKey(),

  killSwitch: boolean("kill_switch").notNull().default(false),

  globalMaxOpenTrades: integer("global_max_open_trades").notNull().default(6),
  globalMaxNotionalUsdt: real("global_max_notional_usdt").notNull().default(1000),

  dailyLossLimitPct: real("daily_loss_limit_pct").notNull().default(5),
  dailyLossAutoResumeUtcHour: integer("daily_loss_auto_resume_utc_hour").notNull().default(0),

  maxPositionPctOfEquity: real("max_position_pct_of_equity").notNull().default(50),

  killReason: integer("kill_reason"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const updateRiskConfigSchema = createInsertSchema(riskConfigTable).omit({
  id: true,
  updatedAt: true,
}).partial();
export type UpdateRiskConfig = z.infer<typeof updateRiskConfigSchema>;
export type RiskConfig = typeof riskConfigTable.$inferSelect;
