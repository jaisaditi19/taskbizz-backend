"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachSocket = attachSocket;
exports.emitToOrg = emitToOrg;
exports.emitToUser = emitToUser;
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const redisClient_1 = __importDefault(require("../config/redisClient"));
const tenantUtils_1 = require("../utils/tenantUtils");
const coreClient_1 = require("../prisma/coreClient");
async function isBlacklisted(token) {
    return (await redisClient_1.default.get(`blacklist_${token}`)) === "true";
}
function attachSocket(server) {
    const allowed = (process.env.WEB_ORIGIN ??
        "https://portal.taskbizz.com,http://localhost:5173")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    // when creating io
    const io = new socket_io_1.Server(server, {
        path: "/api/socket.io", // ✅ add this
        cors: {
            origin: allowed.length ? allowed : "*",
            credentials: true,
        },
        transports: ["websocket", "polling"],
        pingInterval: 25000,
        pingTimeout: 20000,
    });
    io.engine.on("connection_error", (err) => {
        console.error("[socket] connection_error:", {
            message: err.message,
            code: err.code,
            context: err.context,
        });
    });
    // ─────────────── JWT handshake ───────────────
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token) {
                console.warn("[socket:handshake] token missing, rejecting socket");
                return next(new Error("Unauthorized"));
            }
            if (await isBlacklisted(token)) {
                console.warn("[socket:handshake] token blacklisted, rejecting socket");
                return next(new Error("Unauthorized"));
            }
            const payload = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
            socket.data.user = payload;
            if (payload.id)
                socket.join(`user:${payload.id}`);
            if (payload.orgId)
                socket.join(`org:${payload.orgId}`);
            if (payload.orgId) {
                await redisClient_1.default.sAdd(`presence:${payload.orgId}`, payload.id);
                io.to(`org:${payload.orgId}`).emit("presence:update", {
                    userId: payload.id,
                    online: true,
                });
            }
            next();
        }
        catch (e) {
            console.warn("[socket:handshake] verification failed", e);
            next(new Error("Unauthorized"));
        }
    });
    // ─────────────── Socket events ───────────────
    io.on("connection", (socket) => {
        const user = socket.data.user;
        // Join/leave
        socket.on("chat:join", (payload) => {
            const ids = payload?.conversationIds;
            if (!Array.isArray(ids))
                return;
            for (const id of ids) {
                if (typeof id === "string" && id) {
                    socket.join(`conv:${id}`);
                }
            }
        });
        socket.on("chat:leave", (payload) => {
            const ids = payload?.conversationIds;
            if (!Array.isArray(ids))
                return;
            for (const id of ids) {
                if (typeof id === "string" && id)
                    socket.leave(`conv:${id}`);
            }
        });
        // Typing
        socket.on("chat:typing", (payload) => {
            const conversationId = payload?.conversationId;
            if (!conversationId || typeof conversationId !== "string")
                return;
            socket.to(`conv:${conversationId}`).emit("chat:typing", {
                conversationId,
                userId: user?.id,
            });
        });
        // Verify join
        socket.on("chat:verify-rooms", (payload) => {
            const ids = payload?.conversationIds;
            if (!Array.isArray(ids))
                return;
            for (const id of ids) {
                if (typeof id === "string" && id) {
                    const joined = socket.rooms.has(`conv:${id}`);
                    socket.emit("chat:room-status", { conversationId: id, joined });
                }
            }
        });
        // ─────────────── Delivery receipts ───────────────
        // socket.ts
        socket.on("chat:delivered", async ({ messageId, conversationId, senderId }) => {
            if (!user?.id || user.id === senderId)
                return;
            // 🔔 Tell sender "your message is delivered"
            io.to(`user:${senderId}`).emit("chat:delivered", { messageId });
            // Optionally also broadcast inside conv room for debugging
            socket
                .to(`conv:${conversationId}`)
                .emit("chat:delivered", { messageId });
        });
        // ─────────────── Presence ───────────────
        socket.on("presence:ping", async () => {
            if (user?.orgId && user?.id) {
                await redisClient_1.default.sAdd(`presence:${user.orgId}`, user.id);
                const orgPrisma = await (0, tenantUtils_1.getOrgPrismaClient)(user.orgId);
                // await orgPrisma.directoryUser.updateMany({
                //   where: { userId: user.id },
                //   data: { lastActiveAt: new Date() },
                // });
                io.to(`org:${user.orgId}`).emit("presence:update", {
                    userId: user.id,
                    online: true,
                    lastActiveAt: new Date().toISOString(),
                });
            }
        });
        socket.on("disconnect", async () => {
            if (user?.orgId && user?.id) {
                const now = new Date().toISOString();
                await redisClient_1.default.sRem(`presence:${user.orgId}`, user.id);
                const prisma = await (0, tenantUtils_1.getOrgPrismaClient)(user.orgId);
                try {
                    // Get user data first (we need it for potential create)
                    const userData = await coreClient_1.prisma.user.findUnique({
                        where: { id: user.id },
                        select: { name: true, email: true }, // adjust based on your User model
                    });
                    if (userData) {
                        // Use upsert to handle both update and create atomically
                        await prisma.directoryUser.upsert({
                            where: { userId: user.id },
                            update: {
                                lastActiveAt: now,
                            },
                            create: {
                                userId: user.id,
                                lastActiveAt: now,
                                name: userData.name,
                                // Add other required fields based on your directoryUser model
                                // email: userData.email, // uncomment if email is required
                            },
                        });
                    }
                }
                catch (error) {
                    console.error(`Failed to update directoryUser for ${user.id}:`, error);
                    // Don't throw - we don't want to break the disconnect flow
                }
                io.to(`org:${user.orgId}`).emit("presence:update", {
                    userId: user.id,
                    online: false,
                    lastActiveAt: now,
                });
            }
        });
    });
    return io;
}
// helpers
function emitToOrg(io, orgId, event, payload) {
    io.to(`org:${orgId}`).emit(event, payload);
}
function emitToUser(io, userId, event, payload) {
    io.to(`user:${userId}`).emit(event, payload);
}
