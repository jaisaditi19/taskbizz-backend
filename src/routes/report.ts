import { Router } from "express";
import { getEmployeeSummaryReport,exportEmployeeSummaryReport } from "../controllers/reportController";
import { authenticate } from "../middlewares/auth";
import { authorize, authorizeAny } from "../middlewares/authorize";
import { requireWriteAccess } from "../middlewares/subscription";
import { generateTaskReport } from "../reports/generateTaskReport";


const router = Router();

// Only allow authenticated users to create org
router.get("/employee-summary", authenticate, authorizeAny(["ADMIN", "MANAGER"]), getEmployeeSummaryReport);
router.get(
  "/employee-summary/export",
  authenticate,
  authorizeAny(["ADMIN", "MANAGER"]),
  exportEmployeeSummaryReport,
);
router.post("/tasks", authenticate, authorizeAny(["ADMIN", "MANAGER"]), generateTaskReport);

export default router;
