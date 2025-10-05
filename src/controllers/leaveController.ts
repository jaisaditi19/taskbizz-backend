// src/controllers/leaveController.ts
import { Request, Response } from "express";
import { getOrgPrisma, getCorePrisma } from "../di/container";
import { notifyUsers } from "../utils/notify";

/**
 * Resolve the org-specific Prisma client for this request.
 * Prefer middleware-attached client (req.orgPrisma); fall back to the factory.
 */
async function resolveOrgPrisma(req: Request) {
  const maybe = (req as any).orgPrisma;
  if (maybe) return maybe;
  const orgId = (req.user as any)?.orgId;
  if (!orgId) throw new Error("Org ID required");
  return await getOrgPrisma(orgId);
}

/** Narrowing helpers (same spirit as projectController) */
function requireUser(req: Request) {
  const user = (req as any).user as
    | { id: string; role: "ADMIN" | "EMPLOYEE"; orgId: string }
    | undefined;
  if (!user) throw Object.assign(new Error("Unauthorized"), { status: 401 });
  return user;
}

function normalizeRange(startISO: string | Date, endISO: string | Date) {
  const s = new Date(startISO);
  s.setHours(0, 0, 0, 0);
  const e = new Date(endISO);
  e.setHours(23, 59, 59, 999);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()))
    throw new Error("Invalid dates");
  if (e < s) throw new Error("endDate must be after startDate");
  return { s, e };
}

/** Core snapshot helper (uses your Core DB schema: name+email) */
async function fetchCoreUserSnapshot(corePrisma: any, userId: string) {
  const user = await corePrisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true },
  });

  return user
    ? {
        requesterId: user.id,
        requesterName: user.name ?? undefined,
        requesterEmail: user.email ?? undefined,
      }
    : { requesterId: userId };
}

/**
 * Create a leave request
 */
export const createLeave = async (req: Request, res: Response) => {
  try {
    const corePrisma = getCorePrisma();
    const user = requireUser(req);

    const orgId = (user as any).orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    const { type, startDate, endDate, days, reason } = req.body;
    if (!type || !startDate || !endDate || !days) {
      return res
        .status(400)
        .json({ message: "type, startDate, endDate and days are required" });
    }

    const prisma = await resolveOrgPrisma(req);
    const { s, e } = normalizeRange(startDate, endDate);

    // ❌ Block overlap with already APPROVED leave(s)
    const approvedConflict = await prisma.leaveRequest.findFirst({
      where: {
        requesterId: user.id,
        status: "APPROVED",
        // overlap test: existing.startDate <= newEnd AND existing.endDate >= newStart
        startDate: { lte: e },
        endDate: { gte: s },
      },
      select: { id: true, startDate: true, endDate: true, status: true },
    });

    if (approvedConflict) {
      return res.status(400).json({
        message:
          "Requested dates overlap with an already approved leave window.",
        conflict: approvedConflict,
      });
    }

    // (optional) also block overlapping *pending* requests to stop duplicates
    const pendingConflict = await prisma.leaveRequest.findFirst({
      where: {
        requesterId: user.id,
        status: "PENDING",
        startDate: { lte: e },
        endDate: { gte: s },
      },
      select: { id: true, startDate: true, endDate: true, status: true },
    });

    if (pendingConflict) {
      return res.status(400).json({
        message:
          "You already have a pending leave request that overlaps these dates.",
        conflict: pendingConflict,
      });
    }

    const snapshot = await fetchCoreUserSnapshot(corePrisma, user.id);

    const leave = await prisma.leaveRequest.create({
      data: {
        ...snapshot,
        type,
        reason,
        startDate: s,
        endDate: e,
        days: Number(days),
      },
    });

    // notify admins (unchanged)
    const core = getCorePrisma();
    const admins = await core.user.findMany({
      where: { orgId, role: "ADMIN" },
      select: { id: true },
    });
    const adminIds = admins.map((a) => a.id).filter((id) => id !== user.id);

    if (adminIds.length) {
      await notifyUsers({
        orgPrisma: prisma,
        io: (req as any).io,
        orgId,
        recipients: adminIds,
        payload: {
          type: "LEAVE_CREATED",
          title: "New leave request 🗓️",
          body: `${
            user.id === leave.requesterId
              ? leave.requesterName ?? "Employee"
              : "Employee"
          } requested ${leave.days} ${
            leave.days === 1 ? "day" : "days"
          } (${new Date(leave.startDate).toLocaleDateString()}–${new Date(
            leave.endDate
          ).toLocaleDateString()}).`,
          actorId: user.id,
        },
      });
    }

    (req as any).io?.to(`org:${orgId}:admins`).emit("leave:created", { leave });
    res.status(201).json(leave);
  } catch (error: any) {
    console.error("createLeave error:", error);
    const status =
      error?.message === "Unauthorized" || error?.message === "Org ID required"
        ? 400
        : 500;
    res
      .status(status)
      .json({ message: "Failed to create leave", detail: error?.message });
  }
};

/**
 * Get a single leave (owner or admin)
 */
