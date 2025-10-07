import { Router } from "express";
import { getGstinDetails } from "../controllers/gstController";

const router = Router();
router.get("/gst/gstin/:gstin", getGstinDetails);

export default router;
