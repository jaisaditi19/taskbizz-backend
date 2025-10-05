// routes/leaveRoutes.ts
import { Router } from "express";
import * as leaveCtrl from "../controllers/leaveController";
import { authenticate } from "../middlewares/auth"; // ensures req.user & req.orgId
import { authorize, authorizeAny } from "../middlewares/authorize";
const router = Router();

router.post("/",authenticate, leaveCtrl.createLeave);
router.get("/",authenticate, leaveCtrl.listLeaves);
router.get("/:id",authenticate, leaveCtrl.getLeave);
router.post(
  "/:id/approve",
  authenticate,
  authorizeAny(["ADMIN", "MANAGER"]),
  leaveCtrl.approveLeave
); // admin only - controller checks role
router.post(
  "/:id/reject",
  authenticate,
  authorizeAny(["ADMIN","MANAGER"]),
  leaveCtrl.rejectLeave
); // admin only
router.post("/:id/cancel", authenticate, leaveCtrl.cancelLeave); // requester only
router.post("/:id/admin-cancel", leaveCtrl.adminCancelLeave);

export default router;
