import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor configuration for the trading-bot Android companion app.
 *
 * `webDir` points to the Vite build output that Capacitor packages into
 * the Android APK. Run `pnpm run android:sync` after every web build to
 * refresh the bundled assets.
 *
 * For live-reload development against a physical device on the same LAN,
 * uncomment the `server.url` block below and replace with your machine's
 * IP. Don't ship a release APK with that uncommented.
 */
const config: CapacitorConfig = {
  appId: "com.honeychainx.unifiedstructurecore",
  appName: "USC Bot",
  webDir: "dist",
  bundledWebRuntime: false,
  // server: {
  //   url: "http://192.168.1.42:5174",
  //   cleartext: true,
  // },
  android: {
    backgroundColor: "#0a0a0a",
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