export const getLeave = async (req: Request, res: Response) => {
  try {
    const user = requireUser(req);
    const orgId = (user as any).orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "Leave ID is required" });

    const prisma = await resolveOrgPrisma(req);

    const leave = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!leave) return res.status(404).json({ message: "Not found" });

    if (user.role !== "ADMIN" && leave.requesterId !== user.id) {
      return res.status(403).json({ message: "Forbidden" });
    }

    res.json(leave);
  } catch (error: any) {
    console.error("getLeave error:", error);
    const status =
      error?.message === "Unauthorized" || error?.message === "Org ID required"
        ? 400
        : 500;
    res
      .status(status)
      .json({ message: "Failed to fetch leave", detail: error?.message });
  }
};

/**
 * List leaves (pagination + filters)
 * Query:
 *  - status
 *  - requesterId (admin only)
 *  - from, to (date range on startDate)
 *  - page (default 1), limit (default 50)
 */

export async function listLeaves(req: Request, res: Response) {
  try {
    const prisma = await getOrgPrisma((req.user as any).orgId);
    const role = (req.user as any)?.role as "ADMIN" | "MANAGER" | "EMPLOYEE";
    const userId = (req.user as any)?.id;

    // query params
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));
    const status = req.query.status as
      | "PENDING"
      | "APPROVED"
      | "REJECTED"
      | "CANCELLED"
      | undefined;
    const requesterId = (req.query.requesterId as string | undefined)?.trim();
    const search = (req.query.search as string | undefined)?.trim();
    const includeSelfParam =
      (req.query.includeSelf as string | undefined)?.toLowerCase() === "true";

    // ✅ NEW: date range (from/to) for overlap filtering
    const fromStr = (req.query.from as string | undefined)?.trim();
    const toStr = (req.query.to as string | undefined)?.trim();

    // base where
    const where: any = {};

    if (status) where.status = status;
    if (requesterId) where.requesterId = requesterId;

    if (search) {
      where.OR = [
        { requesterName: { contains: search, mode: "insensitive" } },
        { requesterEmail: { contains: search, mode: "insensitive" } },
        { reason: { contains: search, mode: "insensitive" } },
      ];
    }

    // 🔑 Manager rule
    if (role === "MANAGER" && !requesterId && !includeSelfParam) {
      where.requesterId = { not: userId };
    }

    // ✅ Apply overlap on [from, to]: startDate <= to AND endDate >= from
    if (fromStr || toStr) {
      const from = fromStr ? new Date(fromStr + "T00:00:00.000Z") : undefined;
      const to = toStr ? new Date(toStr + "T23:59:59.999Z") : undefined;

      if (from && to) {
        where.AND = [
          ...(where.AND ?? []),
          { startDate: { lte: to } },
          { endDate: { gte: from } },
        ];
      } else if (from) {
        // any leave ending on/after from
        where.endDate = { ...(where.endDate || {}), gte: from };
      } else if (to) {
        // any leave starting on/before to
        where.startDate = { ...(where.startDate || {}), lte: to };
      }
    }

    const [total, items] = await Promise.all([
      prisma.leaveRequest.count({ where }),
      prisma.leaveRequest.findMany({
        where,
        // (optional) sort by startDate desc so the month reads naturally
        orderBy: { startDate: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          requesterId: true,
          requesterName: true,
          requesterEmail: true,
          type: true,
          reason: true,
          startDate: true,
          endDate: true,
          days: true,
          status: true,
          adminComment: true,
          createdAt: true,
        },
      }),
    ]);

    res.json({ items, total, page, perPage: limit });
  } catch (err: any) {
    console.error("listLeaves error", err);
    res.status(500).json({ message: "Failed to list leaves" });
  }
}


type Role = "ADMIN" | "MANAGER" | "EMPLOYEE";

export const approveLeave = async (req: Request, res: Response) => {
  try {
    const user = requireUser(req);
    const orgId = (user as any).orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    // ✅ Avoid TS2367 by checking membership
    const role = (user as { role: Role }).role;
    const ALLOWED: readonly Role[] = ["ADMIN", "MANAGER"];
    if (!ALLOWED.includes(role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "Leave ID is required" });

    const comment = (req.body && (req.body as any).comment) ?? undefined;

    const prisma = await resolveOrgPrisma(req);
    const existing = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (existing.status !== "PENDING")
      return res.status(400).json({ message: "Already processed" });

    // (optional) block self-approval
    if (existing.requesterId === (user as any).id) {
      return res
        .status(403)
        .json({ message: "You cannot approve your own leave" });
    }

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: "APPROVED",
        approverId: (user as any).id,
        adminComment: comment,
      },
    });

    (req as any).io
      ?.to(`org:${orgId}`)
      .emit("leave:updated", { leave: updated });

    await notifyUsers({
      orgPrisma: prisma,
      io: (req as any).io,
      orgId,
      recipients: [updated.requesterId],
      payload: {
        type: "LEAVE_DECISION",
        title: "Leave approved ✅",
        body: updated.adminComment
          ? `Your leave request was approved. Note: ${updated.adminComment}`
          : "Your leave request was approved.",
        actorId: (user as any).id,
      },
    });

    return res.json(updated);
  } catch (error: any) {
    console.error("approveLeave error:", error);
    const status =
      error?.message === "Unauthorized" || error?.message === "Org ID required"
        ? 400
        : 500;
    return res
      .status(status)
      .json({ message: "Failed to approve leave", detail: error?.message });
  }
};

