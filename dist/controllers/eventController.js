"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEvents = void 0;
const zod_1 = require("zod");
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
// Match your TaskStatus enum
const TaskStatusEnum = zod_1.z.enum([
    "OPEN",
    "IN_PROGRESS",
    "ON_TRACK",
    "DELAYED",
    "IN_TESTING",
    "ON_HOLD",
    "APPROVED",
    "CANCELLED",
    "PLANNING",
    "COMPLETED",
]);
const QuerySchema = zod_1.z.object({
    start: zod_1.z.string().min(1), // ISO
    end: zod_1.z.string().min(1), // ISO
    projectId: zod_1.z.string().optional(),
    assigneeId: zod_1.z.string().optional(),
    clientId: zod_1.z.string().optional(),
    // allow single or comma-separated list
    status: zod_1.z
        .union([TaskStatusEnum, zod_1.z.string().transform((s) => s.trim())])
        .optional(),
    // convenience flags
    isCompleted: zod_1.z.union([zod_1.z.literal("true"), zod_1.z.literal("false")]).optional(),
});
const getEvents = async (req, res) => {
    try {
        const parsed = QuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res
                .status(400)
                .json({ error: "Invalid query", details: parsed.error.flatten() });
        }
        const orgId = req.user?.orgId;
        if (!orgId)
            return res.status(400).json({ error: "Missing org context" });
        const prisma = await resolveOrgPrisma(req);
        const { start, end, projectId, assigneeId, clientId, status, isCompleted } = parsed.data;
        const rangeStart = new Date(start);
        const rangeEnd = new Date(end);
        // Support multi-status via comma-separated query: ?status=OPEN,IN_PROGRESS
        const statusList = typeof status === "string" && status.includes(",")
            ? status
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : status
                ? [status]
                : undefined;
        const occurrences = await prisma.taskOccurrence.findMany({
            where: {
                // time range overlap (half-open)
                startDate: { lt: rangeEnd },
                dueDate: { gt: rangeStart },
                ...(projectId ? { projectId } : {}),
                ...(assigneeId ? { assignedToId: assigneeId } : {}),
                ...(clientId ? { clientId } : {}),
                ...(statusList ? { status: { in: statusList } } : {}),
                ...(typeof isCompleted !== "undefined"
                    ? { isCompleted: isCompleted === "true" }
                    : {}),
            },
            select: {
                id: true,
                taskId: true,
                title: true,
                description: true,
                startDate: true,
                dueDate: true,
                assignedToId: true,
                priority: true,
                remarks: true,
                status: true,
                occurrenceIndex: true,
                isCompleted: true,
                clientId: true,
                projectId: true,
            },
            orderBy: [{ startDate: "asc" }, { dueDate: "asc" }],
        });
        const events = occurrences.map((o) => ({
            id: `occ:${o.id}`,
            title: o.title,
            start: o.startDate,
            end: o.dueDate,
            allDay: false, // set true if you add an allDay flag later
            meta: {
                taskId: o.taskId,
                occurrenceIndex: o.occurrenceIndex,
                projectId: o.projectId,
                clientId: o.clientId,
                assigneeId: o.assignedToId,
                priority: o.priority,
                status: o.status,
                isCompleted: o.isCompleted,
            },
        }));
        return res.json({ events });
    }
    catch (err) {
        console.error(err);
        return res
            .status(500)
            .json({ error: err?.message || "Failed to load calendar events" });
    }
};
exports.getEvents = getEvents;
