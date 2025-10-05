import { Router } from "express";
import {
  registerUser,
  verifyOtp,
  getMe,
  resendOtp,
  sendForgotPasswordOtp,
  resetPasswordWithOtp,
  verifyForgotPasswordOtp,
  googleLogin,
  logoutUser,
  loginUser,
  refreshToken
} from "../controllers/authController";
import { authenticate } from "../middlewares/auth";

const router = Router();

router.post("/register", registerUser);
router.post("/verify-otp", verifyOtp);
router.get("/me", authenticate, getMe);
router.post("/login", loginUser);

router.post("/resend-otp", resendOtp);

// Send OTP for forgot password flow
router.post("/forgot-password", sendForgotPasswordOtp);

// Reset password using OTP
router.post("/reset-password", resetPasswordWithOtp);

router.post("/verify-forgot-otp", verifyForgotPasswordOtp);

router.post("/logout", logoutUser);
router.post("/google-login", googleLogin);
router.post("/refresh-token", refreshToken);


export default router;

