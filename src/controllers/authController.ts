import { Response, Request } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import redisClient from "../config/redisClient";
import { OAuth2Client } from "google-auth-library";
import { randomUUID } from "crypto";
import { sendAuthEmail } from "../utils/mailerSend";
import { getCorePrisma } from "../di/container";
import { cacheUserOrgPointer, primeOrgSnapshot } from "../utils/orgCache";
import { getCachedUserOrgId, getOrgSnapshot } from "../utils/orgCache";
import { getFileUrlFromSpaces } from "../utils/spacesUtils";

const RESEND_OTP_COOLDOWN_MS = 30 * 1000; // 30 seconds cooldown for resend
const OTP_EXPIRY_MS = 10 * 60 * 1000; // OTP valid for 10 minutes

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Helper to sign Access Token (short-lived)
function signAccessToken(payload: object) {
  return jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: "1d" });
}

// Helper to sign Refresh Token (longer-lived)
function signRefreshToken(payload: object) {
  return jwt.sign(
    { ...payload, jti: randomUUID() }, // add unique identifier
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: "7d" }
  );
}

// Register user and send OTP for email verification
export const registerUser = async (req: Request, res: Response) => {
  try {
    const { name, email, password, phone, address, city, state, pincode } =
      req.body;

    const prisma = getCorePrisma();

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + OTP_EXPIRY_MS);

    await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        phone,
        otp,
        otpExpires,
        role: "ADMIN",
        status: "PENDING_VERIFICATION",
        address,
        city,
        state,
        pincode,
      },
    });

    await sendAuthEmail({
      to: email,
      subject: `Your TaskBizz OTP Code ${otp}`,
      html: `<p>Your OTP is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
      text: `Your OTP is ${otp}. It expires in 10 minutes.`,
    });

    return res.status(201).json({ message: "OTP sent to email" });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Verify OTP for email verification after signup and login (updated to generate tokens)
export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required." });
    }

    const prisma = getCorePrisma();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.isVerified) {
      return res.status(400).json({ message: "User already verified" });
    }

    if (user.otp !== otp || !user.otpExpires || user.otpExpires < new Date()) {
      return res.status(400).json({ message: "Invalid or expired OTP" });
    }

    await prisma.user.update({
      where: { email },
      data: {
        isVerified: true,
        otp: null,
        otpExpires: null,
        status: "ACTIVE",
      },
    });

    // Create tokens
    const accessToken = signAccessToken({
      id: user.id,
      role: user.role,
      orgId: user.orgId,
    });
    const refreshToken = signRefreshToken({
      id: user.id,
      role: user.role,
      orgId: user.orgId,
    });
    const refreshTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: refreshTokenExpiry,
      },
    });

    // Set refresh token in HttpOnly secure cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    await cacheUserOrgPointer(user.id, user.orgId ?? null);
    if (user.orgId) await primeOrgSnapshot(user.orgId);

    return res.status(200).json({
      message: "OTP verified successfully",
      token: accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone || null,
        orgId: user.orgId || null,
      },
    });
  } catch (err) {
    console.error("Verify OTP error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Resend OTP with cooldown limit
export const resendOtp = async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    const prisma = getCorePrisma();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const now = Date.now();

    if (user.otpSentAt) {
      const timeSinceLastSent = now - user.otpSentAt.getTime();
      if (timeSinceLastSent < RESEND_OTP_COOLDOWN_MS) {
        const waitSeconds = Math.ceil(
          (RESEND_OTP_COOLDOWN_MS - timeSinceLastSent) / 1000
        );
        return res.status(429).json({
          message: `Please wait ${waitSeconds} seconds before requesting another OTP.`,
        });
      }
    }

    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(now + OTP_EXPIRY_MS);
    const otpSentAt = new Date(now);

    await prisma.user.update({
      where: { email },
      data: {
        otp: newOtp,
        otpExpires,
        otpSentAt,
      },
    });

    await sendAuthEmail({
      to: email,
      subject: `Your TaskBizz OTP Code ${newOtp}`,
      html: `<p>Your OTP is <strong>${newOtp}</strong>. It expires in 10 minutes.</p>`,
      text: `Your OTP is ${newOtp}. It expires in 10 minutes.`,
    });

    return res.status(200).json({ message: "OTP resent successfully." });
  } catch (error) {
    console.error("Resend OTP error:", error);
    return res.status(500).json({ message: "Failed to resend OTP." });
  }
};

// Send OTP for forgot password flow
export const sendForgotPasswordOtp = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== "string") {
      return res.status(400).json({ message: "Valid email is required." });
    }

    const prisma = getCorePrisma();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Don't reveal if email exists
      return res.status(200).json({
        message:
          "If that email is registered, an OTP has been sent for password reset.",
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + OTP_EXPIRY_MS);

    await prisma.user.update({
      where: { email },
      data: {
        otp,
        otpExpires,
      },
    });

    await sendAuthEmail({
      to: email,
      subject: `Your TaskBizz Password Reset OTP ${otp}`,
      html: `<p>Your password reset OTP is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
      text: `Your password reset OTP is ${otp}. It expires in 10 minutes.`,
    });

    return res.status(200).json({
      message:
        "If that email is registered, an OTP has been sent for password reset.",
    });
  } catch (error) {
    console.error("Forgot password OTP error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// Verify OTP and reset password (forgot password flow)
export const resetPasswordWithOtp = async (req: Request, res: Response) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res
        .status(400)
        .json({ message: "Email, OTP and new password are required." });
    }

    const prisma = getCorePrisma();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.otp || !user.otpExpires) {
      return res
        .status(400)
        .json({ message: "Invalid request or OTP expired." });
    }

    if (user.otp !== otp || user.otpExpires < new Date()) {
      return res.status(400).json({ message: "Invalid or expired OTP." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { email },
      data: {
        password: hashedPassword,
        otp: null,
        otpExpires: null,
      },
    });

    return res.status(200).json({ message: "Password reset successfully." });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// Verify forgot password OTP
export const verifyForgotPasswordOtp = async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: "Email and OTP are required." });
    }

    const prisma = getCorePrisma();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.otp || !user.otpExpires) {
      return res
        .status(400)
        .json({ message: "No OTP found. Please request a new one." });
    }

    if (user.otp !== otp || user.otpExpires < new Date()) {
      return res.status(400).json({ message: "Invalid or expired OTP." });
    }

    return res.status(200).json({ message: "OTP verified successfully." });
  } catch (error) {
    console.error("Verify forgot password OTP error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// Get current user info (requires auth middleware to set req.user)
export const getMe = async (req: Request & { user?: any }, res: Response) => {
  try {
    let userId: string | null = req.user?.id ?? null;

    // Fallback #1: Authorization header (access token)
    if (!userId) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        try {
          const decoded: any = jwt.verify(
            authHeader.split(" ")[1],
            process.env.JWT_SECRET!
          );
          userId = decoded.id ?? null;
        } catch {
          // ignore
        }
      }
    }

    // Fallback #2: refresh token cookie
    if (!userId && req.cookies?.refreshToken) {
      try {
        const decoded: any = jwt.verify(
          req.cookies.refreshToken,
          process.env.JWT_REFRESH_SECRET!
        );
        userId = decoded.id ?? null;
      } catch {
        // ignore
      }
    }

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const prisma = getCorePrisma();

    // Load user basics (lean)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, role: true, orgId: true },
    });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Resolve orgId (DB first, then cached pointer)
    const effectiveOrgId = user.orgId ?? (await getCachedUserOrgId(user.id));

    // Load cached org snapshot (expected to contain logoKey, name, status, id)
    const orgSnap = effectiveOrgId
      ? await getOrgSnapshot(effectiveOrgId)
      : null;

    // Presign a fresh logoUrl (short-lived) from logoKey
    let logoUrl: string | null = null;
    if ((orgSnap as any)?.logoUrl) {
      try {
        // keep expiry short to avoid stale URLs in the client cache
        logoUrl = await getFileUrlFromSpaces((orgSnap as any).logoUrl, 300); // 5 min
      } catch {
        logoUrl = null;
      }
    }

    const subscriptionCtx = (req as any).subscriptionCtx ?? null;

    // Shape the org object for the client
    const org = orgSnap
      ? {
          id: (orgSnap as any).id,
          name: (orgSnap as any).name,
          status: (orgSnap as any).status ?? null,
          logoUrl, // <- presigned, never stored
        }
      : null;

    return res.status(200).json({ user, org, subscriptionCtx });
  } catch (err) {
    console.error("Error fetching /auth/me:", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};


// Google login updated to use access + refresh tokens
export const googleLogin = async (req: Request, res: Response) => {
  try {
    const { id_token } = req.body;
    if (!id_token) {
      return res.status(400).json({ message: "id_token is required" });
    }

    // Verify the id_token with Google
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(400).json({ message: "Invalid Google token payload" });
    }

    const { email, name, picture, sub: googleId } = payload;

    if (!email) {
      return res.status(400).json({ message: "Google account has no email" });
    }

    const prisma = getCorePrisma();

    // Check if user already exists
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Register new user with role "ADMIN" or "EMPLOYEE" (choose your default)
      user = await prisma.user.create({
        data: {
          name: name || "Google User",
          email,
          password: "", // no password since google login
          isVerified: true,
          role: "ADMIN", // or "EMPLOYEE" based on your app logic
          status: "ACTIVE", // Set status to ACTIVE for new users
        },
      });
    }

    // Generate tokens
    const accessToken = signAccessToken({
      id: user.id,
      role: user.role,
      orgId: user.orgId,
    });
    const refreshToken = signRefreshToken({
      id: user.id,
      role: user.role,
      orgId: user.orgId,
    });

    const refreshTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await cacheUserOrgPointer(user.id, user.orgId ?? null);
    if (user.orgId) await primeOrgSnapshot(user.orgId);

    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: refreshTokenExpiry,
      },
    });

    // Set refresh token in HttpOnly secure cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.status(200).json({
      message: "Login successful",
      token: accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Google login error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// Refresh access token using refresh token cookie
