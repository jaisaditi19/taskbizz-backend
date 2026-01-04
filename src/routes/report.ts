import { Router } from "express";
import { getEmployeeSummaryReport } from "../controllers/reportController";
import { authenticate } from "../middlewares/auth";
import { authorize, authorizeAny } from "../middlewares/authorize";
import { requireWriteAccess } from "../middlewares/subscription";
import { generateTaskReport } from "../reports/generateTaskReport";


const router = Router();

// Only allow authenticated users to create org
router.get("/employee-summary", authenticate, authorizeAny(["ADMIN", "MANAGER"]), getEmployeeSummaryReport);
router.post("/tasks", authenticate, authorizeAny(["ADMIN", "MANAGER"]), generateTaskReport);

export default router;
