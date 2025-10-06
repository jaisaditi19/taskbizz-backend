"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.revokeSession = exports.listActiveSessions = exports.loginUser = exports.logoutUser = exports.refreshToken = exports.googleLogin = exports.getMe = exports.verifyForgotPasswordOtp = exports.resetPasswordWithOtp = exports.sendForgotPasswordOtp = exports.resendOtp = exports.verifyOtp = exports.registerUser = void 0;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const redisClient_1 = __importDefault(require("../config/redisClient"));
const google_auth_library_1 = require("google-auth-library");
const crypto_1 = require("crypto");
const mailerSend_1 = require("../utils/mailerSend");
const container_1 = require("../di/container");
const orgCache_1 = require("../utils/orgCache");
const orgCache_2 = require("../utils/orgCache");
const spacesUtils_1 = require("../utils/spacesUtils");
const RESEND_OTP_COOLDOWN_MS = 30 * 1000; // 30 seconds cooldown for resend
const OTP_EXPIRY_MS = 10 * 60 * 1000; // OTP valid for 10 minutes
const client = new google_auth_library_1.OAuth2Client(process.env.GOOGLE_CLIENT_ID);
// Helper to sign Access Token (short-lived)
function signAccessToken(payload) {
    return jsonwebtoken_1.default.sign(payload, process.env.JWT_SECRET, { expiresIn: "1d" });
}
// Helper to sign Refresh Token (longer-lived)
function signRefreshToken(payload) {
    return jsonwebtoken_1.default.sign({ ...payload, jti: (0, crypto_1.randomUUID)() }, // add unique identifier
    process.env.JWT_REFRESH_SECRET, { expiresIn: "7d" });
}
// Register user and send OTP for email verification
const registerUser = async (req, res) => {
    try {
        const { name, email, password, phone, address, city, state, pincode } = req.body;
        const prisma = (0, container_1.getCorePrisma)();
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(409).json({ message: "User already exists" });
        }
        const hashedPassword = await bcrypt_1.default.hash(password, 10);
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
        await (0, mailerSend_1.sendAuthEmail)({
            to: email,
            subject: `Your TaskBizz OTP Code ${otp}`,
            html: `<p>Your OTP is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
            text: `Your OTP is ${otp}. It expires in 10 minutes.`,
        });
        return res.status(201).json({ message: "OTP sent to email" });
    }
    catch (err) {
        console.error("Register error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};
exports.registerUser = registerUser;
// Verify OTP for email verification after signup and login (updated to generate tokens)
const verifyOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            return res.status(400).json({ message: "Email and OTP are required." });
        }
        const prisma = (0, container_1.getCorePrisma)();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user)
            return res.status(404).json({ message: "User not found" });
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
        await (0, orgCache_1.cacheUserOrgPointer)(user.id, user.orgId ?? null);
        if (user.orgId)
            await (0, orgCache_1.primeOrgSnapshot)(user.orgId);
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
    }
    catch (err) {
        console.error("Verify OTP error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};
exports.verifyOtp = verifyOtp;
// Resend OTP with cooldown limit
const resendOtp = async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== "string") {
        return res.status(400).json({ message: "Email is required." });
    }
    try {
        const prisma = (0, container_1.getCorePrisma)();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }
        const now = Date.now();
        if (user.otpSentAt) {
            const timeSinceLastSent = now - user.otpSentAt.getTime();
            if (timeSinceLastSent < RESEND_OTP_COOLDOWN_MS) {
                const waitSeconds = Math.ceil((RESEND_OTP_COOLDOWN_MS - timeSinceLastSent) / 1000);
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
        await (0, mailerSend_1.sendAuthEmail)({
            to: email,
            subject: `Your TaskBizz OTP Code ${newOtp}`,
            html: `<p>Your OTP is <strong>${newOtp}</strong>. It expires in 10 minutes.</p>`,
            text: `Your OTP is ${newOtp}. It expires in 10 minutes.`,
        });
        return res.status(200).json({ message: "OTP resent successfully." });
    }
    catch (error) {
        console.error("Resend OTP error:", error);
        return res.status(500).json({ message: "Failed to resend OTP." });
    }
};
exports.resendOtp = resendOtp;
// Send OTP for forgot password flow
const sendForgotPasswordOtp = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || typeof email !== "string") {
            return res.status(400).json({ message: "Valid email is required." });
        }
        const prisma = (0, container_1.getCorePrisma)();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) {
            // Don't reveal if email exists
            return res.status(200).json({
                message: "If that email is registered, an OTP has been sent for password reset.",
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
        await (0, mailerSend_1.sendAuthEmail)({
            to: email,
            subject: `Your TaskBizz Password Reset OTP ${otp}`,
            html: `<p>Your password reset OTP is <strong>${otp}</strong>. It expires in 10 minutes.</p>`,
            text: `Your password reset OTP is ${otp}. It expires in 10 minutes.`,
        });
        return res.status(200).json({
            message: "If that email is registered, an OTP has been sent for password reset.",
        });
    }
    catch (error) {
        console.error("Forgot password OTP error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};
exports.sendForgotPasswordOtp = sendForgotPasswordOtp;
// Verify OTP and reset password (forgot password flow)
const resetPasswordWithOtp = async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword) {
            return res
                .status(400)
                .json({ message: "Email, OTP and new password are required." });
        }
        const prisma = (0, container_1.getCorePrisma)();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.otp || !user.otpExpires) {
            return res
                .status(400)
                .json({ message: "Invalid request or OTP expired." });
        }
        if (user.otp !== otp || user.otpExpires < new Date()) {
            return res.status(400).json({ message: "Invalid or expired OTP." });
        }
        const hashedPassword = await bcrypt_1.default.hash(newPassword, 10);
        await prisma.user.update({
            where: { email },
            data: {
                password: hashedPassword,
                otp: null,
                otpExpires: null,
            },
        });
        return res.status(200).json({ message: "Password reset successfully." });
    }
    catch (error) {
        console.error("Reset password error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};
exports.resetPasswordWithOtp = resetPasswordWithOtp;
// Verify forgot password OTP
const verifyForgotPasswordOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            return res.status(400).json({ message: "Email and OTP are required." });
        }
        const prisma = (0, container_1.getCorePrisma)();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user)
            return res.status(404).json({ message: "User not found" });
        if (!user.otp || !user.otpExpires) {
            return res
                .status(400)
                .json({ message: "No OTP found. Please request a new one." });
        }
        if (user.otp !== otp || user.otpExpires < new Date()) {
            return res.status(400).json({ message: "Invalid or expired OTP." });
        }
        return res.status(200).json({ message: "OTP verified successfully." });
    }
    catch (error) {
        console.error("Verify forgot password OTP error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};
exports.verifyForgotPasswordOtp = verifyForgotPasswordOtp;
// Get current user info (requires auth middleware to set req.user)
const getMe = async (req, res) => {
    try {
        let userId = req.user?.id ?? null;
        // Fallback #1: Authorization header (access token)
        if (!userId) {
            const authHeader = req.headers.authorization;
            if (authHeader?.startsWith("Bearer ")) {
                try {
                    const decoded = jsonwebtoken_1.default.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
                    userId = decoded.id ?? null;
                }
                catch {
                    // ignore
                }
            }
        }
        // Fallback #2: refresh token cookie
        if (!userId && req.cookies?.refreshToken) {
            try {
                const decoded = jsonwebtoken_1.default.verify(req.cookies.refreshToken, process.env.JWT_REFRESH_SECRET);
                userId = decoded.id ?? null;
            }
            catch {
                // ignore
            }
        }
        if (!userId) {
            return res.status(401).json({ message: "Unauthorized" });
        }
        const prisma = (0, container_1.getCorePrisma)();
        // Load user basics (lean)
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, email: true, role: true, orgId: true },
        });
        if (!user)
            return res.status(404).json({ message: "User not found" });
        // Resolve orgId (DB first, then cached pointer)
        const effectiveOrgId = user.orgId ?? (await (0, orgCache_2.getCachedUserOrgId)(user.id));
        // Load cached org snapshot (expected to contain logoKey, name, status, id)
        const orgSnap = effectiveOrgId
            ? await (0, orgCache_2.getOrgSnapshot)(effectiveOrgId)
            : null;
        // Presign a fresh logoUrl (short-lived) from logoKey
        let logoUrl = null;
        if (orgSnap?.logoUrl) {
            try {
                // keep expiry short to avoid stale URLs in the client cache
                logoUrl = await (0, spacesUtils_1.getFileUrlFromSpaces)(orgSnap.logoUrl, 300); // 5 min
            }
            catch {
                logoUrl = null;
            }
        }
        const subscriptionCtx = req.subscriptionCtx ?? null;
        // Shape the org object for the client
        const org = orgSnap
            ? {
                id: orgSnap.id,
                name: orgSnap.name,
                status: orgSnap.status ?? null,
                logoUrl, // <- presigned, never stored
            }
            : null;
        return res.status(200).json({ user, org, subscriptionCtx });
    }
    catch (err) {
        console.error("Error fetching /auth/me:", err);
        return res.status(500).json({ message: "Internal Server Error" });
    }
};
exports.getMe = getMe;
// Google login updated to use access + refresh tokens
const googleLogin = async (req, res) => {
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
        const prisma = (0, container_1.getCorePrisma)();
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
        await (0, orgCache_1.cacheUserOrgPointer)(user.id, user.orgId ?? null);
        if (user.orgId)
            await (0, orgCache_1.primeOrgSnapshot)(user.orgId);
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
    }
    catch (error) {
        console.error("Google login error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};
exports.googleLogin = googleLogin;
// Refresh access token using refresh token cookie
const refreshToken = async (req, res) => {
    try {
        const oldToken = req.cookies?.refreshToken;
        if (!oldToken)
            return res.status(401).json({ message: "Refresh token missing" });
        const prisma = (0, container_1.getCorePrisma)();
        // 1. Validate old token (DB + JWT)
        const tokenRecord = await prisma.refreshToken.findUnique({
            where: { token: oldToken },
        });
        if (!tokenRecord ||
            tokenRecord.revoked ||
            new Date() > tokenRecord.expiresAt) {
            return res
                .status(403)
                .json({ message: "Invalid or expired refresh token" });
        }
        let decoded;
        try {
            decoded = jsonwebtoken_1.default.verify(oldToken, process.env.JWT_REFRESH_SECRET);
        }
        catch (err) {
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
    }
    catch (err) {
        console.error("Refresh token rotation error:", err);
        res.status(500).json({ message: "Server error" });
    }
};
exports.refreshToken = refreshToken;
// Logout user by blacklisting access token and clearing refresh token cookie
const logoutUser = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader)
            return res.status(401).json({ message: "Authorization header missing" });
        const token = authHeader.split(" ")[1];
        if (!token)
            return res.status(401).json({ message: "Token missing" });
        const decoded = jsonwebtoken_1.default.decode(token);
        if (!decoded || !decoded.exp)
            return res.status(400).json({ message: "Invalid token" });
        const expiresAt = decoded.exp * 1000;
        const ttl = Math.floor((expiresAt - Date.now()) / 1000);
        // Blacklist access token in Redis
        if (ttl > 0) {
            try {
                await redisClient_1.default.set(`blacklist_${token}`, "true", { EX: ttl });
            }
            catch (err) {
                console.error("Redis set error when blacklisting token:", err);
            }
        }
        // Revoke refresh token from DB
        const refreshToken = req.cookies?.refreshToken;
        if (refreshToken) {
            const prisma = (0, container_1.getCorePrisma)();
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
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ message: "Server error" });
    }
};
exports.logoutUser = logoutUser;
// Login with email/password - returns access token and sets refresh token cookie
const loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res
                .status(400)
                .json({ message: "Email and password are required." });
        }
        const prisma = (0, container_1.getCorePrisma)();
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.password) {
            return res.status(400).json({ message: "Invalid credentials" });
        }
        const isMatch = await bcrypt_1.default.compare(password, user.password);
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
            await (0, mailerSend_1.sendAuthEmail)({
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
        await (0, orgCache_1.cacheUserOrgPointer)(user.id, user.orgId ?? null);
        if (user.orgId)
            await (0, orgCache_1.primeOrgSnapshot)(user.orgId);
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
    }
    catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({ message: "Server error" });
    }
};
exports.loginUser = loginUser;
// GET /api/auth/sessions
const listActiveSessions = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId)
            return res.status(401).json({ message: "Unauthorized" });
        const prisma = (0, container_1.getCorePrisma)();
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
    }
    catch (err) {
        console.error("List sessions error:", err);
        res.status(500).json({ message: "Server error" });
    }
};
exports.listActiveSessions = listActiveSessions;
// POST /api/auth/revoke-session/:sessionId
const revokeSession = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { sessionId } = req.params;
        if (!userId)
            return res.status(401).json({ message: "Unauthorized" });
        const prisma = (0, container_1.getCorePrisma)();
        const updated = await prisma.refreshToken.updateMany({
            where: { id: sessionId, userId },
            data: { revoked: true },
        });
        if (updated.count === 0)
            return res.status(404).json({ message: "Session not found" });
        return res.json({ message: "Session revoked" });
    }
    catch (err) {
        console.error("Revoke session error:", err);
        res.status(500).json({ message: "Server error" });
    }
};
exports.revokeSession = revokeSession;