export const refreshToken = async (req: Request, res: Response) => {
  try {
    const oldToken = req.cookies?.refreshToken;

    if (!oldToken)
      return res.status(401).json({ message: "Refresh token missing" });

    const prisma = getCorePrisma();

    // 1. Validate old token (DB + JWT)
    const tokenRecord = await prisma.refreshToken.findUnique({
      where: { token: oldToken },
    });

    if (
      !tokenRecord ||
      tokenRecord.revoked ||
      new Date() > tokenRecord.expiresAt
    ) {
      return res
        .status(403)
        .json({ message: "Invalid or expired refresh token" });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(oldToken, process.env.JWT_REFRESH_SECRET!);
    } catch (err) {
      return res.status(403).json({ message: "Invalid refresh token" });
    }

    // 2. Issue new refresh token and set cookie
    const newRefreshToken = signRefreshToken({
      id: decoded.id,
      role: decoded.role,
      orgId: decoded.orgId,
    });
    const refreshTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({
      data: {
        token: newRefreshToken,
        userId: decoded.id,
        expiresAt: refreshTokenExpiry,
      },
    });

    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const accessToken = signAccessToken({
      id: decoded.id,
      role: decoded.role,
      orgId: decoded.orgId,
    });

    return res.status(200).json({ token: accessToken });
  } catch (err) {
    console.error("Refresh token rotation error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Logout user by blacklisting access token and clearing refresh token cookie
export const logoutUser = async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ message: "Authorization header missing" });

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Token missing" });

    const decoded: any = jwt.decode(token);
    if (!decoded || !decoded.exp)
      return res.status(400).json({ message: "Invalid token" });

    const expiresAt = decoded.exp * 1000;
    const ttl = Math.floor((expiresAt - Date.now()) / 1000);

    // Blacklist access token in Redis
    if (ttl > 0) {
      try {
        await redisClient.set(`blacklist_${token}`, "true", { EX: ttl });
      } catch (err) {
        console.error("Redis set error when blacklisting token:", err);
      }
    }

    // Revoke refresh token from DB
    const refreshToken = req.cookies?.refreshToken;
    if (refreshToken) {
      const prisma = getCorePrisma();
      await prisma.refreshToken.updateMany({
        where: { token: refreshToken },
        data: { revoked: true },
      });
    }

    // Clear refresh token cookie
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });

    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
};

