import { Router, type IRouter } from "express";
import healthRouter from "./health";
import signalsRouter from "./signals";
import botRouter from "./bot";
import marketRouter from "./market";
import scalperRouter from "./scalper";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/signals", signalsRouter);
router.use("/bot", botRouter);
router.use("/market", marketRouter);
router.use("/scalper", scalperRouter);

export default router;
