import { Router } from "express";
import { authenticate } from "../middlewares/auth";
import { attachSubscriptionContext } from "../middlewares/subscription";
import { authorize } from "../middlewares/authorize";
import {
  convertTrialToPaid,
  getSubscriptionCtx,
  applySeatTopup,
  setCancelAtPeriodEnd,
  applyPlanUpgrade,
  getPlans
} from "../controllers/billingController";

const router = Router();

router.get(
  "/subscription",
  authenticate,
  attachSubscriptionContext,
  getSubscriptionCtx
);

router.post("/convert", authenticate, authorize("ADMIN"), convertTrialToPaid);
router.post(
  "/apply-seat-topup",
  authenticate,
  authorize("ADMIN"),
  applySeatTopup
);

router.post(
  "/cancel-at-period-end",
  authenticate,
  authorize("ADMIN"),
  setCancelAtPeriodEnd
);

// in your routes
router.post("/apply-plan-upgrade", authenticate, authorize("ADMIN"), applyPlanUpgrade);
router.get("/plans", authenticate, authorize("ADMIN"), getPlans);


export default router;
