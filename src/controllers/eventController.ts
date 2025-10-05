// src/controllers/calendarController.ts
import { Request, Response } from "express";
import { z } from "zod";
import { getOrgPrisma } from "../di/container";

/**
 * Helper: resolve org prisma from req.orgPrisma (set by middleware) or container factory.
 * Throws when orgId missing.
 */
async function resolveOrgPrisma(req: Request) {
  const maybe = (req as any).orgPrisma;
  if (maybe) return maybe;
  const orgId = (req.user as any)?.orgId;
  if (!orgId) throw new Error("Org ID required");
  return await getOrgPrisma(orgId);
}

// Match your TaskStatus enum
const TaskStatusEnum = z.enum([
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

const QuerySchema = z.object({
  start: z.string().min(1), // ISO
  end: z.string().min(1), // ISO
  projectId: z.string().optional(),
  assigneeId: z.string().optional(),
  clientId: z.string().optional(),
  // allow single or comma-separated list
  status: z
    .union([TaskStatusEnum, z.string().transform((s: string) => s.trim())])
    .optional(),

  // convenience flags
  isCompleted: z.union([z.literal("true"), z.literal("false")]).optional(),
});

export const getEvents = async (req: Request, res: Response) => {
  try {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: "Invalid query", details: parsed.error.flatten() });
    }

    const orgId = (req.user as any)?.orgId;
    if (!orgId) return res.status(400).json({ error: "Missing org context" });

    const prisma = await resolveOrgPrisma(req);

    const { start, end, projectId, assigneeId, clientId, status, isCompleted } =
      parsed.data;

    const rangeStart = new Date(start);
    const rangeEnd = new Date(end);

    // Support multi-status via comma-separated query: ?status=OPEN,IN_PROGRESS
    const statusList =
      typeof status === "string" && status.includes(",")
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

        ...(statusList ? { status: { in: statusList as any } } : {}),
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

    const events = occurrences.map((o: any) => ({
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
  } catch (err: any) {
    console.error(err);
    return res
      .status(500)
      .json({ error: err?.message || "Failed to load calendar events" });
  }
};
