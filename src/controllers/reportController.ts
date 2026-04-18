import { Request, Response } from "express";
import { getCorePrisma, getOrgPrisma } from "../di/container";
import * as XLSX from "xlsx";

type EmployeeRow = {
  id: string;
  name: string;
  departmentId: string | null;
  department: {
    id: string;
    name: string;
  } | null;
};

export const getEmployeeSummaryReport = async (
  req: Request & { user?: any },
  res: Response,
) => {
  const corePrisma = getCorePrisma();

  if (
    !req.user?.orgId ||
    (req.user.role !== "ADMIN" && req.user.role !== "MANAGER")
  ) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { start: startStr, end: endStr } = req.query as {
    start?: string;
    end?: string;
  };

  try {
    const orgPrisma = await getOrgPrisma(req.user.orgId);
    if (!orgPrisma) {
      return res.status(500).json({ message: "Org database unavailable" });
    }

    /* ---------------- DATE NORMALIZATION ---------------- */

    const toDateSafe = (v?: string | Date) => {
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };

    const startAt = toDateSafe(startStr);
    const endAt = toDateSafe(endStr);

    if (startAt) startAt.setHours(0, 0, 0, 0);
    if (endAt) endAt.setHours(23, 59, 59, 999);

    if (startAt && endAt && startAt > endAt) {
      return res.status(400).json({ message: "Invalid date range" });
    }

    const now = new Date();
    const startOfDay = (d: Date) => {
      const c = new Date(d);
      c.setHours(0, 0, 0, 0);
      return c;
    };

    /* ---------------- EMPLOYEES ---------------- */

    const employees: EmployeeRow[] = await corePrisma.user.findMany({
      where: { orgId: req.user.orgId },
      select: {
        id: true,
        name: true,
        departmentId: true,
        department: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    /* ---------------- TASK OCCURRENCES (MATCH DASHBOARD) ---------------- */

    const rawOccurrences = await orgPrisma.taskOccurrence.findMany({
      where:
        startAt && endAt
          ? {
              OR: [
                { startDate: { gte: startAt, lte: endAt } },
                { dueDate: { gte: startAt, lte: endAt } },
              ],
            }
          : {},
      select: {
        startDate: true,
        dueDate: true,
        completedAt: true,
        updatedAt: true,
        status: true,
        isCompleted: true,
        assignedToId: true,
        task: { select: { status: true } },
      },
    });

    /* ---------------- FILTER CANCELLED ---------------- */

    const occurrences = rawOccurrences.filter((o) => {
      const occStatus = (o.status || "").toUpperCase();
      const taskStatus = (o.task?.status || "").toUpperCase();
      return occStatus !== "CANCELLED" && taskStatus !== "CANCELLED";
    });

    /* ---------------- INIT SUMMARY MAP ---------------- */

    const summaryMap = new Map<
      string,
      {
        userId: string;
        name: string;
        departmentId: string | null;
        departmentName: string | null;
        assigned: number;
        completed: number;
        overdue: number;
        open: number;
      }
    >();

    for (const e of employees) {
      summaryMap.set(e.id, {
        userId: e.id,
        name: e.name,
        departmentId: e.departmentId ?? null,
        departmentName: e.department?.name ?? null,
        assigned: 0,
        completed: 0,
        overdue: 0,
        open: 0,
      });
    }

    /* ---------------- HELPERS ---------------- */

    const isTaskCompleted = (t: any) =>
      t.isCompleted === true || (t.status || "").toUpperCase() === "COMPLETED";

    const isOverdue = (t: any) => {
      const due = toDateSafe(t.dueDate);
      if (!due) return false;
      if (isTaskCompleted(t)) return false;
      return startOfDay(due).getTime() < startOfDay(now).getTime();
    };

    /* ---------------- AGGREGATION ---------------- */

    for (const o of occurrences) {
      if (!o.assignedToId) continue;

      const row = summaryMap.get(o.assignedToId);
      if (!row) continue;

      row.assigned += 1;

      if (isTaskCompleted(o)) {
        row.completed += 1;
        continue;
      }

      if (isOverdue(o)) {
        row.overdue += 1;
      } else {
        row.open += 1;
      }
    }

    /* ---------------- FINAL ROWS ---------------- */

    const rows = Array.from(summaryMap.values()).map((r) => ({
      userId: r.userId,
      name: r.name,
      departmentId: r.departmentId,
      departmentName: r.departmentName,
      assigned: r.assigned,
      completed: r.completed,
      overdue: r.overdue,
      open: r.open,
      completionRate:
        r.assigned > 0 ? Math.round((r.completed / r.assigned) * 100) : 0,
    }));

    /* ---------------- AVERAGE COMPLETION (FIX) ---------------- */

    // exclude users with 0 assigned tasks
    const activeUsers = rows.filter((u) => u.assigned > 0);

    // simple average (per-user)
    const averageCompletionRate =
      activeUsers.length > 0
        ? Math.round(
            activeUsers.reduce((sum, u) => sum + u.completionRate, 0) /
              activeUsers.length,
          )
        : 0;

    // weighted average (recommended)
    const totalAssigned = activeUsers.reduce((s, u) => s + u.assigned, 0);
    const totalCompleted = activeUsers.reduce((s, u) => s + u.completed, 0);

    const weightedAverageCompletionRate =
      totalAssigned > 0
        ? Math.round((totalCompleted / totalAssigned) * 100)
        : 0;

    /* ---------------- RESPONSE ---------------- */

    return res.json({
      data: rows,
      stats: {
        averageCompletionRate,
        weightedAverageCompletionRate,
      },
    });
  } catch (err: any) {
    console.error("Employee summary report error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

const buildEmployeeSummary = async (
  orgId: string,
  startAt?: Date,
  endAt?: Date,
) => {
  const corePrisma = getCorePrisma();
  const orgPrisma = await getOrgPrisma(orgId);

  if (!orgPrisma) throw new Error("Org DB unavailable");

  const now = new Date();

  const startOfDay = (d: Date) => {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
  };

  const employees = await corePrisma.user.findMany({
    where: { orgId },
    select: {
      id: true,
      name: true,
      departmentId: true,
      department: { select: { id: true, name: true } },
    },
  });

  const rawOccurrences = await orgPrisma.taskOccurrence.findMany({
    where:
      startAt && endAt
        ? {
            OR: [
              { startDate: { gte: startAt, lte: endAt } },
              { dueDate: { gte: startAt, lte: endAt } },
            ],
          }
        : {},
    select: {
      startDate: true,
      dueDate: true,
      status: true,
      isCompleted: true,
      assignedToId: true,
      task: { select: { status: true } },
    },
  });

  const occurrences = rawOccurrences.filter((o) => {
    const occStatus = (o.status || "").toUpperCase();
    const taskStatus = (o.task?.status || "").toUpperCase();
    return occStatus !== "CANCELLED" && taskStatus !== "CANCELLED";
  });

  const map = new Map();

  for (const e of employees) {
    map.set(e.id, {
      userId: e.id,
      name: e.name,
      departmentId: e.departmentId ?? null,
      departmentName: e.department?.name ?? null,
      assigned: 0,
      completed: 0,
      overdue: 0,
      open: 0,
    });
  }

  const isCompleted = (t: any) =>
    t.isCompleted || (t.status || "").toUpperCase() === "COMPLETED";

  const isOverdue = (t: any) => {
    if (isCompleted(t)) return false;
    if (!t.dueDate) return false;
    return startOfDay(new Date(t.dueDate)) < startOfDay(now);
  };

  for (const o of occurrences) {
    if (!o.assignedToId) continue;

    const row = map.get(o.assignedToId);
    if (!row) continue;

    row.assigned++;

    if (isCompleted(o)) row.completed++;
    else if (isOverdue(o)) row.overdue++;
    else row.open++;
  }

  return Array.from(map.values()).map((r) => ({
    ...r,
    completionRate:
      r.assigned > 0 ? Math.round((r.completed / r.assigned) * 100) : 0,
  }));
};

export const exportEmployeeSummaryReport = async (
  req: Request & { user?: any },
  res: Response,
) => {
  try {
    if (
      !req.user?.orgId ||
      (req.user.role !== "ADMIN" && req.user.role !== "MANAGER")
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { start, end, departmentId } = req.query as {
      start?: string;
      end?: string;
      departmentId?: string;
    };

    /* ---------------- DATE NORMALIZATION ---------------- */

    const toDateSafe = (v?: string | Date) => {
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };

    const startAt = toDateSafe(start);
    const endAt = toDateSafe(end);

    if (startAt) startAt.setHours(0, 0, 0, 0);
    if (endAt) endAt.setHours(23, 59, 59, 999);

    if (startAt && endAt && startAt > endAt) {
      return res.status(400).json({ message: "Invalid date range" });
    }

    /* ---------------- BUILD SUMMARY ---------------- */

    let rows = await buildEmployeeSummary(
      req.user.orgId,
      startAt || undefined,
      endAt || undefined,
    );

    /* ---------------- APPLY DEPARTMENT FILTER ---------------- */

    if (departmentId && departmentId !== "ALL") {
      rows = rows.filter((r) => r.departmentId === departmentId);
    }

    /* ================= EMPLOYEE SHEET ================= */

    const employeeSheet = rows.map((e) => ({
      Employee: e.name,
      Department: e.departmentName ?? "No Department",
      Assigned: e.assigned,
      Completed: e.completed,
      Open: e.open,
      Overdue: e.overdue,
      "Completion Rate (%)": e.completionRate,
    }));

    /* ================= DEPARTMENT SUMMARY SHEET ================= */

    const deptMap = new Map<string, any>();

    for (const e of rows) {
      const key = e.departmentName ?? "No Department";

      if (!deptMap.has(key)) {
        deptMap.set(key, {
          assigned: 0,
          completed: 0,
          open: 0,
          overdue: 0,
        });
      }

      const d = deptMap.get(key);
      d.assigned += e.assigned;
      d.completed += e.completed;
      d.open += e.open;
      d.overdue += e.overdue;
    }

    const departmentSheet = Array.from(deptMap.entries()).map(([dept, v]) => ({
      Department: dept,
      Assigned: v.assigned,
      Completed: v.completed,
      Open: v.open,
      Overdue: v.overdue,
      "Completion Rate (%)":
        v.assigned > 0 ? Math.round((v.completed / v.assigned) * 100) : 0,
    }));

    /* ================= BUILD WORKBOOK ================= */

    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(employeeSheet),
      "Employees",
    );

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(departmentSheet),
      "Departments",
    );

    /* ================= SEND AS BUFFER ================= */

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const fileName = `employee-summary-${start || "all"}_to_${end || "all"}.xlsx`;

    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Length", buffer.length);

    return res.send(buffer);
  } catch (err) {
    console.error("Excel export failed:", err);
    return res.status(500).json({ message: "Excel export failed" });
  }
};