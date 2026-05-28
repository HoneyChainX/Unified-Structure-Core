import { Router, type IRouter } from "express";
import healthRouter from "./health";
import signalsRouter from "./signals";
import botRouter from "./bot";
import marketRouter from "./market";
import scalperRouter from "./scalper";
import devRouter from "./dev";
import riskRouter from "./risk";
import mobileRouter from "./mobile";
import devicesRouter from "./devices";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/signals", signalsRouter);
router.use("/bot", botRouter);
router.use("/market", marketRouter);
router.use("/scalper", scalperRouter);
router.use("/dev", devRouter);
router.use("/risk", riskRouter);
router.use("/mobile", mobileRouter);
router.use("/devices", devicesRouter);

export default router;
