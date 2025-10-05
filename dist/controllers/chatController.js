"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertDirectoryUser = exports.markMessageRead = exports.sendMessage = exports.listMessages = exports.createConversation = exports.listConversations = void 0;
exports.attachChatIO = attachChatIO;
const coreClient_1 = require("../prisma/coreClient");
const container_1 = require("../di/container");
/**
 * Helper: resolve org prisma from req.orgPrisma (set by middleware) or container factory.
 * Throws when orgId missing.
 */
async function resolveOrgPrisma(req) {
    const maybe = req.orgPrisma;
    if (maybe)
        return maybe;
    const orgId = req.user?.orgId;
    if (!orgId)
        throw new Error("Org ID required");
    return await (0, container_1.getOrgPrisma)(orgId);
}
// If you want to emit Socket.IO events from controllers, pass the io instance in your route factory.
// Global IO reference
let ioRef = null;
function attachChatIO(io) {
    ioRef = io;
}
// Helpers
function assertBodyHasOneOf(body, attachments) {
    return !!(body && body.trim().length) || !!(attachments && attachments.length);
}
// ────────────────────────────────────────────────────────────────────────────────
// Conversations
// ────────────────────────────────────────────────────────────────────────────────
// GET /chat/conversations
const listConversations = async (req, res) => {
    try {
        const { id: userId, orgId } = req.user ?? {};
        const prisma = await resolveOrgPrisma(req);
        const limit = Math.min(Number(req.query.limit ?? 50), 100);
        const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
        const conversations = await prisma.conversation.findMany({
            where: { members: { some: { userId } } },
            orderBy: { updatedAt: "desc" },
            take: limit,
            skip: cursor ? 1 : 0,
            cursor: cursor ? { id: cursor } : undefined,
            include: {
                members: {
                    include: {
                        user: {
                            select: {
                                userId: true,
                                name: true,
                                avatarUrl: true,
                                lastActiveAt: true,
                            },
                        },
                    },
                },
                messages: {
                    take: 1,
                    orderBy: { createdAt: "desc" }, // last message preview
                    include: {
                        sender: {
                            select: {
                                userId: true,
                                name: true,
                                avatarUrl: true,
                            },
                        },
                    },
                },
            },
        });
        res.json({ conversations });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch conversations" });
    }
};
exports.listConversations = listConversations;
// import { corePrisma } from "../prisma/coreClient"; // <-- import your core DB client
const createConversation = async (req, res) => {
    try {
        const { id: userId, orgId } = req.user ?? {};
        const orgPrisma = await resolveOrgPrisma(req);
        const { isGroup = false, title, memberIds } = req.body || {};
        if (!Array.isArray(memberIds) || memberIds.length === 0) {
            return res
                .status(400)
                .json({ error: "memberIds is required (non-empty array)" });
        }
        const distinctMemberIds = Array.from(new Set([...memberIds, userId]));
        // ✅ Prevent duplicate 1-to-1 chats
        if (!isGroup && distinctMemberIds.length === 2) {
            const existing = await orgPrisma.conversation.findFirst({
                where: {
                    isGroup: false,
                    members: {
                        every: { userId: { in: distinctMemberIds } }, // both must be in
                        some: { userId: { in: distinctMemberIds } }, // at least one
                    },
                },
                include: {
                    members: {
                        include: {
                            user: { select: { userId: true, name: true, avatarUrl: true, lastActiveAt: true } },
                        },
                    },
                    messages: {
                        take: 1,
                        orderBy: { createdAt: "desc" },
                        include: {
                            sender: { select: { userId: true, name: true, avatarUrl: true } },
                        },
                    },
                },
            });
            if (existing) {
                return res.status(200).json({ conversation: existing, existing: true });
            }
        }
        // ✅ Fetch user info from core DB
        const coreUsers = await coreClient_1.prisma.user.findMany({
            where: { id: { in: distinctMemberIds } },
            select: { id: true, name: true },
        });
        const userMap = new Map(coreUsers.map((u) => [u.id, u]));
        // ✅ Ensure all users exist in DirectoryUser
        await Promise.all(distinctMemberIds.map((uid) => {
            const info = userMap.get(uid);
            return orgPrisma.directoryUser.upsert({
                where: { userId: uid },
                create: {
                    userId: uid,
                    name: info?.name || "Unknown",
                    avatarUrl: info?.avatarUrl || null,
                },
                update: {
                    name: info?.name || "Unknown",
                    avatarUrl: info?.avatarUrl || null,
                    updatedAt: new Date(),
                },
            });
        }));
        // ✅ Create conversation
        const conversation = await orgPrisma.conversation.create({
            data: {
                isGroup,
                title: title ?? null,
                createdById: userId,
                members: { create: distinctMemberIds.map((uid) => ({ userId: uid })) },
            },
            include: {
                members: {
                    include: {
                        user: {
                            select: {
                                userId: true,
                                name: true,
                                avatarUrl: true,
                                lastActiveAt: true,
                            },
                        },
                    },
                },
                messages: {
                    take: 1,
                    orderBy: { createdAt: "desc" },
                    include: {
                        sender: { select: { userId: true, name: true, avatarUrl: true } },
                    },
                },
            },
        });
        // 🔔 Notify all members
        const io = ioRef || req.io;
        if (io) {
            distinctMemberIds.forEach((uid) => {
                io.to(`user:${uid}`).emit("chat:conversation-created", {
                    conversation,
                    shouldJoin: true,
                });
            });
            if (orgId) {
                io.to(`org:${orgId}`).emit("chat:conversation-created", {
                    conversation,
                });
            }
        }
        res.status(201).json({ conversation, existing: false });
    }
    catch (error) {
        console.error("createConversation error", error);
        res.status(500).json({ error: "Failed to create conversation" });
    }
};
exports.createConversation = createConversation;
// ────────────────────────────────────────────────────────────────────────────────
// Messages
// ────────────────────────────────────────────────────────────────────────────────
async function ensureMember(prisma, conversationId, userId) {
    const m = await prisma.conversationMember.findFirst({
        where: { conversationId, userId },
        select: { id: true },
    });
    if (!m) {
        const err = new Error("Forbidden: not a member");
        err.status = 403;
        throw err;
    }
}
// GET /chat/conversations/:id/messages?before=ISO&limit=50
const listMessages = async (req, res) => {
    try {
        const { id: userId, orgId } = req.user ?? {};
        const prisma = await resolveOrgPrisma(req);
        const conversationId = req.params.id;
        await ensureMember(prisma, conversationId, userId);
        const limit = Math.min(Number(req.query.limit ?? 50), 100);
        const beforeRaw = typeof req.query.before === "string" ? req.query.before : undefined;
        const before = beforeRaw ? new Date(beforeRaw) : undefined;
        const messages = await prisma.message.findMany({
            where: {
                conversationId,
                createdAt: before ? { lt: before } : undefined,
            },
            orderBy: { createdAt: "desc" },
            take: limit,
            include: {
                reads: true,
                sender: {
                    select: {
                        userId: true,
                        name: true,
                        avatarUrl: true,
                    },
                },
            },
        });
        res.json({ messages });
    }
    catch (error) {
        console.error(error);
        const code = error?.status || 500;
        res
            .status(code)
            .json({ error: error?.message || "Failed to fetch messages" });
    }
};
exports.listMessages = listMessages;
// --- sendMessage: emit to room + ALSO each member's user room as a fallback ---
const sendMessage = async (req, res) => {
    try {
        const { id: userId, orgId } = req.user ?? {};
        const prisma = await resolveOrgPrisma(req);
        const conversationId = req.params.id;
        const senderMember = await prisma.conversationMember.findFirst({
            where: { conversationId, userId },
            select: { id: true },
        });
        if (!senderMember)
            return res.status(403).json({ error: "Forbidden: not a member" });
        const { body, attachments } = req.body || {};
        if (!((body && body.trim()) || (attachments && attachments.length))) {
            return res
                .status(400)
                .json({ error: "Message must have body or attachments" });
        }
        const message = await prisma.message.create({
            data: {
                conversationId,
                senderId: userId,
                body: body ?? null,
                attachments: attachments ?? null,
            },
            include: {
                reads: true,
                sender: {
                    select: {
                        userId: true,
                        name: true,
                        avatarUrl: true,
                    },
                },
            },
        });
        await prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
        });
        const members = await prisma.conversationMember.findMany({
            where: { conversationId },
            select: { userId: true },
        });
        const memberUserIds = members.map((m) => m.userId);
        const io = ioRef || req.io;
        if (io) {
            io.to(`conv:${conversationId}`).emit("chat:new", {
                message,
                conversationId,
            });
            memberUserIds.forEach((uid) => {
                io.to(`user:${uid}`).emit("chat:new", {
                    message,
                    conversationId,
                    fallback: true,
                });
            });
        }
        res.status(201).json({ message });
    }
    catch (error) {
        console.error("sendMessage error", error);
        res
            .status(error?.status || 500)
            .json({ error: error?.message || "Failed to send message" });
    }
};
exports.sendMessage = sendMessage;
// POST /chat/messages/:id/read
const markMessageRead = async (req, res) => {
    try {
        const { id: userId, orgId } = req.user ?? {};
        const prisma = await resolveOrgPrisma(req);
        const messageId = req.params.id;
        // find conv
        const msg = await prisma.message.findUnique({
            where: { id: messageId },
            select: { conversationId: true },
        });
        if (!msg)
            return res.status(404).json({ error: "Message not found" });
        await ensureMember(prisma, msg.conversationId, userId);
        // upsert read
        await prisma.messageRead.upsert({
            where: { messageId_userId: { messageId, userId } },
            create: { messageId, userId },
            update: { readAt: new Date() },
        });
        ioRef?.to(`conv:${msg.conversationId}`).emit("chat:reads", {
            conversationId: msg.conversationId,
            userId,
            messageIds: [messageId],
        });
        res.json({ ok: true });
    }
    catch (error) {
        console.error(error);
        const code = error?.status || 500;
        res.status(code).json({ error: error?.message || "Failed to mark read" });
    }
};
exports.markMessageRead = markMessageRead;
// ────────────────────────────────────────────────────────────────────────────────
// Directory cache (core → tenant)
// ────────────────────────────────────────────────────────────────────────────────
// POST /chat/directory/user-upsert   body: { userId, name, avatarUrl? }
const upsertDirectoryUser = async (req, res) => {
    try {
        // Secure this route (internal secret/mTLS). orgId can be passed explicitly or derived.
        const { orgId, userId, name, avatarUrl } = req.body || {};
        if (!orgId || !userId || !name) {
            return res.status(400).json({ error: "orgId, userId, name are required" });
        }
        const prisma = await resolveOrgPrisma(req);
        const user = await prisma.directoryUser.upsert({
            where: { userId: String(userId) },
            create: { userId: String(userId), name: String(name), avatarUrl: avatarUrl ? String(avatarUrl) : null },
            update: { name: String(name), avatarUrl: avatarUrl ? String(avatarUrl) : null, updatedAt: new Date() },
        });
        res.json({ user });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to upsert directory user" });
    }
};
exports.upsertDirectoryUser = upsertDirectoryUser;
