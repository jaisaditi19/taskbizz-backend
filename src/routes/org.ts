import { Router } from "express";
import { createOrganization, getOrganizationDetails, upload, getDailyProgress } from "../controllers/orgController";
import { authenticate } from "../middlewares/auth";
import { authorize } from "../middlewares/authorize";
import { requireWriteAccess } from "../middlewares/subscription";


const router = Router();

// Only allow authenticated users to create org
router.post("/create", authenticate, authorize("ADMIN"),requireWriteAccess, upload, createOrganization);
router.get("/details", authenticate, getOrganizationDetails);
router.get(
  "/progress",
  authenticate,
  authorize("ADMIN"),
  getDailyProgress
);


export default router;
