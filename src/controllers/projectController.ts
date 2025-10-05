// src/controllers/projectController.ts
import { Request, Response } from "express";
import { getOrgPrisma, getCorePrisma } from "../di/container";

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


/**
 * Create a project
 */
export const createProject = async (req: Request, res: Response) => {
  try {
    const corePrisma = getCorePrisma();
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { name, head, taskId } = req.body;
    const orgId = (req.user as any).orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });
    if (!name)
      return res.status(400).json({ message: "Project name is required" });

    if (head) {
      const userExists = await corePrisma.user.findUnique({
        where: { id: head },
        select: { id: true },
      });
      if (!userExists) {
        return res.status(400).json({ message: "Invalid head user ID" });
      }
    }

    const prisma = await resolveOrgPrisma(req);

    const project = await prisma.project.create({
      data: { name, head: head || null, taskId: taskId || null },
    });

    res.status(201).json(project);
  } catch (error: any) {
    console.error("createProject error:", error);
    const status = error?.message === "Org ID required" ? 400 : 500;
    res
      .status(status)
      .json({ message: "Failed to create project", detail: error?.message });
  }
};

/**
 * Get paginated & filtered projects
 *
 * Query params:
 *  - page (1-based)
 *  - pageSize
 *  - q (search against project.name, contains, case-insensitive)
 *  - head (filter by head user id)
 */
export const getProjects = async (req: Request, res: Response) => {
  try {
    // const corePrisma = getCorePrisma();
    const orgId = (req.user as any)?.orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(String(req.query.pageSize ?? "25"), 10))
    );

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const head =
      typeof req.query.head === "string" && req.query.head.trim() !== ""
        ? req.query.head.trim()
        : null;

    const prisma = await resolveOrgPrisma(req);

    // build where clause
    const where: any = {};
    if (q) {
      where.name = { contains: q, mode: "insensitive" };
    }
    if (head) {
      where.head = head;
    }

    const total = await prisma.project.count({ where });

    const projects = await prisma.project.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return res.json({
      data: projects,
      total,
      page,
      pageSize,
    });
  } catch (error) {
    console.error("getProjects error:", error);
    res.status(500).json({ error: "Failed to fetch projects" });
  }
};

/**
 * Update project
 */
export const updateProject = async (req: Request, res: Response) => {
  try {
    const corePrisma = getCorePrisma();
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const projectId = req.params.id;
    const { name, head, taskId } = req.body;
    const orgId = (req.user as any).orgId;

    if (!orgId) return res.status(400).json({ message: "Org ID required" });
    if (!projectId)
      return res.status(400).json({ message: "Project ID is required" });
    if (!name)
      return res.status(400).json({ message: "Project name is required" });

    if (head) {
      const userExists = await corePrisma.user.findUnique({
        where: { id: head },
        select: { id: true },
      });
      if (!userExists) {
        return res.status(400).json({ message: "Invalid head user ID" });
      }
    }

    const prisma = await resolveOrgPrisma(req);

    const updatedProject = await prisma.project.update({
      where: { id: projectId },
      data: { name, head: head || null, taskId: taskId || null },
    });

    res.json(updatedProject);
  } catch (error: any) {
    console.error("updateProject error:", error);
    const status = error?.message === "Org ID required" ? 400 : 500;
    res
      .status(status)
      .json({ message: "Failed to update project", detail: error?.message });
  }
};

/**
 * Delete project
 */
export const deleteProject = async (req: Request, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const orgId = (req.user as any).orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    const prisma = await resolveOrgPrisma(req);
    const existingProject = await prisma.project.findFirst({
      where: { id: id },
    });

    if (!existingProject)
      return res.status(404).json({ message: "Project Not Found" });

    await prisma.project.delete({
      where: { id: id },
    });

    return res.json({ ok: true, id });
  } catch (err: any) {
    console.error("deleteProject error:", err);
    const status = err?.message === "Org ID required" ? 400 : 500;
    res
      .status(status)
      .json({ message: "Failed to delete project", detail: err?.message });
  }
};

/**
 * Bulk upload projects
 */
