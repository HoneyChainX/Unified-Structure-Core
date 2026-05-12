import app from "./app";
import { logger } from "./lib/logger";
import { startSyncLoop } from "./services/sync";
import { startScalperSyncLoop } from "./services/scalper-sync";
import { startScalperLoop } from "./services/scalper-loop";
import { runStartupReconcile } from "./services/startup-reconcile";

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

app.listen(port, (err) => {
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
