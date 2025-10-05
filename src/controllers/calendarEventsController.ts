import { Request, Response } from "express";
import { expandEntryOccurrences } from "../utils/recurrence";
import { getOrgPrisma } from "../di/container";

/**
 * Resolve org prisma from req or container
 */
async function resolveOrgPrisma(req: Request) {
  const maybe = (req as any).orgPrisma;
  if (maybe) return maybe;
  const orgId = (req.user as any)?.orgId;
  if (!orgId) throw new Error("Org ID required");
  return await getOrgPrisma(orgId);
}

export const getCalendarEvents = async (req: Request, res: Response) => {
  try {
    const orgPrisma = await resolveOrgPrisma(req);

    const start = req.query.start ? new Date(String(req.query.start)) : null;
    const end = req.query.end ? new Date(String(req.query.end)) : null;
    const statusFilter = (req.query.status as string | undefined)
      ?.split(",")
      .filter(Boolean);

    const user = req.user as any;
    const isAdmin = user.role === "ADMIN";
    const isManager = user.role === "MANAGER";

    // ---------------- A) Task occurrences ----------------
    const whereOcc: any = {};
    if (start || end) {
      whereOcc.dueDate = {};
      if (start) whereOcc.dueDate.gte = start;
      if (end) whereOcc.dueDate.lt = end;
    }
    if (statusFilter?.length) whereOcc.status = { in: statusFilter as any };

    if (!isAdmin) {
      if (isManager) {
        // Managers see:
        // 1) occurrences assigned directly to them
        // 2) occurrences where they are in multi-assignees
        // 3) occurrences in projects where they are the head
        const headProjects = await orgPrisma.project.findMany({
          where: { head: user.id }, // schema: Project.head String?
          select: { id: true },
        });
        const headProjectIds = headProjects.map((p: any) => p.id);

        whereOcc.OR = [
          { assignedToId: user.id },
          {
            assignees: {
              some: { userId: user.id },
            },
          },
          ...(headProjectIds.length
            ? [{ projectId: { in: headProjectIds } }]
            : []),
        ];
      } else {
        // Employees (and others): occurrences assigned to them (direct or multi)
        whereOcc.OR = [
          { assignedToId: user.id },
          {
            assignees: {
              some: { userId: user.id },
            },
          },
        ];
      }
    }

    const occs = await orgPrisma.taskOccurrence.findMany({
      where: whereOcc,
      orderBy: { dueDate: "asc" },
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
    });

    // Enrich with project head (schema: head String? on Project)
    const occProjectIds = Array.from(
      new Set(occs.map((o: any) => o.projectId).filter(Boolean))
    ) as string[];

    let projectHeadMap = new Map<string, string | null>();
    if (occProjectIds.length) {
      const projects = await orgPrisma.project.findMany({
        where: { id: { in: occProjectIds } },
        select: {
          id: true,
          head: true, // String? core userId
        },
      });
      projectHeadMap = new Map(projects.map((p: any) => [p.id, p.head ?? null]));
    }

    const taskEvents = occs.map((o: any) => {
      const projectHeadId = o.projectId
        ? projectHeadMap.get(o.projectId) ?? null
        : null;
      return {
        id: o.id,
        title: o.title,
        start: o.dueDate.toISOString(),
        end: null,
        allDay: false,
        meta: {
          taskId: o.taskId,
          occurrenceIndex: o.occurrenceIndex,
          projectId: o.projectId,
          clientId: o.clientId,
          assigneeId: o.assignedToId,
          priority: o.priority,
          status: o.status,
          isCompleted: o.isCompleted,

          // for frontend filters
          projectHeadId, // single head field from Project.head
          projectHeadIds: [], // keep shape stable if your UI expects an array
        },
      };
    });

    // ---------------- B) Calendar entries ----------------
    const entryWhere: any = {};
    if (!isAdmin) {
      // Managers and employees: only their own reminders/appointments
      entryWhere.createdById = user.id;
    }

    const entries = await orgPrisma.calendarEntry.findMany({
      where: entryWhere,
      orderBy: { start: "asc" },
    });

    const entryEvents = entries.flatMap((entry: any) => {
      const occStarts = expandEntryOccurrences(
        entry,
        start ?? undefined,
        end ?? undefined
      );
      return occStarts.map((occStart) => ({
        id: `ce_${entry.id}_${occStart.toISOString()}`,
        title: entry.title,
        start: occStart.toISOString(),
        end: entry.end ? entry.end.toISOString() : null,
        allDay: entry.allDay ?? true,
        meta: {
          taskId: null,
          occurrenceIndex: 0,
          projectId: null,
          clientId: null,
          assigneeId: entry.createdById,
          priority: "MEDIUM",
          status: "OPEN",
          isCompleted: false,
          entryId: entry.id,
          entryType: entry.type,
          freq: entry.freq ?? null,

          projectHeadId: null,
          projectHeadIds: [],
        },
      }));
    });

    const entriesFiltered = statusFilter?.length
      ? entryEvents.filter((e: any) => statusFilter.includes(e.meta.status))
      : entryEvents;

    const events = [...taskEvents, ...entriesFiltered].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
    );

    res.json({ events });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch calendar events" });
  }
};
