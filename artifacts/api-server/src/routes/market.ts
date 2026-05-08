import { Router } from "express";
import { getMarketStatus } from "../services/market";

const router = Router();

router.get("/status", async (req, res): Promise<void> => {
  try {
    const status = await getMarketStatus();
    res.json(status);
  } catch (err) {
    req.log.error({ err }, "Failed to get market status");
    res.status(500).json({ error: "Failed to fetch market status" });
  }
});

export default router;
