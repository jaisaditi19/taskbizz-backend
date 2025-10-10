// src/realtime/socket.ts
import type http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import redisClient from "../config/redisClient";
import { getOrgPrismaClient } from "../utils/tenantUtils";
import { prisma as corePrisma } from "../prisma/coreClient";

type JwtPayload = {
  id: string;
  role: "ADMIN" | "EMPLOYEE";
  orgId: string | null;
  exp: number;
};

async function isBlacklisted(token: string) {
  return (await redisClient.get(`blacklist_${token}`)) === "true";
}

export function attachSocket(server: http.Server) {
  const allowed = (
    process.env.WEB_ORIGIN ??
    "https://portal.taskbizz.com,http://localhost:5173"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const io = new Server(server, {
    cors: {
      origin: allowed.length ? allowed : "*",
      credentials: true,
    },
    transports: ["websocket", "polling"],
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.engine.on("connection_error", (err: any) => {
    console.error("[socket] connection_error:", {
      message: err.message,
      code: err.code,
      context: err.context,
    });
  });

  // ─────────────── JWT handshake ───────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        console.warn("[socket:handshake] token missing, rejecting socket");
        return next(new Error("Unauthorized"));
      }

      if (await isBlacklisted(token)) {
        console.warn("[socket:handshake] token blacklisted, rejecting socket");
        return next(new Error("Unauthorized"));
      }

      const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
      (socket.data as any).user = payload;

      if (payload.id) socket.join(`user:${payload.id}`);
      if (payload.orgId) socket.join(`org:${payload.orgId}`);

      if (payload.orgId) {
        await redisClient.sAdd(`presence:${payload.orgId}`, payload.id);
        io.to(`org:${payload.orgId}`).emit("presence:update", {
          userId: payload.id,
          online: true,
        });
      }

      next();
    } catch (e) {
      console.warn("[socket:handshake] verification failed", e);
      next(new Error("Unauthorized"));
    }
  });

  // ─────────────── Socket events ───────────────
  io.on("connection", (socket) => {
    const user = (socket.data as any).user as JwtPayload | undefined;

    // Join/leave
    socket.on("chat:join", (payload: any) => {
      const ids: unknown = payload?.conversationIds;
      if (!Array.isArray(ids)) return;
      for (const id of ids) {
        if (typeof id === "string" && id) {
          socket.join(`conv:${id}`);
        }
      }
    });

    socket.on("chat:leave", (payload: any) => {
      const ids: unknown = payload?.conversationIds;
      if (!Array.isArray(ids)) return;
      for (const id of ids) {
        if (typeof id === "string" && id) socket.leave(`conv:${id}`);
      }
    });

    // Typing
    socket.on("chat:typing", (payload: any) => {
      const conversationId: unknown = payload?.conversationId;
      if (!conversationId || typeof conversationId !== "string") return;
      socket.to(`conv:${conversationId}`).emit("chat:typing", {
        conversationId,
        userId: user?.id,
      });
    });

    // Verify join
    socket.on("chat:verify-rooms", (payload: any) => {
      const ids: unknown = payload?.conversationIds;
      if (!Array.isArray(ids)) return;

      for (const id of ids) {
        if (typeof id === "string" && id) {
          const joined = socket.rooms.has(`conv:${id}`);
          socket.emit("chat:room-status", { conversationId: id, joined });
        }
      }
    });

    // ─────────────── Delivery receipts ───────────────
    // socket.ts
    socket.on(
      "chat:delivered",
      async ({ messageId, conversationId, senderId }) => {
        if (!user?.id || user.id === senderId) return;

        // 🔔 Tell sender "your message is delivered"
        io.to(`user:${senderId}`).emit("chat:delivered", { messageId });

        // Optionally also broadcast inside conv room for debugging
        socket
          .to(`conv:${conversationId}`)
          .emit("chat:delivered", { messageId });
      }
    );

    // ─────────────── Presence ───────────────
    socket.on("presence:ping", async () => {
      if (user?.orgId && user?.id) {
        await redisClient.sAdd(`presence:${user.orgId}`, user.id);
        const orgPrisma = await getOrgPrismaClient(user.orgId);

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
        await redisClient.sRem(`presence:${user.orgId}`, user.id);
        const prisma = await getOrgPrismaClient(user.orgId);

        try {
          // Get user data first (we need it for potential create)
          const userData = await corePrisma.user.findUnique({
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
        } catch (error) {
          console.error(
            `Failed to update directoryUser for ${user.id}:`,
            error
          );
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
export function emitToOrg(
  io: Server,
  orgId: string,
  event: string,
  payload: any
) {
  io.to(`org:${orgId}`).emit(event, payload);
}
export function emitToUser(
  io: Server,
  userId: string,
  event: string,
  payload: any
) {
  io.to(`user:${userId}`).emit(event, payload);
}
