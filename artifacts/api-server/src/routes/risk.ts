import { Router } from "express";
import { db, riskConfigTable, updateRiskConfigSchema } from "@workspace/db";
import { getCombinedOpenExposure } from "../services/exposure";
import { setKillSwitch } from "../services/risk-guard";
import { logger } from "../lib/logger";

const router = Router();

async function readConfig() {
  const [row] = await db.select().from(riskConfigTable).limit(1);
  if (row) return row;
  const [seeded] = await db.insert(riskConfigTable).values({}).returning();
  return seeded;
}

/** GET /api/risk — current risk config + live combined exposure. */
router.get("/", async (_req, res) => {
  const [config, exposure] = await Promise.all([
    readConfig(),
    getCombinedOpenExposure(),
  ]);
  res.json({ config, exposure });
});

/** PUT /api/risk — update risk config fields. */
router.put("/", async (req, res): Promise<void> => {
  const parsed = updateRiskConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const current = await readConfig();
  const [updated] = await db
    .update(riskConfigTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .returning();
  logger.info({ before: current, after: updated }, "risk-config updated");
  res.json(updated);
});

/** POST /api/risk/kill — engage the global kill switch. */
router.post("/kill", async (req, res) => {
  const reason = typeof req.body?.reason === "number" ? req.body.reason : 0;
  await setKillSwitch(true, reason);
  const config = await readConfig();
  res.json({ ok: true, config });
});

/** POST /api/risk/resume — clear the kill switch. */
router.post("/resume", async (_req, res) => {
  await setKillSwitch(false);
  const config = await readConfig();
  res.json({ ok: true, config });
});

export default router;
