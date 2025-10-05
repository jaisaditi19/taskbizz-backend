"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const authController_1 = require("../controllers/authController");
const auth_1 = require("../middlewares/auth");
const router = (0, express_1.Router)();
router.post("/register", authController_1.registerUser);
router.post("/verify-otp", authController_1.verifyOtp);
router.get("/me", auth_1.authenticate, authController_1.getMe);
router.post("/login", authController_1.loginUser);
router.post("/resend-otp", authController_1.resendOtp);
// Send OTP for forgot password flow
router.post("/forgot-password", authController_1.sendForgotPasswordOtp);
// Reset password using OTP
router.post("/reset-password", authController_1.resetPasswordWithOtp);
router.post("/verify-forgot-otp", authController_1.verifyForgotPasswordOtp);
router.post("/logout", authController_1.logoutUser);
router.post("/google-login", authController_1.googleLogin);
router.post("/refresh-token", authController_1.refreshToken);
exports.default = router;
