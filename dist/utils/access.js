"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAdmin = isAdmin;
exports.isManager = isManager;
exports.resolveProjectId = resolveProjectId;
exports.assertManageScopeOrThrow = assertManageScopeOrThrow;
const container_1 = require("../di/container");
function isAdmin(user) {
    return user?.role === "ADMIN";
}
function isManager(user) {
    return user?.role === "MANAGER";
}
/** Resolve projectId from any of: projectId | taskId | occurrenceId */
async function resolveProjectId({ orgPrisma, projectId, taskId, occurrenceId, }) {
    if (projectId)
        return String(projectId);
    if (taskId) {
        const t = await orgPrisma.task.findUnique({
            where: { id: String(taskId) },
            select: { projectId: true },
        });
        if (t?.projectId)
            return t.projectId;
    }
    if (occurrenceId) {
        const occ = await orgPrisma.taskOccurrence.findUnique({
            where: { id: String(occurrenceId) },
            select: { task: { select: { projectId: true } } },
        });
        if (occ?.task?.projectId)
            return occ.task.projectId;
    }
    return null;
}
/** Throw 403 if MANAGER and not head of the project. ADMIN passes. */
async function assertManageScopeOrThrow(req, projectId) {
    const user = req.currentUser ?? req.user;
    if (!user) {
        const err = new Error("Unauthorized");
        err.status = 401;
        throw err;
    }
    if (isAdmin(user))
        return;
    if (isManager(user)) {
        const orgPrisma = await (0, container_1.getOrgPrisma)(user.orgId);
        const project = await orgPrisma.project.findUnique({
            where: { id: projectId },
            select: { head: true },
        });
        if (!project) {
            const err = new Error("Project not found");
            err.status = 404;
            throw err;
        }
        if (project.head !== user.id) {
            const err = new Error("Forbidden: not project head");
            err.status = 403;
            throw err;
        }
        return;
    }
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
}
