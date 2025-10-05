import { Router } from "express";
import {
  verifyPayment,
  quote,
  razorpayWebhook,
  createRazorpayOrder,
  listPayments
} from "../controllers/paymentController";
import { authenticate } from "../middlewares/auth";
import { authorize } from "../middlewares/authorize";
import express from "express";


const router = Router();

router.post("/quote", authenticate, authorize("ADMIN"), quote);
router.post("/create-order", authenticate, authorize("ADMIN"), createRazorpayOrder);
router.post("/verify", authenticate, authorize("ADMIN"), verifyPayment);
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  razorpayWebhook
);
router.get("/list", authenticate, authorize("ADMIN"), listPayments);

export default router;
