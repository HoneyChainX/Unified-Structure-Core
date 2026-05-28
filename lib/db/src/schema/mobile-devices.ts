import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Mobile push-notification registration.
 *
 * One row per device that has registered for push. The token is FCM-specific
 * (Firebase Cloud Messaging). When a notification triggers (kill-switch,
 * emergency-close, etc.) the server iterates rows where `enabled = true` and
 * sends to each token.
 *
 * A single user may have multiple devices (phone + tablet). The token is
 * unique per app install — uninstall/reinstall produces a new token.
 */
export const mobileDevicesTable = pgTable("mobile_devices", {
  id: serial("id").primaryKey(),
  /** FCM device token from Capacitor PushNotifications plugin. */
  token: text("token").notNull().unique(),
  /** Optional friendly label so the operator can identify devices in the UI. */
  label: text("label"),
  /** Platform: 'android' | 'ios' | 'web' — captured at registration. */
  platform: text("platform").notNull().default("android"),
  /** Operator can pause notifications to a specific device without unregistering. */
  enabled: boolean("enabled").notNull().default(true),
  /** Per-device notification preferences. */
  notifyKillSwitch: boolean("notify_kill_switch").notNull().default(true),
  notifyEmergencyClose: boolean("notify_emergency_close").notNull().default(true),
  notifyDailyLoss: boolean("notify_daily_loss").notNull().default(true),
  notifyHighQualitySignal: boolean("notify_high_quality_signal").notNull().default(false),
  /** Minimum quality score [0,1] for the high-quality-signal alert. Ignored when notifyHighQualitySignal=false. */
  signalQualityThreshold: text("signal_quality_threshold").notNull().default("0.8"),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMobileDeviceSchema = createInsertSchema(mobileDevicesTable).omit({
  id: true,
  registeredAt: true,
  lastSeenAt: true,
});
export const updateMobileDeviceSchema = insertMobileDeviceSchema.partial();
export type MobileDevice = typeof mobileDevicesTable.$inferSelect;
export type NewMobileDevice = z.infer<typeof insertMobileDeviceSchema>;
