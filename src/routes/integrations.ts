import { Router } from "express";
import {
  getGstinDetails,
  fetchReturnStatus,
  getGstReturnStatus,
} from "../controllers/gstController";
import { authenticate } from "../middlewares/auth";
import { orgMiddleware } from "../middlewares/orgMiddleware";

const router = Router();
router.get("/gst/gstin/:gstin", getGstinDetails);
router.use(authenticate, orgMiddleware);
router.post("/gst/returns/fetch", fetchReturnStatus);
router.get("/gst/returns/:gstin", getGstReturnStatus);

export default router;
