// src/reports/generateTaskReport.ts
import { buildTaskWhere } from "./buildTaskWhere";
import { countTasks } from "./countTasks";
import { generateTaskXlsx } from "./generateTaskXlsx";
import { generateTaskCsv } from "./generateTaskCsv";
import { XLSX_ROW_LIMIT } from "./report.constants";
import { getCorePrisma, getOrgPrisma } from "../di/container";
import { Request } from "express";

async function resolveOrgPrisma(req: Request) {
  const maybe = (req as any).orgPrisma;
  if (maybe) return maybe;
  const orgId = (req.user)?.orgId;
  if (!orgId) throw new Error("Org ID required");
  return await getOrgPrisma(orgId);
}

export async function generateTaskReport(req: any, res: any) {
  const prisma = await resolveOrgPrisma(req);
  const user = req.user;
  const filters = req.body || {};

  const where = buildTaskWhere(filters, user);

  const count = await countTasks(prisma, where);

  if (count <= XLSX_ROW_LIMIT) {
    return generateTaskXlsx(req, where, res);
  }

  return generateTaskCsv(prisma, where, res);
}
