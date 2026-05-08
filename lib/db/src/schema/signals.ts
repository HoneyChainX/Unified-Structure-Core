import {
  pgTable,
  serial,
  text,
  timestamp,
  real,
  integer,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const signalsTable = pgTable("signals", {
  id: serial("id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),

  symbol: text("symbol").notNull(),
  tf: text("tf").notNull(),
  mode: text("mode"),
  macroTf: text("macro_tf"),

  dir: text("dir").notNull(),
  auth: text("auth"),

  paMss: real("pa_mss"),
  obLow: real("ob_low"),
  obHigh: real("ob_high"),
  zoneLow: real("zone_low"),
  zoneHigh: real("zone_high"),
  entryRef: real("entry_ref"),

  sl: real("sl"),
  rr1: real("rr1"),
  tp1: real("tp1"),
  tp2: real("tp2"),
  tp3: real("tp3"),

  conf: integer("conf"),
  confW: real("conf_w"),
  riskTier: text("risk_tier"),

  grade: text("grade"),
  triggered: boolean("triggered").notNull().default(false),

  rot: text("rot"),
  rotScore: real("rot_score"),
  blockReason: text("block_reason"),

  tf2: text("tf2"),
  tf3: text("tf3"),

  rawPayload: jsonb("raw_payload"),
});

export const insertSignalSchema = createInsertSchema(signalsTable).omit({
  id: true,
  receivedAt: true,
});
export type InsertSignal = z.infer<typeof insertSignalSchema>;
export type Signal = typeof signalsTable.$inferSelect;
