// Verifier: deep health endpoint aggregator + HTTP status logic.
//
// The deep probe at /api/health/deep aggregates six dependency checks.
// We exercise the pure aggregator + the per-check pure helpers without
// hitting the network or DB — runtime checks (db, gateio) are stubbed
// by hand-crafting their CheckResult shape.

import {
  aggregateStatus,
  httpStatusFor,
  checkMobileApiToken,
  checkFcm,
  checkWebhookSecret,
  type CheckResult,
} from "../routes/health";

let fails = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  if (cond) console.log("  ✓", label);
  else { console.log("  ✗", label, detail ?? ""); fails++; }
};

const pass = (extra: Partial<CheckResult> = {}): CheckResult => ({
  status: "pass",
  duration_ms: 1,
  ...extra,
});
const fail = (error = "boom", extra: Partial<CheckResult> = {}): CheckResult => ({
  status: "fail",
  duration_ms: 1,
  error,
  ...extra,
});
const notConfigured = (extra: Partial<CheckResult> = {}): CheckResult => ({
  status: "not_configured",
  duration_ms: 1,
  ...extra,
});

console.log("[1] aggregator: all checks pass → healthy");
{
  const status = aggregateStatus({
    db: pass(),
    gateio: pass(),
    risk_config: pass(),
    webhook_secret: pass(),
    mobile_api_token: pass(),
    fcm: pass(),
  });
  ok(status === "healthy", "all-pass → healthy", status);
  ok(httpStatusFor(status) === 200, "healthy → HTTP 200");
}

console.log("[2] aggregator: only FCM missing → degraded + 200");
{
  const status = aggregateStatus({
    db: pass(),
    gateio: pass(),
    risk_config: pass(),
    webhook_secret: pass(),
    mobile_api_token: pass(),
    fcm: notConfigured(),
  });
  ok(status === "degraded", "fcm not_configured → degraded", status);
  ok(httpStatusFor(status) === 200, "degraded → HTTP 200");
}

console.log("[3] aggregator: only mobile token missing → degraded");
{
  const status = aggregateStatus({
    db: pass(),
    gateio: pass(),
    risk_config: pass(),
    webhook_secret: pass(),
    mobile_api_token: notConfigured(),
    fcm: pass(),
  });
  ok(status === "degraded", "mobile_api_token not_configured → degraded", status);
}

console.log("[4] aggregator: db failure → unhealthy + 503");
{
  const status = aggregateStatus({
    db: fail("ECONNREFUSED"),
    gateio: pass(),
    risk_config: pass(),
    webhook_secret: pass(),
    mobile_api_token: pass(),
    fcm: pass(),
  });
  ok(status === "unhealthy", "db fail → unhealthy", status);
  ok(httpStatusFor(status) === 503, "unhealthy → HTTP 503");
}

console.log("[5] aggregator: gateio failure → unhealthy");
{
  const status = aggregateStatus({
    db: pass(),
    gateio: fail("401 Unauthorized"),
    risk_config: pass(),
    webhook_secret: pass(),
    mobile_api_token: pass(),
    fcm: pass(),
  });
  ok(status === "unhealthy", "gateio fail → unhealthy", status);
}

console.log("[6] aggregator: risk_config missing → unhealthy");
{
  const status = aggregateStatus({
    db: pass(),
    gateio: pass(),
    risk_config: fail("risk_config table is empty"),
    webhook_secret: pass(),
    mobile_api_token: pass(),
    fcm: pass(),
  });
  ok(status === "unhealthy", "risk_config fail → unhealthy", status);
}

console.log("[7] aggregator: hard fail overrides optional missing");
{
  const status = aggregateStatus({
    db: fail(),
    gateio: pass(),
    risk_config: pass(),
    webhook_secret: pass(),
    mobile_api_token: notConfigured(),
    fcm: notConfigured(),
  });
  ok(status === "unhealthy",
    "hard fail beats optional not_configured → unhealthy (not degraded)", status);
}

console.log("[8] checkWebhookSecret: prod + unset → fail");
{
  const prev = process.env.WEBHOOK_SECRET;
  delete process.env.WEBHOOK_SECRET;
  const res = checkWebhookSecret("production");
  ok(res.status === "fail", "prod + unset → fail", res);
  ok(typeof res.error === "string" && res.error.length > 0, "error message present");
  if (prev !== undefined) process.env.WEBHOOK_SECRET = prev;
}

console.log("[9] checkWebhookSecret: dev + unset → not_configured (degrades, not unhealthy)");
{
  const prev = process.env.WEBHOOK_SECRET;
  delete process.env.WEBHOOK_SECRET;
  const res = checkWebhookSecret("development");
  ok(res.status === "not_configured", "dev + unset → not_configured", res);
  // Confirm aggregator treats it as degraded, not unhealthy.
  const overall = aggregateStatus({
    db: pass(),
    gateio: pass(),
    risk_config: pass(),
    webhook_secret: res,
    mobile_api_token: pass(),
    fcm: pass(),
  });
  ok(overall === "degraded", "dev missing webhook secret → degraded overall", overall);
  if (prev !== undefined) process.env.WEBHOOK_SECRET = prev;
}

console.log("[10] checkWebhookSecret: set → pass regardless of env");
{
  const prev = process.env.WEBHOOK_SECRET;
  process.env.WEBHOOK_SECRET = "shh";
  ok(checkWebhookSecret("production").status === "pass", "prod + set → pass");
  ok(checkWebhookSecret("development").status === "pass", "dev + set → pass");
  if (prev === undefined) delete process.env.WEBHOOK_SECRET;
  else process.env.WEBHOOK_SECRET = prev;
}

console.log("[11] checkMobileApiToken: env-driven");
{
  const prev = process.env.MOBILE_API_TOKEN;
  delete process.env.MOBILE_API_TOKEN;
  ok(checkMobileApiToken().status === "not_configured", "unset → not_configured");
  process.env.MOBILE_API_TOKEN = "tok";
  ok(checkMobileApiToken().status === "pass", "set → pass");
  if (prev === undefined) delete process.env.MOBILE_API_TOKEN;
  else process.env.MOBILE_API_TOKEN = prev;
}

console.log("[12] checkFcm: either JSON or PATH satisfies");
{
  const prevJson = process.env.FCM_SERVICE_ACCOUNT_JSON;
  const prevPath = process.env.FCM_SERVICE_ACCOUNT_PATH;
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  delete process.env.FCM_SERVICE_ACCOUNT_PATH;
  ok(checkFcm().status === "not_configured", "neither set → not_configured");
  process.env.FCM_SERVICE_ACCOUNT_JSON = "{}";
  const r1 = checkFcm();
  ok(r1.status === "pass" && r1.source === "json", "JSON set → pass (source=json)");
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  process.env.FCM_SERVICE_ACCOUNT_PATH = "/tmp/x";
  const r2 = checkFcm();
  ok(r2.status === "pass" && r2.source === "path", "PATH set → pass (source=path)");
  if (prevJson === undefined) delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  else process.env.FCM_SERVICE_ACCOUNT_JSON = prevJson;
  if (prevPath === undefined) delete process.env.FCM_SERVICE_ACCOUNT_PATH;
  else process.env.FCM_SERVICE_ACCOUNT_PATH = prevPath;
}

console.log("[13] httpStatusFor mapping");
{
  ok(httpStatusFor("healthy") === 200, "healthy → 200");
  ok(httpStatusFor("degraded") === 200, "degraded → 200");
  ok(httpStatusFor("unhealthy") === 503, "unhealthy → 503");
}

console.log(`\n${fails === 0 ? "✓ ALL PASS" : `✗ ${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);
