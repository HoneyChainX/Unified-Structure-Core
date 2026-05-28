/**
 * Mobile push notifications via FCM (Firebase Cloud Messaging).
 *
 * Hook points:
 *   - notifyMobile.killSwitch()       — kill switch engaged (any reason)
 *   - notifyMobile.emergencyClose()   — position market-closed because SL placement failed
 *   - notifyMobile.dailyLoss()        — daily-loss breaker tripped
 *   - notifyMobile.highQualitySignal()— fired only when device opted in & quality ≥ threshold
 *
 * Activation:
 *   Set FCM_SERVICE_ACCOUNT_JSON to the contents of a Firebase service-account
 *   JSON (or FCM_SERVICE_ACCOUNT_PATH to a file path). Without either, every
 *   notify call is a logged no-op so the server runs unchanged in dev / when
 *   no Firebase project exists yet.
 *
 * Each call respects per-device preferences in the mobile_devices table:
 *   notify_kill_switch / notify_emergency_close / notify_daily_loss / notify_high_quality_signal
 */

import { db, mobileDevicesTable } from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import { logger } from "../lib/logger";

// FCM lazy-init — only required when notifications actually fire.
let _fcmInit: { ready: boolean; send?: (msg: FcmMessage) => Promise<void>; reason?: string } | null = null;

interface FcmMessage {
  token: string;
  notification: { title: string; body: string };
  data?: Record<string, string>;
}

async function initFcm(): Promise<typeof _fcmInit> {
  if (_fcmInit) return _fcmInit;

  const json = process.env.FCM_SERVICE_ACCOUNT_JSON;
  const path = process.env.FCM_SERVICE_ACCOUNT_PATH;
  if (!json && !path) {
    _fcmInit = { ready: false, reason: "no_credentials" };
    return _fcmInit;
  }

  // The firebase-admin SDK is heavy (~30MB transitive) so we lazy-import to
  // keep startup cheap when push isn't configured.
  try {
    // @ts-expect-error optional dep — installed by the operator only when push is wanted
    const admin = await import("firebase-admin");
    let serviceAccount: unknown;
    if (json) {
      serviceAccount = JSON.parse(json);
    } else if (path) {
      const fs = await import("node:fs/promises");
      serviceAccount = JSON.parse(await fs.readFile(path, "utf8"));
    }
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount as object) });
    }
    const messaging = admin.messaging();
    _fcmInit = {
      ready: true,
      send: async (msg) => {
        await messaging.send({
          token: msg.token,
          notification: msg.notification,
          data: msg.data,
          android: { priority: "high" },
        });
      },
    };
    logger.info("FCM: initialised");
  } catch (err) {
    logger.warn({ err }, "FCM: init failed — push notifications will no-op");
    _fcmInit = { ready: false, reason: "init_error" };
  }
  return _fcmInit;
}

type AlertKind = "kill_switch" | "emergency_close" | "daily_loss" | "high_quality_signal";

const PREF_FOR_KIND: Record<AlertKind, keyof typeof mobileDevicesTable.$inferSelect> = {
  kill_switch:         "notifyKillSwitch",
  emergency_close:     "notifyEmergencyClose",
  daily_loss:          "notifyDailyLoss",
  high_quality_signal: "notifyHighQualitySignal",
};

/**
 * Fan out a notification to every device that has opted in to this alert kind.
 * Per-device toggles (notifyKillSwitch, etc.) and the global `enabled` flag
 * are honoured. Quality threshold is checked for high_quality_signal alerts.
 */
async function dispatch(kind: AlertKind, title: string, body: string, opts?: { quality?: number; data?: Record<string, string> }): Promise<void> {
  const fcm = await initFcm();
  if (!fcm?.ready) {
    logger.debug({ kind, title, reason: fcm?.reason }, "Mobile notify: skipping (FCM not configured)");
    return;
  }

  const prefCol = PREF_FOR_KIND[kind];
  const devices = await db
    .select()
    .from(mobileDevicesTable)
    .where(and(eq(mobileDevicesTable.enabled, true), eq(mobileDevicesTable[prefCol] as never, true as never)));

  if (devices.length === 0) {
    logger.debug({ kind, title }, "Mobile notify: no opted-in devices");
    return;
  }

  await Promise.allSettled(devices.map(async (d) => {
    // Quality threshold gate for high_quality_signal only
    if (kind === "high_quality_signal" && opts?.quality != null) {
      const threshold = parseFloat(d.signalQualityThreshold);
      if (Number.isFinite(threshold) && opts.quality < threshold) return;
    }
    try {
      await fcm.send!({ token: d.token, notification: { title, body }, data: { kind, ...(opts?.data ?? {}) } });
    } catch (err) {
      logger.warn({ token: d.token.slice(0, 8) + "…", err }, "Mobile notify: send failed");
    }
  }));
}

export const notifyMobile = {
  killSwitch(reason: string): Promise<void> {
    return dispatch("kill_switch", "🛑 Kill switch engaged", reason);
  },
  emergencyClose(symbol: string, pnl: number | null): Promise<void> {
    const body = pnl != null
      ? `${symbol} market-closed because SL placement failed. Net P&L: ${pnl.toFixed(2)} USDT.`
      : `${symbol} market-closed because SL placement failed. Manual review needed.`;
    return dispatch("emergency_close", "⚠️ Emergency close", body, { data: { symbol } });
  },
  dailyLoss(lossPct: number, limitPct: number): Promise<void> {
    return dispatch(
      "daily_loss",
      "🚨 Daily-loss breaker tripped",
      `Realised loss ${lossPct.toFixed(2)}% exceeded limit ${limitPct.toFixed(2)}%. Trading paused.`,
    );
  },
  highQualitySignal(args: { symbol: string; side: "buy" | "sell"; strategy: string; quality: number }): Promise<void> {
    return dispatch(
      "high_quality_signal",
      `${args.side === "buy" ? "🟢" : "🔴"} ${args.symbol} ${args.side.toUpperCase()} (q=${args.quality.toFixed(2)})`,
      `${args.strategy} signal fired with quality ${args.quality.toFixed(2)}.`,
      { quality: args.quality, data: { symbol: args.symbol, side: args.side, strategy: args.strategy, quality: args.quality.toFixed(3) } },
    );
  },
};

/** Test-only: reset FCM init state. */
export function _resetMobileNotify(): void {
  _fcmInit = null;
}