// Login with email/password - returns access token and sets refresh token cookie
export const loginUser = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required." });
    }

    const prisma = getCorePrisma();

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // If user not verified, generate OTP and send
    if (!user.isVerified) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
      const otpExpires = new Date(Date.now() + OTP_EXPIRY_MS);

      await prisma.user.update({
        where: { id: user.id },
        data: { otp: otp, otpExpires: otpExpires, otpSentAt: new Date() },
      });

      // Send OTP email
      await sendAuthEmail({
        to: user.email,
        subject: "Your TaskBizz OTP Code",
        html: `<p>Your OTP is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
        text: `Your OTP is ${otp}. It expires in 10 minutes.`,
      });

      return res.status(200).json({
        message: "OTP sent. Please verify before login.",
        isVerified: false,
        userId: user.id,
      });
    }

    // Sign tokens
    const accessToken = signAccessToken({
      id: user.id,
      role: user.role,
      orgId: user.orgId,
    });
    const refreshToken = signRefreshToken({
      id: user.id,
      role: user.role,
      orgId: user.orgId,
    });

    await cacheUserOrgPointer(user.id, user.orgId ?? null);
    if (user.orgId) await primeOrgSnapshot(user.orgId);

    const refreshTokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await prisma.refreshToken.create({
      data: {
        token: refreshToken,
        userId: user.id,
        expiresAt: refreshTokenExpiry,
      },
    });

    // Set refresh token in HttpOnly secure cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.status(200).json({
      token: accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone || null,
        orgId: user.orgId || null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/auth/sessions
export const listActiveSessions = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const prisma = getCorePrisma();

    const sessions = await prisma.refreshToken.findMany({
      where: {
        userId,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        token: true,
        createdAt: true,
        expiresAt: true,
        revoked: true,
      },
    });

    return res.json({ sessions });
  } catch (err) {
    console.error("List sessions error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// POST /api/auth/revoke-session/:sessionId
export const revokeSession = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { sessionId } = req.params;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const prisma = getCorePrisma();

    const updated = await prisma.refreshToken.updateMany({
      where: { id: sessionId, userId },
      data: { revoked: true },
    });

    if (updated.count === 0)
      return res.status(404).json({ message: "Session not found" });

    return res.json({ message: "Session revoked" });
  } catch (err) {
    console.error("Revoke session error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
