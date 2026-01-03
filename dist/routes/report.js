"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const reportController_1 = require("../controllers/reportController");
const auth_1 = require("../middlewares/auth");
const authorize_1 = require("../middlewares/authorize");
const router = (0, express_1.Router)();
// Only allow authenticated users to create org
router.get("/employee-summary", auth_1.authenticate, (0, authorize_1.authorizeAny)(["ADMIN", "MANAGER"]), reportController_1.getEmployeeSummaryReport);
exports.default = router;
