import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, riskConfigTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getApiKeyDetail } from "../services/gateio";

const router: IRouter = Router();

// ── Liveness probes ──────────────────────────────────────────────────────────
// Both `/healthz` (existing) and `/health` (new alias) stay deliberately
// dumb: they return as soon as the event loop spins, and never touch the DB or
// any external service. Orchestrators use these to decide "is the process up?"
// — the deep probe below is what tells them "is the process actually serving?"
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ── Deep health check ───────────────────────────────────────────────────────
// Probes every external dependency in parallel with a hard per-check timeout
// so a hung Gate.io or DB connection can't stall the whole response.

const CHECK_TIMEOUT_MS = 3000;

export type CheckStatus = "pass" | "fail" | "not_configured";

export interface CheckResult {
  status: CheckStatus;
  duration_ms: number;
  error?: string;
  // free-form per-check detail
  [k: string]: unknown;
}

export interface DeepHealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  uptime_seconds: number;
  version: string;
  checks: {
    db: CheckResult;
    gateio: CheckResult;
    mobile_api_token: CheckResult;
    fcm: CheckResult;
    webhook_secret: CheckResult;
    risk_config: CheckResult;
  };
  timestamp: string;
}

// "Hard" checks are dependencies the API needs to actually serve trading
// traffic — without them the orchestrator should route around us (503).
// "Optional" checks are nice-to-haves that degrade UX but don't break the
// core path (mobile push, mobile API token). `webhook_secret` is hard in
// every non-dev environment because signal ingestion silently 500s without
// it (see routes/signals.ts).
const HARD_CHECK_KEYS = ["db", "gateio", "risk_config", "webhook_secret"] as const;
const OPTIONAL_CHECK_KEYS = ["mobile_api_token", "fcm"] as const;
type HardCheckKey = (typeof HARD_CHECK_KEYS)[number];
type OptionalCheckKey = (typeof OPTIONAL_CHECK_KEYS)[number];
type AnyCheckKey = HardCheckKey | OptionalCheckKey;

/**
 * Pure aggregator — given the per-check results, decide the overall status.
 * Extracted so the verifier can exercise it without spinning up mocks.
 */
export function aggregateStatus(
  checks: Record<AnyCheckKey, CheckResult>
): "healthy" | "degraded" | "unhealthy" {
  for (const key of HARD_CHECK_KEYS) {
    if (checks[key].status === "fail") return "unhealthy";
  }
  // A hard check that came back `not_configured` (e.g. WEBHOOK_SECRET unset
  // in dev) didn't fail — but it's still not a fully-configured deployment,
  // so we degrade rather than report healthy.
  for (const key of HARD_CHECK_KEYS) {
    if (checks[key].status !== "pass") return "degraded";
  }
  for (const key of OPTIONAL_CHECK_KEYS) {
    if (checks[key].status !== "pass") return "degraded";
  }
  return "healthy";
}

/** HTTP status: 503 for unhealthy, 200 for healthy/degraded. */
export function httpStatusFor(status: "healthy" | "degraded" | "unhealthy"): number {
  return status === "unhealthy" ? 503 : 200;
}

/**
 * Race a check against a timeout, capturing duration regardless of outcome.
 */
