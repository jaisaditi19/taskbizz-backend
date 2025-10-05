// src/utils/access.ts
import type { Request } from "express";
import { getOrgPrisma } from "../di/container";

export function isAdmin(user: any) {
  return user?.role === "ADMIN";
}
export function isManager(user: any) {
  return user?.role === "MANAGER";
}

/** Resolve projectId from any of: projectId | taskId | occurrenceId */
export async function resolveProjectId({
  orgPrisma,
  projectId,
  taskId,
  occurrenceId,
}: {
  orgPrisma: any;
  projectId?: string | null;
  taskId?: string | null;
  occurrenceId?: string | null;
}): Promise<string | null> {
  if (projectId) return String(projectId);

  if (taskId) {
    const t = await orgPrisma.task.findUnique({
      where: { id: String(taskId) },
      select: { projectId: true },
    });
    if (t?.projectId) return t.projectId;
  }

  if (occurrenceId) {
    const occ = await orgPrisma.taskOccurrence.findUnique({
      where: { id: String(occurrenceId) },
      select: { task: { select: { projectId: true } } },
    });
    if (occ?.task?.projectId) return occ.task.projectId;
  }

  return null;
}

/** Throw 403 if MANAGER and not head of the project. ADMIN passes. */
export async function assertManageScopeOrThrow(
  req: Request & { user?: any },
  projectId: string
) {
  const user = (req as any).currentUser ?? req.user;
  if (!user) {
    const err: any = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
  if (isAdmin(user)) return;

  if (isManager(user)) {
    const orgPrisma = await getOrgPrisma(user.orgId);
    const project = await orgPrisma.project.findUnique({
      where: { id: projectId },
      select: { head: true },
    });
    if (!project) {
      const err: any = new Error("Project not found");
      err.status = 404;
      throw err;
    }
    if (project.head !== user.id) {
      const err: any = new Error("Forbidden: not project head");
      err.status = 403;
      throw err;
    }
    return;
  }

  const err: any = new Error("Forbidden");
  err.status = 403;
  throw err;
}
