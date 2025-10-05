// src/middlewares/managerPolicies.ts
import { Response, NextFunction } from "express";
import { getOrgPrisma } from "../di/container";

const S = (v: any) => (v == null ? null : String(v));

export async function resolveProjectIdFromReq(
  req: any
): Promise<string | null> {
  const user = req.currentUser ?? req.user;
  if (!user?.orgId) return null;
  const orgPrisma = await getOrgPrisma(user.orgId);

  const p = req?.params ?? {};
  const b = req?.body ?? {};
  const q = req?.query ?? {};
  const routePath = String(req?.route?.path ?? "");

  // 1) Direct projectId in params/body/query or common nesting
  const directProjectId =
    p.projectId ??
    b.projectId ??
    q.projectId ??
    b?.task?.projectId ??
    b?.data?.projectId ??
    b?.payload?.projectId;

  if (directProjectId) return S(directProjectId);

  // 2) If you passed "project" object
  const projectObjId = b?.project?.id ?? b?.task?.project?.id;
  if (projectObjId) return S(projectObjId);

  // 3) From task id (params/body/query or route :id on /task path)
  const idMaybe = p.id ?? b.id ?? q.id ?? null;
  const taskId =
    p.taskId ??
    b.taskId ??
    q.taskId ??
    (routePath.includes("/task") ? idMaybe : null);

  if (taskId) {
    const t = await orgPrisma.task.findUnique({
      where: { id: S(taskId)! },
      select: { projectId: true },
    });
    if (t?.projectId) return S(t.projectId);
  }

  // 4) From occurrence id
  const occurrenceId =
    p.occurrenceId ??
    b.occurrenceId ??
    q.occurrenceId ??
    (routePath.includes("/occurrence") ? idMaybe : null);

  if (occurrenceId) {
    const occ = await orgPrisma.taskOccurrence.findUnique({
      where: { id: S(occurrenceId)! },
      select: { task: { select: { projectId: true } } },
    });
    if (occ?.task?.projectId) return S(occ.task.projectId);
  }

  return null;
}

export const canManageWithinProject = () => {
  return async (req: any, res: Response, next: NextFunction) => {
    const user = req.currentUser ?? req.user;
    if (!user) return res.status(401).json({ message: "Unauthorized" });
    if (user.role === "ADMIN") return next();

    if (user.role === "MANAGER") {
      const projectId = await resolveProjectIdFromReq(req);
      if (!projectId) {
        // Log to help you see which route/body caused it
        if (process.env.NODE_ENV !== "production") {
          console.warn("[canManageWithinProject] Missing project context", {
            path: req?.route?.path,
            params: req?.params,
            bodyKeys: Object.keys(req?.body ?? {}),
            query: req?.query,
          });
        }
        return res.status(400).json({ message: "Project context required" });
      }

      const orgPrisma = await getOrgPrisma(user.orgId);
      const project = await orgPrisma.project.findUnique({
        where: { id: projectId },
        select: { head: true },
      });
      if (!project)
        return res.status(404).json({ message: "Project not found" });
      if (project.head === user.id) return next();

      return res.status(403).json({ message: "Forbidden: not project head" });
    }

    return res.status(403).json({ message: "Forbidden" });
  };
};
