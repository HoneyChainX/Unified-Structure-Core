/**
 * Mobile-device management routes for the desktop dashboard.
 *
 * Same data as /api/mobile/devices but without bearer-token auth, since the
 * dashboard runs alongside the API server and doesn't carry MOBILE_API_TOKEN.
 * Keeps the security model clean: the mobile namespace stays bearer-gated for
 * internet-exposed traffic; the dashboard hits a separate path.
 */
import { Router } from "express";
import { db, mobileDevicesTable, updateMobileDeviceSchema } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

const router = Router();

router.get("/", async (_req, res) => {
  const rows = await db
    .select()
    .from(mobileDevicesTable)
    .orderBy(desc(mobileDevicesTable.registeredAt));
  res.json({ devices: rows });
});

router.put("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid device id" });
    return;
  }
  const parsed = updateMobileDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .update(mobileDevicesTable)
    .set({ ...parsed.data, lastSeenAt: new Date() })
    .where(eq(mobileDevicesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Device not found" });
    return;
  }
  res.json(row);
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid device id" });
    return;
  }
  await db.delete(mobileDevicesTable).where(eq(mobileDevicesTable.id, id));
  res.json({ ok: true });
});

export default router;
