"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middlewares/auth");
const subscription_1 = require("../middlewares/subscription");
const authorize_1 = require("../middlewares/authorize");
const billingController_1 = require("../controllers/billingController");
const router = (0, express_1.Router)();
router.get("/subscription", auth_1.authenticate, subscription_1.attachSubscriptionContext, billingController_1.getSubscriptionCtx);
router.post("/convert", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), billingController_1.convertTrialToPaid);
router.post("/apply-seat-topup", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), billingController_1.applySeatTopup);
router.post("/cancel-at-period-end", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), billingController_1.setCancelAtPeriodEnd);
// in your routes
router.post("/apply-plan-upgrade", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), billingController_1.applyPlanUpgrade);
router.get("/plans", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), billingController_1.getPlans);
exports.default = router;
