"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTaskWhere = buildTaskWhere;
// src/reports/buildTaskWhere.ts
const luxon_1 = require("luxon");
const normalizeFilters_1 = require("./normalizeFilters");
function buildTaskWhere(filters, user) {
    const AND = [];
    /* ---------- DATE WINDOW (same rules as listTaskOccurrences) ---------- */
    const hasStart = !!filters.start;
    const hasEnd = !!filters.end;
    let windowStart;
    let windowEnd;
    if (hasStart && hasEnd) {
        windowStart = luxon_1.DateTime.fromISO(filters.start).toUTC().toJSDate();
        windowEnd = luxon_1.DateTime.fromISO(filters.end).toUTC().toJSDate();
    }
    else {
        const now = luxon_1.DateTime.utc();
        windowStart = now.startOf("year").toJSDate();
        windowEnd = now.endOf("year").toJSDate();
    }
    AND.push({ startDate: { lte: windowEnd } });
    AND.push({ dueDate: { gte: windowStart } });
    /* ---------- STATUS ---------- */
    const statuses = (0, normalizeFilters_1.normalizeEnumFilter)(filters.status);
    if (statuses) {
        AND.push({ status: { in: statuses } });
    }
    /* ---------- PRIORITY ---------- */
    const priorities = (0, normalizeFilters_1.normalizeEnumFilter)(filters.priority);
    if (priorities) {
        AND.push({ priority: { in: priorities } });
    }
    /* ---------- ASSIGNEE ---------- */
    const assignees = (0, normalizeFilters_1.normalizeEnumFilter)(filters.assignedTo);
    if (assignees) {
        AND.push({
            OR: [
                { assignedToId: { in: assignees } },
                { assignees: { some: { userId: { in: assignees } } } },
                { task: { assignees: { some: { userId: { in: assignees } } } } },
            ],
        });
    }
    /* ---------- PROJECT / MANAGER ---------- */
    if (filters.managerId) {
        AND.push({ task: { project: { head: filters.managerId } } });
    }
    if (Array.isArray(filters.projectId) && filters.projectId.length) {
        AND.push({
            OR: [
                { projectId: { in: filters.projectId } },
                { task: { projectId: { in: filters.projectId } } },
            ],
        });
    }
    /* ---------- SEARCH ---------- */
    if (filters.q) {
        AND.push({
            OR: [
                { title: { contains: filters.q, mode: "insensitive" } },
                { remarks: { contains: filters.q, mode: "insensitive" } },
                { task: { title: { contains: filters.q, mode: "insensitive" } } },
            ],
        });
    }
    /* ---------- ROLE SAFETY ---------- */
    if (user.role === "MANAGER") {
        AND.push({ task: { project: { head: user.id } } });
    }
    return { AND };
}
