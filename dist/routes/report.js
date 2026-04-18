"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const reportController_1 = require("../controllers/reportController");
const auth_1 = require("../middlewares/auth");
const authorize_1 = require("../middlewares/authorize");
const generateTaskReport_1 = require("../reports/generateTaskReport");
const router = (0, express_1.Router)();
// Only allow authenticated users to create org
router.get("/employee-summary", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), reportController_1.getEmployeeSummaryReport);
router.get("/employee-summary/export", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), reportController_1.exportEmployeeSummaryReport);
router.post("/tasks", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), generateTaskReport_1.generateTaskReport);
exports.default = router;
