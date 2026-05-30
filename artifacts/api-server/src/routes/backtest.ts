/**
 * Phase 2 backtester routes — read-only historical replay.
 *
 * Endpoints:
 *   POST /api/backtest/run          — start a run, sync if small range, 202 + jobId otherwise
 *   GET  /api/backtest/jobs/:id     — poll job state
 *   GET  /api/backtest/jobs         — list recent jobs (in-memory)
 *
 * Job store is in-memory (process-local). DB persistence is intentionally out
 * of scope — the backtester is an operator tool, not a production data path.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import {
  intervalToSeconds,
  runBacktest,
  SYNC_CANDLE_BUDGET,
  type BacktestResult,
  type BacktestStrategy,
  type BacktestSizing,
  type BacktestConfig,
} from "../services/backtest";

const router = Router();

type JobStatus = "queued" | "running" | "done" | "error";

interface BacktestJob {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  request: BacktestRequest;
  result: BacktestResult | null;
  error: string | null;
}

interface BacktestRequest {
  gateSymbol: string;
  startTime:  string;
  endTime:    string;
  timeframe:  string;
  strategy:   BacktestStrategy;
  config:     BacktestConfig;
  sizing:     BacktestSizing;
}

const JOB_STORE = new Map<string, BacktestJob>();
const JOB_MAX = 50;

function recordJob(job: BacktestJob): void {
  JOB_STORE.set(job.id, job);
  if (JOB_STORE.size > JOB_MAX) {
    // Drop the oldest entry (Map preserves insertion order).
    const first = JOB_STORE.keys().next().value;
    if (first) JOB_STORE.delete(first);
  }
}

function validateRequest(body: unknown): { ok: true; req: BacktestRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be an object" };
  const b = body as Record<string, unknown>;
  const required = ["gateSymbol", "startTime", "endTime", "timeframe", "strategy"];
  for (const k of required) {
    if (typeof b[k] !== "string" || (b[k] as string).length === 0) {
      return { ok: false, error: `Missing or invalid field: ${k}` };
    }
  }
  const strategy = b.strategy as string;
  if (!["bb_rsi", "cht", "mrx-hybrid", "smc_mss"].includes(strategy)) {
    return { ok: false, error: `Unsupported strategy: ${strategy}` };
  }
  const sizing = (b.sizing ?? {}) as Partial<BacktestSizing>;
  const baseUsdt = typeof sizing.baseUsdt === "number" && sizing.baseUsdt > 0 ? sizing.baseUsdt : 50;
  const qualityAwareSizing = sizing.qualityAwareSizing === true;
  const qualitySizeFloorPct = typeof sizing.qualitySizeFloorPct === "number" ? sizing.qualitySizeFloorPct : 50;
  const kelly = sizing.kelly ?? { enabled: false, lookbackTrades: 30, minTrades: 10, safetyFraction: 0.5, floorPct: 10, maxPct: 100 };

  return {
    ok: true,
    req: {
      gateSymbol: b.gateSymbol as string,
      startTime:  b.startTime  as string,
      endTime:    b.endTime    as string,
      timeframe:  b.timeframe  as string,
      strategy:   strategy as BacktestStrategy,
      config:     (b.config ?? {}) as BacktestConfig,
      sizing:     { baseUsdt, qualityAwareSizing, qualitySizeFloorPct, kelly },
    },
  };
}

/** Estimate candle count without fetching — used for sync vs async routing. */
function estimateCandles(startMs: number, endMs: number, timeframe: string): number {
  try {
    const sec = intervalToSeconds(timeframe);
    return Math.max(0, Math.ceil((endMs - startMs) / 1000 / sec));
  } catch {
    return SYNC_CANDLE_BUDGET + 1; // Force async on unknown timeframe — runner will surface the error.
  }
}

async function executeJob(job: BacktestJob): Promise<void> {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  try {
    const result = await runBacktest(job.request);
    job.result = result;
    job.status = "done";
  } catch (err) {
    job.error = err instanceof Error ? err.message : String(err);
    job.status = "error";
    logger.warn({ err, jobId: job.id }, "backtest: job failed");
  } finally {
    job.finishedAt = new Date().toISOString();
  }
}

router.post("/run", async (req, res): Promise<void> => {
  const v = validateRequest(req.body);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }

  const startMs = Date.parse(v.req.startTime);
  const endMs   = Date.parse(v.req.endTime);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    res.status(400).json({ error: "Invalid start/end time" });
    return;
  }

  const job: BacktestJob = {
    id: randomUUID(),
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    request: v.req,
    result: null,
    error: null,
  };
  recordJob(job);

  const estimated = estimateCandles(startMs, endMs, v.req.timeframe);
  if (estimated <= SYNC_CANDLE_BUDGET) {
    await executeJob(job);
    if (job.status === "error") {
      res.status(500).json({ jobId: job.id, error: job.error });
      return;
    }
    res.status(200).json({ jobId: job.id, status: job.status, result: job.result });
    return;
  }

  // Async path — fire-and-forget. The job updates itself in place; clients poll
  // GET /jobs/:id. We don't await here so the response returns 202 immediately.
  void executeJob(job);
  res.status(202).json({ jobId: job.id, status: job.status, estimatedCandles: estimated });
});

router.get("/jobs/:id", (req, res): void => {
  const job = JOB_STORE.get(req.params.id);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  res.json(job);
});

router.get("/jobs", (_req, res): void => {
  const rows = [...JOB_STORE.values()]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((j) => ({
      id: j.id,
      status: j.status,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      gateSymbol: j.request.gateSymbol,
      timeframe: j.request.timeframe,
      strategy: j.request.strategy,
      totalTrades: j.result?.summary.totalTrades ?? null,
      netPnl: j.result?.summary.netPnl ?? null,
    }));
  res.json({ jobs: rows });
});

/** Test-only: reset the in-process job store. Not exported in prod routes. */
export function _resetJobStore(): void {
  JOB_STORE.clear();
}

export default router;
