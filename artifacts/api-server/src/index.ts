import type { Server } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { startSyncLoop, stopSyncLoop } from "./services/sync";
import { startScalperSyncLoop, stopScalperSyncLoop } from "./services/scalper-sync";
import { startScalperLoop, stopScalperLoop } from "./services/scalper-loop";
import { runStartupReconcile } from "./services/startup-reconcile";
import { pool } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

let httpServer: Server | null = null;
let shuttingDown = false;

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.warn({ signal }, "Shutdown: stopping engines and draining HTTP");

  // Stop the trading engines first so no new orders are placed mid-shutdown.
  try { stopScalperLoop(); } catch (err) { logger.warn({ err }, "shutdown: stopScalperLoop failed"); }
  try { stopScalperSyncLoop(); } catch (err) { logger.warn({ err }, "shutdown: stopScalperSyncLoop failed"); }
  try { stopSyncLoop(); } catch (err) { logger.warn({ err }, "shutdown: stopSyncLoop failed"); }

  // Close the HTTP listener — Node will wait for in-flight requests to finish.
  if (httpServer) {
    await new Promise<void>((resolve) => {
      httpServer!.close((err) => {
        if (err) logger.warn({ err }, "shutdown: httpServer.close error");
        resolve();
      });
    });
  }

  // Close the PG pool so the process can exit cleanly.
  try { await pool.end(); } catch (err) { logger.warn({ err }, "shutdown: pool.end failed"); }

  logger.info("Shutdown complete");
  // Give pino a tick to flush before exit
  setTimeout(() => process.exit(0), 100);
}

process.once("SIGTERM", (sig) => void gracefulShutdown(sig));
process.once("SIGINT", (sig) => void gracefulShutdown(sig));

// Hard guard for unhandled errors — log loud, then graceful-shutdown.
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException");
  void gracefulShutdown("SIGTERM");
});

httpServer = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  // A5+D5: reconcile DB vs Gate.io before engines start; 10s timeout guard
  Promise.race([
    runStartupReconcile(),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("reconcile timeout")), 10_000)),
  ]).catch((err: unknown) => logger.warn({ err }, "Startup reconcile failed or timed out — continuing"));
  startSyncLoop(30_000);
  startScalperSyncLoop(10_000);
  startScalperLoop(2.5 * 60_000);
});
