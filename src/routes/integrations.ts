import { Router } from "express";
import {
  getGstinDetails,
  fetchReturnStatus,
  getGstReturnStatus,
  getLatestBatch,
} from "../controllers/gstController";
import { authenticate } from "../middlewares/auth";
import { orgMiddleware } from "../middlewares/orgMiddleware";

const router = Router();
router.get("/gst/gstin/:gstin", getGstinDetails);
router.use(authenticate, orgMiddleware);
router.post("/gst/returns/fetch", fetchReturnStatus);
router.get("/gst/returns/:gstin", getGstReturnStatus);
router.post("/gst/returns/latest:batch", getLatestBatch);

export default router;
