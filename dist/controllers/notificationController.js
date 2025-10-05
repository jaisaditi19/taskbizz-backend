"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listMyNotifications = listMyNotifications;
exports.markNotificationRead = markNotificationRead;
exports.markAllNotificationsRead = markAllNotificationsRead;
// import { getOrgPrismaClient } from "../utils/tenantUtils";
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
async function listMyNotifications(req, res) {
    try {
        //  console.log(req.user);
        // // Debug logging - remove after fixing
        // console.log("listMyNotifications - req.user:", {
        //   id: req.user?.id,
        //   orgId: req.user?.orgId,
        //   role: req.user?.role,
        // });
        // Check if user exists
        if (!req.user) {
            return res.status(401).json({ message: "Authentication required" });
        }
        // Check if user has orgId
        if (!req.user.orgId) {
            return res.status(400).json({
                message: "User must be associated with an organization to view notifications",
            });
        }
        const orgPrisma = await resolveOrgPrisma(req);
        const { unreadOnly, take = "30", cursor } = req.query;
        const where = { recipientId: req.user.id };
        if (String(unreadOnly) === "true")
            where.readAt = null;
        const notifications = await orgPrisma.notification.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: Math.min(parseInt(String(take)) || 30, 100),
            ...(cursor ? { cursor: { id: String(cursor) }, skip: 1 } : {}),
        });
        res.json({ notifications });
    }
    catch (e) {
        console.error("listMyNotifications Error:", e);
        res.status(500).json({ message: "Failed to fetch notifications" });
    }
}
async function markNotificationRead(req, res) {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Authentication required" });
        }
        if (!req.user.orgId) {
            return res.status(400).json({
                message: "User must be associated with an organization",
            });
        }
        const orgPrisma = await resolveOrgPrisma(req);
        const id = req.params.id;
        const n = await orgPrisma.notification.updateMany({
            where: { id, recipientId: req.user.id },
            data: { readAt: new Date() },
        });
        res.json({ ok: true, count: n.count });
    }
    catch (e) {
        console.error("markNotificationRead Error:", e);
        res.status(500).json({ message: "Failed to mark read" });
    }
}
async function markAllNotificationsRead(req, res) {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Authentication required" });
        }
        if (!req.user.orgId) {
            return res.status(400).json({
                message: "User must be associated with an organization",
            });
        }
        const orgPrisma = await resolveOrgPrisma(req);
        const n = await orgPrisma.notification.updateMany({
            where: { recipientId: req.user.id, readAt: null },
            data: { readAt: new Date() },
        });
        res.json({ ok: true, count: n.count });
    }
    catch (e) {
        console.error("markAllNotificationsRead Error:", e);
        res.status(500).json({ message: "Failed to mark all read" });
    }
}
