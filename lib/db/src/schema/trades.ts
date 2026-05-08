import { pgTable, serial, integer, text, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  signalId: integer("signal_id"),

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
  tp1OrderId: text("tp1_order_id"),
  tp2OrderId: text("tp2_order_id"),
  tp3OrderId: text("tp3_order_id"),

  slPrice: real("sl_price"),
  tp1Price: real("tp1_price"),
  tp2Price: real("tp2_price"),
  tp3Price: real("tp3_price"),

  closePrice: real("close_price"),
  closeReason: text("close_reason"),

  pnl: real("pnl"),
  errorMessage: text("error_message"),
  paperMode: boolean("paper_mode").notNull().default(true),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true, createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
