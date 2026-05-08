import app from "./app";
import { logger } from "./lib/logger";
import { startSyncLoop } from "./services/sync";
import { startScalperSyncLoop } from "./services/scalper-sync";
import { startScalperLoop } from "./services/scalper-loop";

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
  startSyncLoop(30_000);
  startScalperSyncLoop(30_000);
  startScalperLoop(5 * 60_000);
});
