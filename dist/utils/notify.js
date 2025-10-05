"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyUsers = notifyUsers;
exports.getAdminIds = getAdminIds;
exports.notifyCounterparties = notifyCounterparties;
/** Persist + broadcast a single notification payload to multiple recipients */
async function notifyUsers({ orgPrisma, io, orgId, recipients, payload, }) {
    if (!recipients.length) {
        if (process.env.NODE_ENV !== "production") {
            console.warn("[notify] No recipients for", payload?.type, payload);
        }
        return;
    }
    const rows = recipients.map((r) => ({
        recipientId: String(r),
        actorId: payload.actorId ?? null,
        type: payload.type,
        title: payload.title,
        body: payload.body,
        taskId: payload.taskId ?? null,
        occurrenceId: payload.occurrenceId ?? null,
    }));
    await orgPrisma.notification.createMany({ data: rows });
    // Emit minimal, client filters on recipientId
    rows.forEach((row) => {
        io.to(`org:${orgId}`).emit("notification:new", {
            orgId: String(orgId),
            notification: {
                recipientId: row.recipientId,
                actorId: row.actorId,
                type: row.type,
                title: row.title,
                body: row.body,
                taskId: row.taskId,
                occurrenceId: row.occurrenceId,
                createdAt: new Date().toISOString(),
            },
        });
    });
}
/** Get all ADMIN user ids for the org, excluding optional actor */
async function getAdminIds(corePrisma, orgId, excludeId) {
    const admins = await corePrisma.user.findMany({
        where: { orgId: String(orgId), role: "ADMIN", status: "ACTIVE" },
        select: { id: true },
    });
    const skip = excludeId ? String(excludeId) : null;
    return admins
        .map((u) => String(u.id))
        .filter((id) => (skip ? id !== skip : true));
}
/** Resolve project head (manager) from project/task/occurrence */
// notify.ts
async function getProjectHeadIds(orgPrisma, ids) {
    const pid = ids.projectId ? String(ids.projectId) : null;
    const tid = ids.taskId ? String(ids.taskId) : null;
    const oid = ids.occurrenceId ? String(ids.occurrenceId) : null;
    if (pid) {
        const p = await orgPrisma.project.findUnique({
            where: { id: pid },
            select: { head: true },
        });
        return p?.head ? [String(p.head)] : [];
    }
    if (tid) {
        const t = await orgPrisma.task.findUnique({
            where: { id: tid },
            select: { project: { select: { head: true } } },
        });
        return t?.project?.head ? [String(t.project.head)] : [];
    }
    if (oid) {
        const o = await orgPrisma.taskOccurrence.findUnique({
            where: { id: oid },
            select: { task: { select: { project: { select: { head: true } } } } },
        });
        return o?.task?.project?.head ? [String(o.task.project.head)] : [];
    }
    return [];
}
/**
 * Role-based notification routing for tasks/occurrences:
 *
 * - MANAGER actor: notify all *assignees* (exclude actor).
 * - ADMIN actor: notify *project head(s)* + all *assignees* (exclude actor).
 * - Other actors (EMPLOYEE): notify head(s); if nobody else qualifies -> fallback to ACTIVE admins (minus actor).
 *
 * Inputs:
 *  - Pass *at least one* of {taskId | occurrenceId | projectId} in payload so we can resolve the head.
 *  - Pass assignees via `assigneeIds` (array). `assignedToId` (single) is still supported for backward compatibility.
 */
/**
 * Role-based notification routing for tasks/occurrences:
 *
 * - EMPLOYEE actor: notify project head if exists, else fallback to ACTIVE admins
 * - MANAGER actor: notify all assignees (employees working on the task)
 * - ADMIN actor: notify project head + all assignees (exclude actor from all)
 */
async function notifyCounterparties({ orgPrisma, corePrisma, io, orgId, actor, assigneeIds, assignedToId, // legacy single-assignee support
payload, }) {
    const actorId = String(actor?.id || "");
    // Get project head
    const heads = await getProjectHeadIds(orgPrisma, {
        projectId: payload.projectId ?? null,
        taskId: payload.taskId ?? null,
        occurrenceId: payload.occurrenceId ?? null,
    });
    // Normalize assignees (support single or multiple)
    const assignees = new Set();
    if (Array.isArray(assigneeIds)) {
        assigneeIds.forEach((id) => id && assignees.add(String(id)));
    }
    if (assignedToId)
        assignees.add(String(assignedToId));
    const recipients = new Set();
    // 🔴 EMPLOYEE updates → notify project head, else admins
    if (actor?.role === "EMPLOYEE" || !actor?.role) {
        // Notify project head if exists
        if (heads.length > 0) {
            heads.forEach((headId) => {
                if (headId !== actorId)
                    recipients.add(headId);
            });
        }
        else {
            // No project head → fallback to admins
            const admins = await getAdminIds(corePrisma, String(orgId), actorId);
            admins.forEach((id) => recipients.add(String(id)));
        }
    }
    // 🔴 MANAGER updates → notify all assignees (employees)
    else if (actor?.role === "MANAGER") {
        assignees.forEach((id) => {
            if (id !== actorId)
                recipients.add(id);
        });
        // If no assignees, at least notify admins (fallback)
        if (recipients.size === 0) {
            const admins = await getAdminIds(corePrisma, String(orgId), actorId);
            admins.forEach((id) => recipients.add(String(id)));
        }
    }
    // 🔴 ADMIN updates → notify project head + all assignees
    else if (actor?.role === "ADMIN") {
        // Notify project head
        heads.forEach((id) => {
            if (id !== actorId)
                recipients.add(id);
        });
        // Notify all assignees
        assignees.forEach((id) => {
            if (id !== actorId)
                recipients.add(id);
        });
    }
    // Last-chance fallback: if still empty, notify admins
    if (recipients.size === 0) {
        const admins = await getAdminIds(corePrisma, String(orgId), actorId);
        admins.forEach((id) => recipients.add(String(id)));
    }
    const finalRecipients = Array.from(recipients);
    if (process.env.NODE_ENV !== "production") {
        console.log("[notify] event", payload.type, {
            orgId: String(orgId),
            taskId: payload.taskId ?? null,
            occurrenceId: payload.occurrenceId ?? null,
            projectId: payload.projectId ?? null,
            actorId,
            actorRole: actor?.role,
            heads,
            assignees: Array.from(assignees),
            finalRecipients,
        });
    }
    if (finalRecipients.length === 0) {
        console.warn("[notify] No recipients found after all fallbacks");
        return;
    }
    await notifyUsers({
        orgPrisma,
        io,
        orgId: String(orgId),
        recipients: finalRecipients,
        payload: { ...payload, actorId },
    });
}