async function withTimeout<T extends CheckResult>(
  label: string,
  fn: () => Promise<T>,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<CheckResult> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race<T | { __timeout: true }>([
      fn(),
      new Promise<{ __timeout: true }>((resolve) => {
        timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
      }),
    ]);
    if ((result as { __timeout?: boolean }).__timeout) {
      return {
        status: "fail",
        duration_ms: Date.now() - start,
        error: `${label} timed out after ${timeoutMs}ms`,
      };
    }
    return result as CheckResult;
  } catch (err) {
    return {
      status: "fail",
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Individual checks ───────────────────────────────────────────────────────

export async function checkDb(): Promise<CheckResult> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { status: "pass", duration_ms: Date.now() - start };
  } catch (err) {
    return {
      status: "fail",
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkGateio(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const detail = await getApiKeyDetail();
    // The /account/detail response shape from Gate.io includes a `key`
    // sub-object with `mode`/`perms` on some accounts. We surface whatever
    // permission fields are present without making the response brittle.
    const raw = detail as unknown as {
      ip_whitelist?: string[];
      key?: {
        mode?: number;
        name?: string;
        perms?: Array<{ name?: string; read_only?: boolean }>;
      };
      // Some accounts return a flat `permissions` array instead.
      permissions?: Array<{ name?: string; read_only?: boolean }>;
    };
    const perms = raw.key?.perms ?? raw.permissions ?? [];
    const permSummary: Record<string, "read" | "write" | "withdraw"> = {};
    for (const p of perms) {
      if (!p?.name) continue;
      permSummary[p.name] = p.read_only ? "read" : "write";
    }
    return {
      status: "pass",
      duration_ms: Date.now() - start,
      permissions: permSummary,
      ip_whitelist_count: Array.isArray(raw.ip_whitelist) ? raw.ip_whitelist.length : 0,
    };
  } catch (err) {
    return {
      status: "fail",
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function checkMobileApiToken(): CheckResult {
  const start = Date.now();
  const present = !!process.env.MOBILE_API_TOKEN;
  return {
    status: present ? "pass" : "not_configured",
    duration_ms: Date.now() - start,
    ...(present ? {} : { note: "MOBILE_API_TOKEN env var unset" }),
  };
}

export function checkFcm(): CheckResult {
  const start = Date.now();
  const hasJson = !!process.env.FCM_SERVICE_ACCOUNT_JSON;
  const hasPath = !!process.env.FCM_SERVICE_ACCOUNT_PATH;
  if (!hasJson && !hasPath) {
    return {
      status: "not_configured",
      duration_ms: Date.now() - start,
      note: "neither FCM_SERVICE_ACCOUNT_JSON nor FCM_SERVICE_ACCOUNT_PATH is set",
    };
  }
  return {
    status: "pass",
    duration_ms: Date.now() - start,
    source: hasJson ? "json" : "path",
  };
}

export function checkWebhookSecret(nodeEnv: string | undefined = process.env.NODE_ENV): CheckResult {
  const start = Date.now();
  const present = !!process.env.WEBHOOK_SECRET;
  if (present) return { status: "pass", duration_ms: Date.now() - start };
  // In dev we tolerate it (degrades), in any other env it's a hard fail.
  if (nodeEnv === "development") {
    return {
      status: "not_configured",
      duration_ms: Date.now() - start,
      note: "WEBHOOK_SECRET unset (allowed in development)",
    };
  }
  return {
    status: "fail",
    duration_ms: Date.now() - start,
    error: "WEBHOOK_SECRET env var is required outside development",
  };
}

export async function checkRiskConfig(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const rows = await db
      .select({
        killSwitch: riskConfigTable.killSwitch,
        globalMaxOpenTrades: riskConfigTable.globalMaxOpenTrades,
        dailyLossLimitPct: riskConfigTable.dailyLossLimitPct,
      })
      .from(riskConfigTable)
      .limit(1);
    const row = rows[0];
    if (!row) {
      return {
        status: "fail",
        duration_ms: Date.now() - start,
        error: "risk_config table is empty — no config row present",
      };
    }
    return {
      status: "pass",
      duration_ms: Date.now() - start,
      kill_switch: row.killSwitch,
      global_max_open_trades: row.globalMaxOpenTrades,
      daily_loss_limit_pct: row.dailyLossLimitPct,
    };
  } catch (err) {
    return {
      status: "fail",
      duration_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Resolve the running version once at module load — cheap and stable.
function readVersion(): string {
  // The build inlines this via package.json; at runtime we fall back to env.
  return process.env.npm_package_version ?? process.env.APP_VERSION ?? "0.0.0";
}

router.get("/health/deep", async (_req, res) => {
  const results = await Promise.allSettled([
    withTimeout("db", checkDb),
    withTimeout("gateio", checkGateio),
    // Synchronous-ish checks are still wrapped so timing is uniform.
    Promise.resolve(checkMobileApiToken()),
    Promise.resolve(checkFcm()),
    Promise.resolve(checkWebhookSecret()),
    withTimeout("risk_config", checkRiskConfig),
  ]);

  const [dbR, gateR, mobR, fcmR, webR, riskR] = results;
  const fallback = (r: PromiseSettledResult<CheckResult>, label: string): CheckResult => {
    if (r.status === "fulfilled") return r.value;
    return {
      status: "fail",
      duration_ms: 0,
      error: `${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
    };
  };

  const checks = {
    db: fallback(dbR, "db"),
    gateio: fallback(gateR, "gateio"),
    mobile_api_token: fallback(mobR, "mobile_api_token"),
    fcm: fallback(fcmR, "fcm"),
    webhook_secret: fallback(webR, "webhook_secret"),
    risk_config: fallback(riskR, "risk_config"),
  };

  const overall = aggregateStatus(checks);
  const body: DeepHealthResponse = {
    status: overall,
    uptime_seconds: Math.round(process.uptime()),
    version: readVersion(),
    checks,
    timestamp: new Date().toISOString(),
  };
  res.status(httpStatusFor(overall)).json(body);
});

export default router;
