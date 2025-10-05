"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const orgController_1 = require("../controllers/orgController");
const auth_1 = require("../middlewares/auth");
const authorize_1 = require("../middlewares/authorize");
const subscription_1 = require("../middlewares/subscription");
const router = (0, express_1.Router)();
// Only allow authenticated users to create org
router.post("/create", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), subscription_1.requireWriteAccess, orgController_1.upload, orgController_1.createOrganization);
router.get("/details", auth_1.authenticate, orgController_1.getOrganizationDetails);
router.get("/progress", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), orgController_1.getDailyProgress);
exports.default = router;
