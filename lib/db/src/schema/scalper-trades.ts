import { pgTable, serial, text, real, boolean, timestamp, numeric } from "drizzle-orm/pg-core";
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

  // Standard single-TP (BB+RSI / SMC strategies)
  tpOrderId: text("tp_order_id"),
  tpPrice: real("tp_price"),
  slPrice: real("sl_price"),

  // CHT multi-TP (TP1=1R/30%, TP2=1.5R/30%, TP3=2R/40%)
  tp1OrderId: text("tp1_order_id"),
  tp2OrderId: text("tp2_order_id"),
  tp3OrderId: text("tp3_order_id"),
  tp1Price: real("tp1_price"),
  tp2Price: real("tp2_price"),
  tp3Price: real("tp3_price"),

  // CHT break-even: true after TP1 fills and SL is moved to entry price
  breakEvenActivated: boolean("break_even_activated").default(false),

  // Which strategy engine generated this trade ("bb_rsi" | "smc_mss" | "cht" | "mrx-hybrid")
  strategy: text("strategy"),

  // Timeframe the signal was detected on (e.g. "1m", "3m", "5m") — set for MRX and scalper signals
  timeframe: text("timeframe"),

  closePrice: real("close_price"),
  closeReason: text("close_reason"),

  // A1: per-fill CHT P&L tracking — closedQty/remainingQty in base-currency units
  closedQty:    numeric("closed_qty"),    // base qty exited so far (string in TS — use Number())
  remainingQty: numeric("remaining_qty"), // base qty still open (string in TS — use Number())
  realizedPnl:  numeric("realized_pnl"), // USDT profit locked in by partial exits (string in TS — use Number())

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