export const rejectLeave = async (req: Request, res: Response) => {
  try {
    const user = requireUser(req);
    const orgId = (user as any).orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    // ✅ Same membership pattern
    const role = (user as { role: Role }).role;
    const ALLOWED: readonly Role[] = ["ADMIN", "MANAGER"];
    if (!ALLOWED.includes(role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "Leave ID is required" });

    const comment = (req.body && (req.body as any).comment) ?? undefined;

    const prisma = await resolveOrgPrisma(req);
    const existing = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (existing.status !== "PENDING")
      return res.status(400).json({ message: "Already processed" });

    // (optional) block self-rejection
    if (existing.requesterId === (user as any).id) {
      return res
        .status(403)
        .json({ message: "You cannot reject your own leave" });
    }

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: "REJECTED",
        approverId: (user as any).id,
        adminComment: comment,
      },
    });

    (req as any).io
      ?.to(`org:${orgId}`)
      .emit("leave:updated", { leave: updated });

    await notifyUsers({
      orgPrisma: prisma,
      io: (req as any).io,
      orgId,
      recipients: [updated.requesterId],
      payload: {
        type: "LEAVE_DECISION",
        title: "Leave rejected ❌",
        body: updated.adminComment
          ? `Your leave request was rejected. Reason: ${updated.adminComment}`
          : "Your leave request was rejected.",
        actorId: (user as any).id,
      },
    });

    return res.json(updated);
  } catch (error: any) {
    console.error("rejectLeave error:", error);
    const status =
      error?.message === "Unauthorized" || error?.message === "Org ID required"
        ? 400
        : 500;
    return res
      .status(status)
      .json({ message: "Failed to reject leave", detail: error?.message });
  }
};

/**
 * Cancel leave (requester only, while PENDING)
 */
export const cancelLeave = async (req: Request, res: Response) => {
  try {
    const user = requireUser(req);
    const orgId = (user as any).orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "Leave ID is required" });

    const prisma = await resolveOrgPrisma(req);

    const existing = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (existing.requesterId !== user.id)
      return res.status(403).json({ message: "Forbidden" });
    if (existing.status !== "PENDING") {
      return res
        .status(400)
        .json({ message: "Can only cancel PENDING leaves" });
    }

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: { status: "CANCELLED" },
    });

    (req as any).io
      ?.to(`org:${orgId}`)
      .emit("leave:updated", { leave: updated });
    res.json(updated);
  } catch (error: any) {
    console.error("cancelLeave error:", error);
    const status =
      error?.message === "Unauthorized" || error?.message === "Org ID required"
        ? 400
        : 500;
    res
      .status(status)
      .json({ message: "Failed to cancel leave", detail: error?.message });
  }
};

export const adminCancelLeave = async (req: Request, res: Response) => {
  try {
    const user = requireUser(req);
    const orgId = (user as any).orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    const role = (user as { role: Role }).role;
    const ALLOWED: readonly Role[] = ["ADMIN", "MANAGER"];
    if (!ALLOWED.includes(role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "Leave ID is required" });

    const comment =
      (req.body && (req.body as any).comment?.toString()?.trim()) || undefined;

    const prisma = await resolveOrgPrisma(req);
    const existing = await prisma.leaveRequest.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Not found" });

    // Only allow cancelling APPROVED or PENDING here (requester can already cancel PENDING via their endpoint)
    if (existing.status !== "APPROVED" && existing.status !== "PENDING") {
      return res.status(400).json({
        message: "Only APPROVED or PENDING leaves can be cancelled by admin.",
      });
    }

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: "CANCELLED",
        approverId: (user as any).id, // track who cancelled
        adminComment: comment,
      },
    });

    (req as any).io
      ?.to(`org:${orgId}`)
      .emit("leave:updated", { leave: updated });

    await notifyUsers({
      orgPrisma: prisma,
      io: (req as any).io,
      orgId,
      recipients: [updated.requesterId],
      payload: {
        type: "LEAVE_DECISION",
        title: "Leave cancelled",
        body:
          comment && comment.length
            ? `Your leave was cancelled by ${role.toLowerCase()}. Note: ${comment}`
            : `Your leave was cancelled by ${role.toLowerCase()}.`,
        actorId: (user as any).id,
      },
    });

    return res.json(updated);
  } catch (error: any) {
    console.error("adminCancelLeave error:", error);
    const status =
      error?.message === "Unauthorized" || error?.message === "Org ID required"
        ? 400
        : 500;
    return res
      .status(status)
      .json({ message: "Failed to cancel leave", detail: error?.message });
  }
};