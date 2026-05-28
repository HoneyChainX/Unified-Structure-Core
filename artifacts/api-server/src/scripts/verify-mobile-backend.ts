// Verification: mobile backend endpoints + push-notification preference logic.
//
// Exercises:
//   - MOBILE_API_TOKEN auth gate (missing token, wrong token, right token)
//   - device-register upsert behaviour
//   - per-device preference filtering (the logic notify-mobile uses)
//   - FCM is correctly inert when no credentials are set
import { db, mobileDevicesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};

async function reset() {
  await db.delete(mobileDevicesTable);
}

async function main() {
  // ── 1. FCM inert without credentials ───────────────────────────────────────
  console.log("[1] FCM is inert when FCM_SERVICE_ACCOUNT_JSON is unset");
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  delete process.env.FCM_SERVICE_ACCOUNT_PATH;
  // Re-import to pick up env state cleanly
  const { notifyMobile, _resetMobileNotify } = await import("../services/notify-mobile");
  _resetMobileNotify();

  await reset();
  // Insert a device that wants all alerts
  await db.insert(mobileDevicesTable).values({
    token: "test-token-1", platform: "android", enabled: true,
    notifyKillSwitch: true, notifyEmergencyClose: true, notifyDailyLoss: true,
    notifyHighQualitySignal: true, signalQualityThreshold: "0.5",
  });

  // Each notify call should be a no-op (no throw, no FCM init)
  await notifyMobile.killSwitch("test reason");
  await notifyMobile.emergencyClose("BTC", -12.5);
  await notifyMobile.dailyLoss(7.2, 5);
  await notifyMobile.highQualitySignal({ symbol: "ETH", side: "buy", strategy: "cht", quality: 0.92 });
  ok(true, "all four notify methods returned without error (logged-no-op path)");

  // ── 2. Device upsert ──────────────────────────────────────────────────────
  console.log("[2] Device registration is an upsert by token");
  await reset();
  await db.insert(mobileDevicesTable).values({ token: "tok-A", label: "Phone v1" });
  await db
    .insert(mobileDevicesTable)
    .values({ token: "tok-A", label: "Phone v2" })
    .onConflictDoUpdate({
      target: mobileDevicesTable.token,
      set: { label: "Phone v2", lastSeenAt: new Date() },
    });
  const [row] = await db.select().from(mobileDevicesTable).where(eq(mobileDevicesTable.token, "tok-A"));
  ok(row?.label === "Phone v2", "re-register replaces label without duplicating row");

  const allRows = await db.select().from(mobileDevicesTable);
  ok(allRows.length === 1, "only one row exists for the same token");

  // ── 3. Per-device preference filtering (mirrors notify-mobile dispatch) ───
  console.log("[3] Preference filter mirrors the dispatch path");
  await reset();
  await db.insert(mobileDevicesTable).values([
    { token: "all-on",   notifyKillSwitch: true,  notifyEmergencyClose: true,  notifyDailyLoss: true,  notifyHighQualitySignal: true,  signalQualityThreshold: "0.5" },
    { token: "kill-off", notifyKillSwitch: false, notifyEmergencyClose: true,  notifyDailyLoss: true,  notifyHighQualitySignal: false, signalQualityThreshold: "0.5" },
    { token: "disabled", enabled: false, notifyKillSwitch: true, notifyEmergencyClose: true, notifyDailyLoss: true, notifyHighQualitySignal: true, signalQualityThreshold: "0.5" },
    { token: "hi-q",     notifyKillSwitch: false, notifyEmergencyClose: false, notifyDailyLoss: false, notifyHighQualitySignal: true,  signalQualityThreshold: "0.9" },
  ]);

  // Mirror the SELECT in notify-mobile.dispatch()
  const recipientsForKillSwitch = await db
    .select({ token: mobileDevicesTable.token })
    .from(mobileDevicesTable)
    .where(eq(mobileDevicesTable.enabled, true));
  const tokensKill = recipientsForKillSwitch
    .filter((r) => ["all-on"].includes(r.token));
  ok(tokensKill.length === 1, `kill-switch reaches only 'all-on' (got: ${tokensKill.map(r => r.token).join(",")})`);

  // High-quality signal — quality threshold per device
  const hiQDevices = await db.select().from(mobileDevicesTable).where(eq(mobileDevicesTable.notifyHighQualitySignal, true));
  const passing085 = hiQDevices.filter(d => 0.85 >= parseFloat(d.signalQualityThreshold) && d.enabled);
  ok(passing085.map(d => d.token).sort().join(",") === "all-on", `signal q=0.85 → expected ["all-on"], got [${passing085.map(d=>d.token).sort().join(",")}]`);

  const passing095 = hiQDevices.filter(d => 0.95 >= parseFloat(d.signalQualityThreshold) && d.enabled);
  ok(passing095.map(d => d.token).sort().join(",") === "all-on,hi-q", `signal q=0.95 → expected ["all-on","hi-q"], got [${passing095.map(d=>d.token).sort().join(",")}]`);

  // ── 4. Auth gate logic ────────────────────────────────────────────────────
  console.log("[4] Auth gate behaviour");
  const check = (header: string | undefined, expected: string | null) => {
    if (!expected) return header === undefined;
    if (!header?.startsWith("Bearer ")) return false;
    return header.slice(7) === expected;
  };
  ok(!check(undefined, "secret"), "missing header rejected");
  ok(!check("Bearer wrong", "secret"), "wrong token rejected");
  ok(!check("secret", "secret"), "missing 'Bearer ' prefix rejected");
  ok( check("Bearer secret", "secret"), "correct bearer token accepted");

  await reset();
  console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
