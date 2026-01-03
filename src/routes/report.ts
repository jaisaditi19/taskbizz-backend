import { Router } from "express";
import { getEmployeeSummaryReport } from "../controllers/reportController";
import { authenticate } from "../middlewares/auth";
import { authorize, authorizeAny } from "../middlewares/authorize";
import { requireWriteAccess } from "../middlewares/subscription";


const router = Router();

// Only allow authenticated users to create org
router.get("/employee-summary", authenticate, authorizeAny(["ADMIN", "MANAGER"]), getEmployeeSummaryReport);

export default router;