export const bulkUploadProjects = async (req: Request, res: Response) => {
  try {
    const corePrisma = getCorePrisma();
    const { projects } = req.body;
    const orgId = (req.user as any).orgId;

    if (!orgId) return res.status(400).json({ message: "Org ID required" });
    if (!Array.isArray(projects) || projects.length === 0) {
      return res.status(400).json({ message: "projects array is required" });
    }

    const prisma = await resolveOrgPrisma(req);
    const results: any[] = [];

    for (const row of projects) {
      try {
        const { id, name, head, taskId } = row;

        if (!name) {
          results.push({ ok: false, error: "Project name is required", row });
          continue;
        }

        if (head) {
          const userExists = await corePrisma.user.findUnique({
            where: { id: head },
            select: { id: true },
          });
          if (!userExists) {
            results.push({ ok: false, error: "Invalid head user ID", row });
            continue;
          }
        }

        let project;

        if (id) {
          try {
            project = await prisma.project.update({
              where: { id },
              data: { name, head: head || null, taskId: taskId || null },
            });
          } catch (updateErr) {
            // if update fails because not found, fall back to create
            project = await prisma.project.create({
              data: { name, head: head || null, taskId: taskId || null },
            });
          }
        } else {
          project = await prisma.project.create({
            data: { name, head: head || null, taskId: taskId || null },
          });
        }

        results.push({ ok: true, projectId: project.id, name: project.name });
      } catch (err: any) {
        console.error("bulkUploadProjects row error:", err);
        results.push({ ok: false, error: err.message, row });
      }
    }

    res.status(201).json({
      message: `Processed ${projects.length} projects`,
      results,
    });
  } catch (err: any) {
    console.error("bulkUploadProjects error:", err);
    res.status(500).json({ message: "Bulk upload failed", err });
  }
};

/**
 * Bulk update project head(s)
 *
 * Modes:
 *  A) Single head for multiple projects:
 *     Body: { ids: string[], head: string | null }
 *
 *  B) Pairwise updates:
 *     Body: { updates: { id: string; head: string | null }[] }
 */
export const bulkUpdateProjectHeads = async (req: Request, res: Response) => {
  try {
    const corePrisma = getCorePrisma();
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const orgId = (req.user as any)?.orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    const prisma = await resolveOrgPrisma(req);

    const { ids, head, updates } = req.body as
      | { ids: string[]; head: string | null; updates?: undefined }
      | { updates: Array<{ id: string; head: string | null }>; ids?: undefined; head?: undefined };

    // -------- Mode B: pairwise updates --------
    if (Array.isArray(updates) && updates.length > 0) {
      // validate head ids (ignore nulls)
      const uniqueHeads = Array.from(
        new Set(updates.map((u) => u.head).filter((h): h is string => typeof h === "string" && h.trim() !== ""))
      );

      if (uniqueHeads.length > 0) {
        const found = await corePrisma.user.findMany({
          where: { id: { in: uniqueHeads } },
          select: { id: true },
        });
        const foundSet = new Set(found.map((u) => u.id));
        const missing = uniqueHeads.filter((id) => !foundSet.has(id));
        if (missing.length > 0) {
          return res.status(400).json({
            message: "Some head user IDs are invalid",
            invalidHeadIds: missing,
          });
        }
      }

      // apply updates one-by-one to allow partial success
      const settled = await Promise.allSettled(
        updates.map(({ id, head }) =>
          prisma.project.update({
            where: { id },
            data: { head: head ?? null },
          })
        )
      );

      const failed: Array<{ id: string; message: string; code?: string }> = [];
      let updatedCount = 0;

      settled.forEach((r, i) => {
        if (r.status === "fulfilled") {
          updatedCount++;
        } else {
          const reason: any = r.reason || {};
          failed.push({
            id: updates[i].id,
            code: reason?.code,
            message: reason?.message || "Failed to update project",
          });
        }
      });

      return res.json({
        message: "Bulk head update attempted",
        updatedCount,
        failedCount: failed.length,
        failed,
      });
    }

    // -------- Mode A: single head for list of ids --------
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids[] is required when 'updates' is not provided" });
    }

    // when head is provided as non-null string, validate it
    if (head !== null && head !== undefined) {
      if (typeof head !== "string" || head.trim() === "") {
        return res.status(400).json({ message: "head must be a string user ID or null" });
      }
      const userExists = await corePrisma.user.findUnique({
        where: { id: head },
        select: { id: true },
      });
      if (!userExists) {
        return res.status(400).json({ message: "Invalid head user ID" });
      }
    }

    const result = await prisma.project.updateMany({
      where: { id: { in: ids } },
      data: { head: head ?? null },
    });

    return res.json({
      message: "Project heads updated",
      count: result.count,
    });
  } catch (error: any) {
    console.error("bulkUpdateProjectHeads error:", error);
    const status = error?.message === "Org ID required" ? 400 : 500;
    return res
      .status(status)
      .json({ message: "Failed to bulk update project heads", detail: error?.message });
  }
};
