/**
 * FCM device-token registration via Capacitor PushNotifications.
 *
 * On a real Android device:
 *   1. Request notification permission
 *   2. Register with FCM → fires `registration` event with the token
 *   3. POST that token to /api/mobile/devices/register
 *
 * On web (Vite dev server), the plugin is unavailable and we silently
 * skip — the user still has the full dashboard UI for browsing data.
 */
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { apiPost, type Connection } from "./api";

export async function registerForPushNotifications(conn: Connection): Promise<void> {
  if (Capacitor.getPlatform() === "web") return;

  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
    perm = await PushNotifications.requestPermissions();
  }
  if (perm.receive !== "granted") {
    console.warn("Push permission not granted");
    return;
  }

  // Register listener BEFORE calling register() so we don't miss the token.
  PushNotifications.addListener("registration", async ({ value: token }) => {
    try {
      await apiPost(conn, "/api/mobile/devices/register", {
        token,
        platform: Capacitor.getPlatform(),
        enabled: true,
      });
      console.log("FCM token registered with server");
    } catch (err) {
      console.error("Failed to register FCM token with server:", err);
    }
  });

  PushNotifications.addListener("registrationError", (err) => {
    console.error("FCM registration error:", err);
  });

  PushNotifications.addListener("pushNotificationReceived", (notif) => {
    // Foreground notification — log for now; UI surfacing can be added later.
    console.log("Foreground push:", notif);
  });

  await PushNotifications.register();
}
