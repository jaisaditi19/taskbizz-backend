"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const paymentController_1 = require("../controllers/paymentController");
const auth_1 = require("../middlewares/auth");
const authorize_1 = require("../middlewares/authorize");
const express_2 = __importDefault(require("express"));
const router = (0, express_1.Router)();
router.post("/quote", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), paymentController_1.quote);
router.post("/create-order", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), paymentController_1.createRazorpayOrder);
router.post("/verify", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), paymentController_1.verifyPayment);
router.post("/webhook", express_2.default.raw({ type: "application/json" }), paymentController_1.razorpayWebhook);
router.get("/list", auth_1.authenticate, (0, authorize_1.authorize)("ADMIN"), paymentController_1.listPayments);
exports.default = router;
