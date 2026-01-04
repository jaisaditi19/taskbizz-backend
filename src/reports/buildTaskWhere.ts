// src/reports/buildTaskWhere.ts
import { DateTime } from "luxon";
import { normalizeEnumFilter } from "./normalizeFilters";

export function buildTaskWhere(filters: any, user: any) {
  const AND: any[] = [];

  /* ---------- DATE WINDOW (same rules as listTaskOccurrences) ---------- */
  const hasStart = !!filters.start;
  const hasEnd = !!filters.end;

  let windowStart: Date;
  let windowEnd: Date;

  if (hasStart && hasEnd) {
    windowStart = DateTime.fromISO(filters.start).toUTC().toJSDate();
    windowEnd = DateTime.fromISO(filters.end).toUTC().toJSDate();
  } else {
    const now = DateTime.utc();
    windowStart = now.startOf("year").toJSDate();
    windowEnd = now.endOf("year").toJSDate();
  }

  AND.push({ startDate: { lte: windowEnd } });
  AND.push({ dueDate: { gte: windowStart } });

  /* ---------- STATUS ---------- */
  const statuses = normalizeEnumFilter(filters.status);
  if (statuses) {
    AND.push({ status: { in: statuses } });
  }

  /* ---------- PRIORITY ---------- */
  const priorities = normalizeEnumFilter(filters.priority);
  if (priorities) {
    AND.push({ priority: { in: priorities } });
  }

  /* ---------- ASSIGNEE ---------- */
  const assignees = normalizeEnumFilter(filters.assignedTo);
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
