import { pgTable, serial, text, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const scalperTradesTable = pgTable("scalper_trades", {
  id: serial("id").primaryKey(),

  symbol: text("symbol").notNull(),
  gateSymbol: text("gate_symbol").notNull(),
  side: text("side").notNull(),

  status: text("status").notNull().default("open"),

  positionSizeUsdt: real("position_size_usdt"),
  quantity: real("quantity"),
  entryPrice: real("entry_price"),
  livePrice: real("live_price"),

  entryOrderId: text("entry_order_id"),
  slOrderId: text("sl_order_id"),
  tpOrderId: text("tp_order_id"),

  slPrice: real("sl_price"),
  tpPrice: real("tp_price"),

  closePrice: real("close_price"),
  closeReason: text("close_reason"),

  pnl: real("pnl"),
  errorMessage: text("error_message"),
  paperMode: boolean("paper_mode").notNull().default(true),

  // Signal metadata stored for analytics
  bbUpper: real("bb_upper"),
  bbLower: real("bb_lower"),
  bbMid: real("bb_mid"),
  rsi: real("rsi"),
  volumeRatio: real("volume_ratio"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertScalperTradeSchema = createInsertSchema(scalperTradesTable).omit({ id: true, createdAt: true });
export type InsertScalperTrade = z.infer<typeof insertScalperTradeSchema>;
export type ScalperTrade = typeof scalperTradesTable.$inferSelect;
