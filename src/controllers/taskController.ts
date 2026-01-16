// src/controllers/taskController.ts
import type { Request, Response } from "express";
// import { getOrgPrismaClient } from "../utils/tenantUtils";
import { DateTime } from "luxon";
import multer from "multer";
import {
  uploadFileToS3,
  // keep original getFileUrlFromSpaces for low-level use if needed
  getFileUrlFromS3 as _getFileUrlFromS3,
  // use the cached wrapper
  getCachedFileUrlFromS3,
  deleteFileFromS3,
} from "../utils/s3Utils";

import {
  uploadFileToSpaces,
  getFileUrlFromSpaces as _getFileUrlFromSpaces,
  getCachedFileUrlFromSpaces,
  deleteFileFromSpaces
} from "../utils/spacesUtils";
import { sendEmail } from "../utils/emailUtils";
// import { prisma } from "../prisma/coreClient";
import { getCorePrisma, getOrgPrisma } from "../di/container";
import { requireDocsFeatureIfDocOps } from "../middlewares/featureGates";
import { notifyUsers, notifyCounterparties } from "../utils/notify";
import { sendTaskEmail } from "../utils/mailerSend";
import {
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  subWeeks,
  subDays,
  startOfMonth,
  endOfMonth,
  addDays,
  addMonths,
} from "date-fns";
import {
  cacheGetJson,
  cacheSetJson,
  orgKey,
  // redis used for pubsub is available via cache module if needed
} from "../utils/cache";
import { invalidateOrgCaches } from "../utils/cacheInvalidate";
import axios from "axios";
import { sendTaskBizzServiceUpdate } from "../integrations/whatsapp/myoperator";
import { TaskStatus } from "../../prisma/generated/org-client";

async function resolveOrgPrisma(req: Request) {
  const maybe = (req as any).orgPrisma;
  if (maybe) return maybe;
  const orgId = (req.user as any)?.orgId;
  if (!orgId) throw new Error("Org ID required");
  return await getOrgPrisma(orgId);
}

/**
 * Permission helper:
 * - Admins allowed
 * - Legacy single-assignee (occ.assignedToId) allowed
 * - occurrence-level join (taskOccurrenceAssignee)
 * - task-level join (taskAssignee)
 *
 * Note: user table is in core DB (prisma). We rely on req.user (auth middleware).
 */
async function canEmployeeEditOccurrence(
  orgPrisma: any,
  corePrisma: any,
  req: Request & { user?: any },
  occurrenceId: string
) {
  // const orgPrisma = await resolveOrgPrisma(req);
  const user = req.user as any;
  if (!user) return false;
  if (user.role === "ADMIN" || user.role === "MANAGER") return true;

  const occ = await orgPrisma.taskOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { assignedToId: true, taskId: true },
  });

  // direct assignedToId (legacy single-assignee)
  if (occ?.assignedToId === user.id) return true;

  // occurrence-level join
  const occAssignee = await orgPrisma.taskOccurrenceAssignee.findFirst({
    where: { occurrenceId, userId: user.id },
    select: { id: true },
  });
  if (occAssignee) return true;

  // task-level join
  const taskAssignee = await orgPrisma.taskAssignee.findFirst({
    where: { taskId: occ?.taskId ?? "", userId: user.id },
    select: { id: true },
  });
  if (taskAssignee) return true;

  return false;
}

const storage = multer.memoryStorage();
export const uploadTaskFiles = multer({ storage }).array("attachments");

/** De-dup guard: keep exactly one occurrence (prefers occurrenceIndex=0) */
async function ensureSingleOccurrenceForTask(orgPrisma: any, taskId: string) {
  const occs = await orgPrisma.taskOccurrence.findMany({
    where: { taskId },
    orderBy: [{ occurrenceIndex: "asc" }, { startDate: "asc" }],
    select: { id: true, occurrenceIndex: true },
  });

  if (occs.length <= 1) return;

  const keep = occs.find((o: any) => o.occurrenceIndex === 0)?.id ?? occs[0].id;

  await orgPrisma.taskOccurrence.deleteMany({
    where: { taskId, id: { not: keep } },
  });
}

function excelDateToJSDate(serial: number): Date {
  // Excel epoch starts Jan 1, 1900 → Unix epoch Jan 1, 1970
  const utc_days = Math.floor(serial - 25569);
  const utc_value = utc_days * 86400; // seconds
  return new Date(utc_value * 1000);
}

function parseDateInput(input: any): Date | null {
  if (!input) return null;

  // Excel serial (number)
  if (typeof input === "number") {
    return excelDateToJSDate(input);
  }

  // Try parse as string
  if (typeof input === "string") {
    // Luxon is better for "2/12/2025", "6/3/2026", etc.
    const d = DateTime.fromFormat(input, "d/M/yyyy", { zone: "utc" });
    if (d.isValid) return d.toJSDate();

    // Try ISO fallback
    const iso = DateTime.fromISO(input, { zone: "utc" });
    if (iso.isValid) return iso.toJSDate();
  }

  return null;
}

/**
 * Parse recurrence rule from both simple format and RRULE format
 * Supports: DAILY, WEEKLY, MONTHLY, QUARTERLY, YEARLY
 * Also accepts RRULE like "FREQ=MONTHLY;INTERVAL=3" and maps to QUARTERLY.
 */
function parseRecurrenceRule(rule: string | null): string | null {
  if (!rule) return null;

  const r = String(rule).trim().toUpperCase();

  // Simple: DAILY/WEEKLY/MONTHLY/QUARTERLY/YEARLY
  if (["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"].includes(r))
    return r;

  // RRULE: e.g. FREQ=MONTHLY;INTERVAL=3 or FREQ=WEEKLY
  if (r.startsWith("FREQ=") || r.includes("FREQ=")) {
    const parts = r.split(";").map((p) => p.trim());
    const freqPart = parts.find((p) => p.startsWith("FREQ="));
    const intervalPart = parts.find((p) => p.startsWith("INTERVAL="));
    const freq = freqPart ? freqPart.replace("FREQ=", "") : null;
    const interval = intervalPart
      ? parseInt(intervalPart.replace("INTERVAL=", ""), 10)
      : NaN;

    if (freq === "MONTHLY" && !isNaN(interval) && interval === 3)
      return "QUARTERLY";
    if (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq ?? ""))
      return freq as string;
  }

  return null;
}

/**
 * Occurrence generator (simple):
 * - DAILY/WEEKLY/MONTHLY/QUARTERLY/YEARLY
 * - ALWAYS deletes existing occurrences first (idempotent for ALL paths)
 * - For non-recurring (or missing end) => upsert exactly one occurrence (index 0)
 * - Steps in Asia/Kolkata to avoid date drift; stores in UTC
 *
 * Also copies task-level assignees to each generated occurrence's join table,
 * and sets legacy assignedToId on occurrences to the first assignee for compatibility.
 */
async function generateTaskOccurrencesSimple(orgPrisma: any, task: any) {
  const freq = parseRecurrenceRule(task.recurrenceRule);
  const stepZone = "Asia/Kolkata";

  const startLocal = DateTime.fromJSDate(task.startDate).setZone(stepZone);
  const dueLocal = DateTime.fromJSDate(task.dueDate).setZone(stepZone);
  const endLocal = task.recurrenceEndDate
    ? DateTime.fromJSDate(task.recurrenceEndDate).setZone(stepZone).endOf("day")
    : null;

  // Preserve through end of CURRENT MONTH in task timezone
  const preserveUntil = DateTime.now()
    .setZone(stepZone)
    .endOf("month")
    .toUTC()
    .toJSDate();

  console.info("generateTaskOccurrencesSimple: start", {
    taskId: task.id,
    freq: parseRecurrenceRule(task.recurrenceRule),
    startDate: task.startDate,
    dueDate: task.dueDate,
    recurrenceEndDate: task.recurrenceEndDate,
    preserveUntil: preserveUntil.toISOString(),
  });

  // Single-upsert for non-recurring or missing end
  if (!endLocal || !freq) {
    await orgPrisma.taskOccurrence.upsert({
      where: {
        taskId_occurrenceIndex: { taskId: task.id, occurrenceIndex: 0 },
      },
      update: {
        title: task.title,
        description: task.description,
        startDate: startLocal.toUTC().toJSDate(),
        dueDate: dueLocal.toUTC().toJSDate(),
        assignedToId: task.assignedToId,
        priority: task.priority,
        remarks: task.remarks,
        status: task.status,
        clientId: task.clientId,
        projectId: task.projectId,
      },
      create: {
        taskId: task.id,
        occurrenceIndex: 0,
        title: task.title,
        description: task.description,
        startDate: startLocal.toUTC().toJSDate(),
        dueDate: dueLocal.toUTC().toJSDate(),
        assignedToId: task.assignedToId,
        priority: task.priority,
        remarks: task.remarks,
        status: task.status,
        clientId: task.clientId,
        projectId: task.projectId,
      },
    });

    await ensureSingleOccurrenceForTask(orgPrisma, task.id);

    await orgPrisma.task.update({
      where: { id: task.id },
      data: { lastGeneratedUntil: task.recurrenceEndDate ?? null },
    });
    return;
  }

  // Build full candidate series (UTC)
  const allStartsUTC: Date[] = [];
  let occurrenceCount = 0;
  while (true) {
    let nextOccurrence: DateTime;
    switch (freq) {
      case "DAILY":
        nextOccurrence = startLocal.plus({ days: occurrenceCount });
        break;
      case "WEEKLY":
        nextOccurrence = startLocal.plus({ weeks: occurrenceCount });
        break;
      case "MONTHLY":
        nextOccurrence = startLocal.plus({ months: occurrenceCount });
        break;
      case "QUARTERLY":
        nextOccurrence = startLocal.plus({ months: occurrenceCount * 3 });
        break;
      case "YEARLY":
        nextOccurrence = startLocal.plus({ years: occurrenceCount });
        break;
      default:
        return;
    }

    if (nextOccurrence > endLocal) break;

    allStartsUTC.push(nextOccurrence.toUTC().toJSDate());
    occurrenceCount++;
    if (occurrenceCount > 5000) {
      console.warn("Breaking recurrence generation at 5000 occurrences");
      break;
    }
  }

  const durationMs = dueLocal.toMillis() - startLocal.toMillis();

  // Transactional update: detect existing occurrences, delete only future ones,
  // create missing preserved ones (current month/past) and future ones (OPEN).
  await orgPrisma.$transaction(async (tx: any) => {
    // fetch existing occurrences for this task
    const existingOccs = await tx.taskOccurrence.findMany({
      where: { taskId: task.id },
      select: {
        id: true,
        startDate: true,
        occurrenceIndex: true,
        status: true,
      },
    });
    const existingMap = new Map<string, any>();
    for (const r of existingOccs)
      existingMap.set(new Date(r.startDate).toISOString(), r);

    const beforeTotal = existingOccs.length;
    const preservedBefore = existingOccs.filter(
      (r: any) => new Date(r.startDate).getTime() <= preserveUntil.getTime()
    ).length;
    console.info(
      `Existing before regen: total=${beforeTotal}, preservedBefore=${preservedBefore}`
    );

    // delete only future occurrences (startDate > preserveUntil)
    const delRes = await tx.taskOccurrence.deleteMany({
      where: { taskId: task.id, startDate: { gt: preserveUntil } },
    });
    const deletedCount = (delRes && (delRes.count ?? delRes)) ?? 0;
    console.info(`Deleted future occurrences: ${deletedCount}`);

    // split candidates into preserved (<= preserveUntil) and future (> preserveUntil)
    const preservedCandidates: Date[] = [];
    const futureCandidates: Date[] = [];
    for (const dt of allStartsUTC) {
      if (dt.getTime() <= preserveUntil.getTime()) preservedCandidates.push(dt);
      else futureCandidates.push(dt);
    }

    // detect preserved candidates missing in DB → create them (inherit task.status)
    const preservedToCreate: any[] = [];
    for (const dt of preservedCandidates) {
      const iso = dt.toISOString();
      if (!existingMap.has(iso)) {
        preservedToCreate.push({
          taskId: task.id,
          title: task.title,
          description: task.description,
          startDate: dt,
          dueDate: new Date(dt.getTime() + durationMs),
          assignedToId: task.assignedToId,
          priority: task.priority,
          remarks: task.remarks,
          status: task.status,
          clientId: task.clientId,
          projectId: task.projectId,
        });
      }
    }

    const preservedCountAfter = preservedCandidates.length;

    // build creation list with correct occurrenceIndex
    const occurrencesToCreate: any[] = [];

    // preserved missing ones: index = position in preservedCandidates
    const preservedIndexMap = new Map<string, number>();
    preservedCandidates.forEach((dt, i) =>
      preservedIndexMap.set(dt.toISOString(), i)
    );
    for (const p of preservedToCreate) {
      const iso = p.startDate.toISOString();
      const idx = preservedIndexMap.get(iso) ?? 0;
      occurrencesToCreate.push({ ...p, occurrenceIndex: idx });
    }

    // future candidates: indices start from preservedCountAfter
    futureCandidates.forEach((dt, i) => {
      occurrencesToCreate.push({
        taskId: task.id,
        title: task.title,
        description: task.description,
        startDate: dt,
        dueDate: new Date(dt.getTime() + durationMs),
        assignedToId: task.assignedToId,
        priority: task.priority,
        remarks: task.remarks,
        status: "OPEN",
        clientId: task.clientId,
        projectId: task.projectId,
        occurrenceIndex: preservedCountAfter + i,
      });
    });

    console.info(
      `Will create preservedMissing=${preservedToCreate.length} future=${futureCandidates.length} total=${occurrencesToCreate.length}`
    );

    if (occurrencesToCreate.length) {
      await tx.taskOccurrence.createMany({
        data: occurrencesToCreate,
        skipDuplicates: true,
      });
    }

    // ---- NEW: ensure every future occurrence (existing or newly created) has status = "OPEN" ----
    await tx.taskOccurrence.updateMany({
      where: { taskId: task.id, startDate: { gt: preserveUntil } },
      data: { status: "OPEN" },
    });

    // copy task-level assignees to newly created occurrences (and set assignedToId)
    try {
      const taskAssignees = await tx.taskAssignee.findMany({
        where: { taskId: task.id },
        select: { userId: true },
      });
      const userIds = taskAssignees.map((a: any) => a.userId);
      if (userIds.length) {
        const allOccsNow = await tx.taskOccurrence.findMany({
          where: { taskId: task.id },
          select: { id: true, startDate: true },
        });

        const allStartSet = new Set(allStartsUTC.map((d) => d.toISOString()));
        const occAssigneeCreate: any[] = [];
        for (const occ of allOccsNow) {
          if (!allStartSet.has(new Date(occ.startDate).toISOString())) continue;
          await tx.taskOccurrence.update({
            where: { id: occ.id },
            data: { assignedToId: userIds[0] },
          });
          for (const uid of userIds)
            occAssigneeCreate.push({ occurrenceId: occ.id, userId: uid });
        }
        if (occAssigneeCreate.length) {
          await tx.taskOccurrenceAssignee.createMany({
            data: occAssigneeCreate,
            skipDuplicates: true,
          });
        }
      }
    } catch (e) {
      console.warn("Failed to copy task assignees to occurrences:", e);
    }

    // update task.lastGeneratedUntil
    await tx.task.update({
      where: { id: task.id },
      data: { lastGeneratedUntil: endLocal.toUTC().toJSDate() },
    });

    const afterTotal = await tx.taskOccurrence.count({
      where: { taskId: task.id },
    });
    const afterPreserved = await tx.taskOccurrence.count({
      where: { taskId: task.id, startDate: { lte: preserveUntil } },
    });
    console.info(`After: total=${afterTotal}, preserved=${afterPreserved}`);
  });
}


/**
 * Auto-generate occurrences for all recurring tasks (background job)
 * Using simple generator; idempotent per task.
 */
export async function generateOccurrencesForAllTasks( 
  req: Request & { user?: any },
  res: Response
) {
  try {
    const orgId = req.user?.orgId;
    if (!orgId) return res.status(400).json({ message: "Org ID required" });

    // Resolve DB clients via DI container
    const orgPrisma = await resolveOrgPrisma(req);

    const recurringTasks = await orgPrisma.task.findMany({
      where: { isRecurring: true, recurrenceEndDate: { not: null } },
    });

    let generatedCount = 0;
    for (const task of recurringTasks) {
      await generateTaskOccurrencesSimple(orgPrisma, task);
      generatedCount++;
    }

    res.json({ message: `Generated occurrences for ${generatedCount} tasks` });
  } catch (err) {
    console.error("generateOccurrencesForAllTasks error:", err);
    res.status(500).json({ message: "Failed to generate occurrences", err });
  }
}

/**
 * Create a task and generate its occurrences (simple recurrence)
 * - caches invalidated after response (fire-and-forget) so clients can re-fetch
 */
export const createTask = [
  uploadTaskFiles,
  requireDocsFeatureIfDocOps,
  async (req: Request & { user?: any }, res: Response) => {
    try {
      const orgId = req.user?.orgId;
      if (!orgId) return res.status(400).json({ message: "Org ID required" });

      const orgPrisma = await resolveOrgPrisma(req);
      const prisma = getCorePrisma();

      const {
        clientId,
        projectId,
        title,
        description,
        startDate,
        dueDate,
        assignedToId, // legacy single (fallback only)
        assignedToIds: rawAssignedToIds,
        priority,
        remarks,
        status,
        recurrenceRule,
        recurrenceEndDate,
        repeatNature, // kept for compatibility
        customValues: rawCustomValues = [],
      } = req.body;

      if (!title || !startDate || !dueDate) {
        return res
          .status(400)
          .json({ message: "title, startDate, dueDate required" });
      }

      const normalizedClientId =
        typeof clientId === "string" && clientId.trim() !== ""
          ? clientId
          : null;
      const normalizedProjectId =
        typeof projectId === "string" && projectId.trim() !== ""
          ? projectId
          : null;
      const normalizedAssignedToId =
        typeof assignedToId === "string" && assignedToId.trim() !== ""
          ? assignedToId
          : null;

      const normalizeAssignedToIds = (v: any): string[] => {
        if (!v) return [];
        if (Array.isArray(v))
          return v
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean);
        if (typeof v === "string") {
          const trimmed = v.trim();
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed))
              return parsed
                .map(String)
                .map((s) => s.trim())
                .filter(Boolean);
          } catch {}
          if (trimmed.includes(","))
            return trimmed
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
          if (trimmed) return [trimmed];
        }
        return [];
      };
      // Prefer multi; fall back to legacy single
      const assignedToIds = normalizeAssignedToIds(
        rawAssignedToIds ?? normalizedAssignedToId
      );

      let customValues = rawCustomValues;
      if (typeof customValues === "string") {
        try {
          customValues = JSON.parse(customValues);
        } catch {
          customValues = [];
        }
      }
      if (!Array.isArray(customValues)) customValues = [];

      let simpleRule: string | null = null;
      if (recurrenceRule) simpleRule = parseRecurrenceRule(recurrenceRule);
      if (!simpleRule && repeatNature)
        simpleRule = parseRecurrenceRule(repeatNature);

      // Upload attachments
      let attachmentKeys: string[] = [];
      if (req.files && Array.isArray(req.files)) {
        attachmentKeys = await Promise.all(
          (req.files as any[]).map((file: any) =>
            uploadFileToSpaces(file, req.user.orgId)
          )
        );
      }

      // in createTask controller (before create)
      if (req.user.role === "MANAGER") {
        const projectId = req.body.projectId;
        if (!projectId)
          return res.status(400).json({ message: "projectId required" });

        const project = await orgPrisma.project.findUnique({
          where: { id: projectId },
          select: { head: true },
        });
        if (!project || project.head !== req.user.id) {
          return res.status(403).json({
            message: "Managers can only create under projects they head",
          });
        }
      }

      // Create Task (no task-level assignees; no task.assignedToId)
      const createdTask = await orgPrisma.task.create({
        data: {
          clientId: normalizedClientId,
          projectId: normalizedProjectId,
          title,
          description,
          startDate: DateTime.fromISO(startDate, { zone: "utc" }).toJSDate(),
          dueDate: DateTime.fromISO(dueDate, { zone: "utc" }).toJSDate(),
          assignedToId: null, // occurrence-only
          priority,
          remarks,
          status,
          recurrenceRule: simpleRule,
          recurrenceEndDate: recurrenceEndDate
            ? DateTime.fromISO(recurrenceEndDate, { zone: "utc" }).toJSDate()
            : null,
          isRecurring: !!simpleRule,
          createdById: req.user.id,
          attachments: {
            createMany: { data: attachmentKeys.map((key) => ({ key })) },
          },
          customValues: {
            create: customValues.map((cv: any) => ({
              fieldId: cv.fieldId,
              value: cv.value,
            })),
          },
        },
        include: {
          attachments: true,
          customValues: { include: { field: true } },
        },
      });

      // Generate occurrences
      await generateTaskOccurrencesSimple(orgPrisma, createdTask);

      // --- after: await generateTaskOccurrencesSimple(orgPrisma, createdTask);

      if (assignedToIds.length > 0) {
        // fetch new occurrence ids for this task
        const occs = await orgPrisma.taskOccurrence.findMany({
          where: { taskId: createdTask.id },
          select: { id: true },
        });
        const occIds = occs.map((o: any) => o.id);

        if (occIds.length) {
          await orgPrisma.$transaction(async (tx: any) => {
            // (Optional) if you want to mirror the “other methods” exactly and ensure clean state:
            // Clear any pre-seeded rows (usually none on fresh create, but safe)
            await tx.taskOccurrenceAssignee.deleteMany({
              where: { occurrenceId: { in: occIds } },
            });

            // Insert join rows for every occurrence × user
            const rows = occIds.flatMap((occId: any) =>
              assignedToIds.map((userId) => ({ occurrenceId: occId, userId }))
            );

            if (rows.length) {
              await tx.taskOccurrenceAssignee.createMany({
                data: rows,
                skipDuplicates: true, // keep idempotent like your bulk methods
              });
            }

            // (Optional) keep the scalar pointer in sync if you still use it anywhere in UI:
            // If you want *strictly* join-table only, remove this block.
            await tx.taskOccurrence.updateMany({
              where: { id: { in: occIds } },
              data: { assignedToId: assignedToIds[0] ?? null },
            });
          });
        }
      } else {
        // No assignees provided → ensure there are no lingering join rows (safety)
        const occs = await orgPrisma.taskOccurrence.findMany({
          where: { taskId: createdTask.id },
          select: { id: true },
        });
        const occIds = occs.map((o: any) => o.id);
        if (occIds.length) {
          await orgPrisma.$transaction(async (tx: any) => {
            await tx.taskOccurrenceAssignee.deleteMany({
              where: { occurrenceId: { in: occIds } },
            });
            // (Optional) keep scalar cleared if you use it
            await tx.taskOccurrence.updateMany({
              where: { id: { in: occIds } },
              data: { assignedToId: null },
            });
          });
        }
      }

      // Seed occurrence-level assignees
      if (assignedToIds.length > 0) {
        try {
          const occs = await orgPrisma.taskOccurrence.findMany({
            where: { taskId: createdTask.id },
            select: { id: true },
          });

          const occIds = occs.map((o: any) => o.id);
          if (occIds.length > 0) {
            await orgPrisma.$transaction(async (tx: any) => {
              // Optional scalar primary assignee (keep if your UI needs it)
              await tx.taskOccurrence.updateMany({
                where: { id: { in: occIds } },
                data: { assignedToId: assignedToIds[0] ?? null },
              });

              // Create occurrence-level join rows
              const createPayload: Array<{
                occurrenceId: string;
                userId: string;
              }> = [];
              for (const occId of occIds) {
                for (const userId of assignedToIds)
                  createPayload.push({ occurrenceId: occId, userId });
              }

              const CHUNK = 500;
              for (let i = 0; i < createPayload.length; i += CHUNK) {
                const chunk = createPayload.slice(i, i + CHUNK);
                await tx.taskOccurrenceAssignee.createMany({
                  data: chunk,
                  skipDuplicates: true,
                });
              }
            });
          }
        } catch (err) {
          console.warn("Failed to seed occurrence assignees:", err);
        }
      }

      // Attachments signed URLs
      const attachmentsWithUrls = await Promise.all(
        createdTask.attachments.map(async (att: any) => ({
          id: att.id,
          key: att.key,
          url: await getCachedFileUrlFromSpaces(att.key, req.user.orgId),
        }))
      );

      // Respond
      res.status(201).json({
        ...createdTask,
        attachments: attachmentsWithUrls,
        taskId: createdTask.id,
      });

      // Realtime notifications to each assignee (best-effort)
      // (async () => {
      //   for (const uid of assignedToIds) {
      //     try {
      //       await notifyCounterparties({
      //         orgPrisma,
      //         corePrisma: getCorePrisma(),
      //         io: (req as any).io,
      //         orgId: String(req.user.orgId),
      //         actor: { id: String(req.user.id), role: req.user.role },
      //         assignedToId: createdTask.assignedToId ?? null, // if your task has one
      //         payload: {
      //           type: "TASK_CREATED",
      //           title: "Task created",
      //           body: `${req.user.name ?? "Someone"} created “${
      //             createdTask.title
      //           }”`,
      //           taskId: String(createdTask.id),
      //           projectId: createdTask.projectId ? String(createdTask.projectId) : undefined,
      //         },
      //       });
      //     } catch (e) {
      //       console.warn("notifyCounterparties failed for", uid, e);
      //     }
      //   }
      // })();

      // Broadcast
      req.io.to(`org:${orgId}`).emit("task:created", {
        orgId,
        task: {
          id: createdTask.id,
          title: createdTask.title,
          status: createdTask.status,
          priority: createdTask.priority,
          clientId: createdTask.clientId,
          projectId: createdTask.projectId,
          startDate: createdTask.startDate,
          dueDate: createdTask.dueDate,
          remarks: createdTask.remarks,
        },
      });

      // After creating task and occurrences
      const taskWithAssignees = await orgPrisma.taskOccurrence.findFirst({
        where: { taskId: createdTask.id },
        select: {
          id: true,
          projectId: true,
          assignees: { select: { userId: true } },
        },
      });

      await notifyCounterparties({
        orgPrisma,
        corePrisma: getCorePrisma(),
        io: req.io,
        orgId: String(req.user.orgId),
        actor: { id: String(req.user.id), role: req.user.role },
        assigneeIds: (taskWithAssignees?.assignees ?? []).map((a: any) =>
          String(a.userId)
        ),
        payload: {
          type: "TASK_CREATED",
          title: "Task created",
          body: `${req.user.name ?? "Someone"} created "${createdTask.title}"`,
          taskId: String(createdTask.id),
          projectId: taskWithAssignees?.projectId
            ? String(taskWithAssignees.projectId)
            : undefined,
        },
      });
    } catch (err) {
      console.error("createTask error:", err);
      res.status(500).json({ message: "Failed to create task", err });
    }
  },
];

// ---------- helpers ----------
/** Parse a list param, ignoring 'all' (case-insensitive). Returns undefined if empty. */
function toList(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  const arr = (Array.isArray(v) ? v : String(v).split(","))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .filter((s) => s.toLowerCase() !== "all");
  return arr.length ? arr : undefined;
}

/** base64url encode/decode for keyset cursor { sd, id } */
function encodeCursor(d: { sd: string; id: string }): string {
  return Buffer.from(JSON.stringify(d)).toString("base64url");
}
function decodeCursor(s?: string): { sd: string; id: string } | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return typeof obj?.sd === "string" && typeof obj?.id === "string"
      ? obj
      : null;
  } catch {
    return null;
  }
}


export async function listTaskOccurrences(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const orgPrisma = await resolveOrgPrisma(req);

    const {
      start,
      end,
      projectId,
      assignedTo,
      status,
      priority,
      clientId,
      managerId,
      q,
      limit,
      nextCursor,
      durationMin,
      durationMax,
    } = req.query as Record<string, string | undefined>;

    /* ---------------------------------------------------
       1. HARD RULE: projectId is mandatory
    --------------------------------------------------- */
    const projectVals = toList(projectId);
    if (!projectVals?.length) {
      return res.status(400).json({
        message: "projectId is required for task list view",
      });
    }

    /* ---------------------------------------------------
       2. DATE WINDOW (DEFAULT = CURRENT MONTH)
    --------------------------------------------------- */
    const hasStart = !!start?.trim();
    const hasEnd = !!end?.trim();

    let windowStart: Date;
    let windowEnd: Date;

    if (hasStart && hasEnd) {
      windowStart = DateTime.fromISO(start!, { zone: "utc" })
        .startOf("day")
        .toJSDate();
      windowEnd = DateTime.fromISO(end!, { zone: "utc" })
        .endOf("day")
        .toJSDate();
    } else {
      const now = DateTime.utc();
      windowStart = now.startOf("month").toJSDate();
      windowEnd = now.endOf("month").toJSDate();
    }

    /* ---------------------------------------------------
       3. WHERE CLAUSE
    --------------------------------------------------- */
    const AND: any[] = [
      {
        OR: [
          { projectId: { in: projectVals } },
          { task: { projectId: { in: projectVals } } },
        ],
      },
    ];

    const hasDuration = durationMin || durationMax;
    const todayUTC = DateTime.utc().startOf("day");
    const isOverdue =
      (durationMin && Number(durationMin) < 0) ||
      (durationMax && Number(durationMax) < 0);

    /* ---------- Duration (DUE IN X–Y DAYS FROM TODAY) ---------- */
    if (hasDuration) {
      const min = durationMin != null ? Number(durationMin) : undefined;
      const max = durationMax != null ? Number(durationMax) : undefined;

      // 🔥 OVERDUE CASE
      if ((min != null && min < 0) || (max != null && max < 0)) {
        AND.push({
          dueDate: {
            lt: todayUTC.toJSDate(),
            gte: windowStart,
          },
        });
      } else {
        // upcoming / today
        AND.push({
          dueDate: {
            gte: todayUTC.toJSDate(),
          },
        });

        if (min != null) {
          AND.push({
            dueDate: {
              gte: todayUTC.plus({ days: min }).toJSDate(),
            },
          });
        }

        if (max != null) {
          AND.push({
            dueDate: {
              lte: todayUTC.plus({ days: max }).toJSDate(),
            },
          });
        }
      }
    } else {
      // normal month overlap
      AND.push({ startDate: { lte: windowEnd } });
      AND.push({ dueDate: { gte: windowStart } });
    }

    /* ---------- Status ---------- */
    const VALID_STATUSES = [
      "OPEN",
      "IN_PROGRESS",
      "ON_TRACK",
      "DELAYED",
      "IN_TESTING",
      "ON_HOLD",
      "APPROVED",
      "PLANNING",
      "COMPLETED",
      "CANCELLED",
    ] as const;

    const requestedStatuses = toList(status)
      ?.map((s) => s.toUpperCase())
      .filter((s) => VALID_STATUSES.includes(s as any));

    if (requestedStatuses?.length) {
      AND.push({ status: { in: requestedStatuses } });
    } else {
      AND.push({ NOT: { status: { in: ["COMPLETED", "CANCELLED"] } } });
    }

    /* ---------- Priority ---------- */
    const priorityVals = toList(priority);
    if (priorityVals?.length) {
      AND.push({
        priority: { in: priorityVals.map((p) => p.toUpperCase()) },
      });
    }

    /* ---------- Assignee ---------- */
    const assignedVals = toList(assignedTo);
    if (assignedVals?.length) {
      AND.push({
        OR: [
          { assignedToId: { in: assignedVals } },
          { assignees: { some: { userId: { in: assignedVals } } } },
          { task: { assignees: { some: { userId: { in: assignedVals } } } } },
        ],
      });
    }

    /* ---------- Client ---------- */
    const clientVals = toList(clientId);
    if (clientVals?.length) {
      AND.push({
        OR: [
          { clientId: { in: clientVals } },
          { task: { clientId: { in: clientVals } } },
        ],
      });
    }

    /* ---------- Manager ---------- */
    const managerVals = toList(managerId);
    if (managerVals?.length) {
      AND.push({
        task: { project: { head: { in: managerVals } } },
      });
    }

    /* ---------- Search ---------- */
    if (q?.trim()) {
      AND.push({
        OR: [
          { title: { contains: q.trim(), mode: "insensitive" } },
          { remarks: { contains: q.trim(), mode: "insensitive" } },
          { task: { title: { contains: q.trim(), mode: "insensitive" } } },
        ],
      });
    }

    /* ---------- Role Guard ---------- */
    const user = req.user;
    if (user?.role === "MANAGER") {
      AND.push({ task: { project: { head: user.id } } });
    }

    /* ---------------------------------------------------
       4. PAGINATION
    --------------------------------------------------- */
    const take = Math.min(100, Math.max(1, Number(limit) || 50));

    const cursor = decodeCursor(nextCursor);
    if (cursor) {
      const sd = DateTime.fromISO(cursor.sd, { zone: "utc" });
      if (sd.isValid) {
        AND.push({
          OR: isOverdue
            ? [
              { dueDate: { lt: sd.toJSDate() } },
              {
                AND: [
                  { dueDate: { equals: sd.toJSDate() } },
                  { id: { gt: cursor.id } },
                ],
              },
            ]
            : [
              { dueDate: { gt: sd.toJSDate() } },
              {
                AND: [
                  { dueDate: { equals: sd.toJSDate() } },
                  { id: { gt: cursor.id } },
                ],
              },
            ],
        });
      }
    }

    /* ---------------------------------------------------
       5. QUERY
    --------------------------------------------------- */
    const rows = await orgPrisma.taskOccurrence.findMany({
      where: { AND },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        startDate: true,
        dueDate: true,
        remarks: true,
        projectId: true,
        clientId: true,
        assignedToId: true,
        sequentialId: true,
        assignees: { select: { userId: true } },
        task: {
          select: {
            id: true,
            title: true,
            projectId: true,
            clientId: true,
            assignees: { select: { userId: true } },
            recurrenceRule: true,
            recurrenceEndDate: true,
          },
        },
      },
    });

    /* ---------------------------------------------------
       6. RESPONSE SHAPE
    --------------------------------------------------- */
    const occurrences = rows.map((occ: any) => {
      const occAssignees = occ.assignees.map((a: any) => a.userId);
      const taskAssignees = occ.task?.assignees.map((a: any) => a.userId) || [];

      return {
        id: occ.id,
        title: occ.title,
        status: occ.status,
        priority: occ.priority,
        remarks: occ.remarks,
        projectId: occ.projectId,
        clientId: occ.clientId,
        occurrenceStart: occ.startDate,
        occurrenceDue: occ.dueDate,
        assignedToIds: occAssignees,
        recurrenceRule: occ.recurrenceRule ?? null,
        assignedToId: occ.assignedToId ?? taskAssignees[0] ?? null,
        task: occ.task
          ? {
              ...occ.task,
              recurrenceRule: occ.task.recurrenceRule ?? null, // ✅ IMPORTANT
            }
          : null,
        sequentialId: occ.sequentialId,
      };
    });

    const last = rows[rows.length - 1];
    const next =
      last && last.dueDate
        ? encodeCursor({
            sd: DateTime.fromJSDate(last.dueDate).toUTC().toISO()!,
            id: String(last.id),
          })
        : null;

    res.json({
      occurrences,
      window: { start: windowStart, end: windowEnd },
      pagination: { take, nextCursor: next, count: occurrences.length },
    });
  } catch (err) {
    console.error("listTaskOccurrences error:", err);
    res.status(500).json({ message: "Failed to list task occurrences" });
  }
}

export async function taskProjectSummary(
  req: Request & { user?: any },
  res: Response
) {
  const orgPrisma = await resolveOrgPrisma(req);

  const {
    start,
    end,
    status,
    priority,
    assignedTo,
    managerId,
    q,
    durationMin,
    durationMax,
  } = req.query as Record<string, string | undefined>;

  const AND: any[] = [];
  const todayUTC = DateTime.utc().startOf("day");
  const windowStart = start
    ? DateTime.fromISO(start).startOf("day").toJSDate()
    : DateTime.utc().startOf("month").toJSDate();

  const windowEnd = end
    ? DateTime.fromISO(end).endOf("day").toJSDate()
    : DateTime.utc().endOf("month").toJSDate();


  /* ---------- DATE / DURATION ---------- */
  /* ---------- DATE / DURATION ---------- */
  if (durationMin || durationMax) {
    const min = durationMin != null ? Number(durationMin) : undefined;
    const max = durationMax != null ? Number(durationMax) : undefined;

    // 🔥 OVERDUE TASKS
    if ((min != null && min < 0) || (max != null && max < 0)) {
      AND.push({
        dueDate: {
          lt: todayUTC.toJSDate(),
          gte: windowStart,
        },
      });

    } else {
      // Upcoming / today tasks
      AND.push({
        dueDate: {
          gte: todayUTC.toJSDate(),
        },
      });

      if (min != null) {
        AND.push({
          dueDate: {
            gte: todayUTC.plus({ days: min }).toJSDate(),
          },
        });
      }

      if (max != null) {
        AND.push({
          dueDate: {
            lte: todayUTC.plus({ days: max }).toJSDate(),
          },
        });
      }
    }
  } else {
    const ws = start
      ? DateTime.fromISO(start).startOf("day")
      : DateTime.utc().startOf("month");

    const we = end
      ? DateTime.fromISO(end).endOf("day")
      : DateTime.utc().endOf("month");

    AND.push({ startDate: { lte: we.toJSDate() } });
    AND.push({ dueDate: { gte: ws.toJSDate() } });
  }

  /* ---------- Filters ---------- */
  if (status) AND.push({ status: { in: toList(status) } });
  else AND.push({ NOT: { status: { in: ["COMPLETED", "CANCELLED"] } } });

  if (priority) AND.push({ priority: { in: toList(priority) } });

  const assignedVals = toList(assignedTo);
  if (assignedVals?.length) {
    AND.push({
      OR: [
        { assignedToId: { in: assignedVals } },
        { assignees: { some: { userId: { in: assignedVals } } } },
        { task: { assignees: { some: { userId: { in: assignedVals } } } } },
      ],
    });
  }

  const managerVals = toList(managerId);
  if (managerVals?.length) {
    AND.push({
      task: {
        project: {
          head: { in: managerVals },
        },
      },
    });
  }

  if (q?.trim()) {
    AND.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { remarks: { contains: q, mode: "insensitive" } },
        { task: { title: { contains: q, mode: "insensitive" } } },
      ],
    });
  }

  if (req.user?.role === "MANAGER") {
    AND.push({
      task: {
        project: {
          head: req.user.id,
        },
      },
    });
  }

  /* ---------- GROUP ---------- */
  const rows = await orgPrisma.taskOccurrence.groupBy({
    by: ["projectId"],
    where: { AND },
    _count: { _all: true },
  });

  if (!rows.length) return res.json([]);

  const projects = await orgPrisma.project.findMany({
    where: { id: { in: rows.map((r: any) => r.projectId).filter(Boolean) } },
    select: { id: true, name: true },
  });

  const map = new Map(projects.map((p: any) => [p.id, p.name]));

  res.json(
    rows.map((r: any) => ({
      projectId: r.projectId ?? "general",
      projectName: map.get(r.projectId!) ?? "General",
      count: r._count._all,
    }))
  );
}

export async function listMyTaskOccurrences(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const orgPrisma = await resolveOrgPrisma(req);

    const { start, end, status, q, limit, durationMin, durationMax } =
      req.query as Record<string, string | undefined>;

    /* ---------------------------------------------------
       1. DATE WINDOW (optional, overlaps)
    --------------------------------------------------- */
    let windowStart: Date | undefined;
    let windowEnd: Date | undefined;

    if (start && end) {
      windowStart = new Date(new Date(start).setHours(0, 0, 0, 0));
      windowEnd = new Date(new Date(end).setHours(23, 59, 59, 999));
    }

    /* ---------------------------------------------------
       2. BASE WHERE
    --------------------------------------------------- */
    const AND: any[] = [];

    // Assigned to current user (occurrence OR task)
    AND.push({
      OR: [
        { assignedToId: user.id },
        { assignees: { some: { userId: user.id } } },
        { task: { assignees: { some: { userId: user.id } } } },
      ],
    });

const hasDuration = durationMin || durationMax;

    if (!hasDuration && windowStart && windowEnd) {
      AND.push({ startDate: { lte: windowEnd } });
      AND.push({ dueDate: { gte: windowStart } });
    }

    // Status
    if (status) {
      AND.push({ status: status.toUpperCase() });
    } else {
      AND.push({
        NOT: { status: { in: ["COMPLETED", "CANCELLED"] } },
      });
    }

    // Search
    if (q?.trim()) {
      AND.push({
        OR: [
          { title: { contains: q.trim(), mode: "insensitive" } },
          { remarks: { contains: q.trim(), mode: "insensitive" } },
          { task: { title: { contains: q.trim(), mode: "insensitive" } } },
        ],
      });
    }

    /* ---------------------------------------------------
   3. DURATION FILTER (DB LEVEL – FIXED)
--------------------------------------------------- */
    if (durationMin || durationMax) {
      const todayUTC = new Date();
      todayUTC.setHours(0, 0, 0, 0);

      const min = durationMin != null ? Number(durationMin) : undefined;
      const max = durationMax != null ? Number(durationMax) : undefined;

      // 🔥 OVERDUE CASE
      if ((min != null && min < 0) || (max != null && max < 0)) {
        AND.push({
          dueDate: {
            lt: todayUTC,
            gte: windowStart ?? todayUTC,
          },
        });
      } else {
        // Upcoming / today
        AND.push({
          dueDate: {
            gte: todayUTC,
          },
        });

        if (min != null) {
          const minDate = new Date(todayUTC);
          minDate.setDate(minDate.getDate() + min);
          AND.push({ dueDate: { gte: minDate } });
        }

        if (max != null) {
          const maxDate = new Date(todayUTC);
          maxDate.setDate(maxDate.getDate() + max);
          AND.push({ dueDate: { lte: maxDate } });
        }
      }
    }

    /* ---------------------------------------------------
       4. QUERY
    --------------------------------------------------- */
    const rows = await orgPrisma.taskOccurrence.findMany({
      where: { AND },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: Math.min(500, Number(limit) || 200),
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        startDate: true,
        dueDate: true,
        remarks: true,
        projectId: true,
        clientId: true,
        assignedToId: true,
        assignees: { select: { userId: true } },
        task: {
          select: {
            id: true,
            title: true,
            projectId: true,
            clientId: true,
            assignees: { select: { userId: true } },
          },
        },
      },
    });

    /* ---------------------------------------------------
       5. SHAPE RESPONSE
    --------------------------------------------------- */
    const occurrences = rows.map((r: any) => ({
      ...r,
      occurrenceStart: r.startDate,
      occurrenceDue: r.dueDate,
      assignedToIds: Array.from(
        new Set([
          ...(r.assignees?.map((a: any) => a.userId) ?? []),
          ...(r.task?.assignees?.map((a: any) => a.userId) ?? []),
        ])
      ),
      projectId: r.projectId ?? r.task?.projectId ?? null,
      clientId: r.clientId ?? r.task?.clientId ?? null,
    }));

    res.json({
      occurrences,
      meta: {
        durationMin: durationMin ?? null,
        durationMax: durationMax ?? null,
      },
    });
  } catch (err) {
    console.error("listMyTaskOccurrences error", err);
    res.status(500).json({ message: "Failed to load my tasks" });
  }
}

type TaskStatusKey = keyof typeof TaskStatus;

type KanbanColumnConfig = {
  title: string;
  color: string;
  order: number;
  hidden?: boolean;
};

const KANBAN_WORKFLOW: Record<TaskStatusKey, KanbanColumnConfig> = {
  OPEN: { title: "Open", color: "emerald", order: 1 },
  PLANNING: { title: "Planning", color: "cyan", order: 2 },
  IN_PROGRESS: { title: "In Progress", color: "amber", order: 3 },
  ON_TRACK: { title: "On Track", color: "blue", order: 4 },
  IN_TESTING: { title: "In Testing", color: "purple", order: 5 },
  APPROVED: { title: "Approved", color: "indigo", order: 6 },
  DELAYED: { title: "Delayed", color: "rose", order: 7 },
  ON_HOLD: { title: "On Hold", color: "gray", order: 8 },
  COMPLETED: { title: "Completed", color: "green", order: 9 },
  CANCELLED: { title: "Cancelled", color: "slate", order: 10, hidden: true },
};


function resolveStatus(task: { status: TaskStatus }): TaskStatusKey {
  return TaskStatus[task.status] as TaskStatusKey;
}

// GET /api/kanban/columns
export function getKanbanColumns(req: any, res: any) {
  const columns = Object.entries(KANBAN_WORKFLOW)
    .filter(([, c]) => !c.hidden)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id, c]) => ({
      id,
      title: c.title,
      color: c.color,
    }));

  res.json({ columns });
}


// GET /api/kanban/tasks
// ?status=OPEN&cursor=...&limit=30
export async function getKanbanTasks(req: any, res: any) {
  const { status, cursor, limit = 30 } = req.query;
  const orgPrisma = await resolveOrgPrisma(req);

  const rows = await orgPrisma.taskOccurrence.findMany({
    where: {
      status,
      NOT: { status: "CANCELLED" },
    },
    orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    take: Number(limit),
    ...(cursor && {
      skip: 1,
      cursor: { id: cursor },
    }),
  });

  const nextCursor = rows.at(-1)?.id ?? null;

  res.json({
    tasks: rows,
    nextCursor,
  });
}



/**
 * Complete a specific occurrence
 */
export async function completeOccurrence(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const occurrenceId = req.params.id;
    const { completedBy, note } = req.body;

    const orgPrisma = await resolveOrgPrisma(req);
    const prisma = await getCorePrisma();

    // Permission
    const canEdit = await canEmployeeEditOccurrence(
      orgPrisma,
      prisma,
      req,
      occurrenceId
    );
    if (!canEdit) {
      return res
        .status(403)
        .json({ message: "You are not allowed to complete this occurrence" });
    }

    const updated = await orgPrisma.taskOccurrence.update({
      where: { id: occurrenceId },
      data: {
        isCompleted: true,
        completedAt: new Date(),
        completedBy: completedBy ?? req.user.id,
        completionNote: note,
        status: "COMPLETED",
      },
    });

    res.json({ ok: true, occurrence: updated });

    // Fire-and-forget cache invalidation so clients re-fetch fresh data
    // await invalidateOrgCaches(req.user.orgId).catch((e) =>
    //   console.warn("invalidateOrgCaches failed", e)
    // );

    // notify using legacy assignedToId (backwards-compatible)
    if (updated.assignedToId) {
      await notifyCounterparties({
        orgPrisma,
        corePrisma: prisma,
        io: req.io,
        orgId: req.user.orgId,
        actor: { id: req.user.id, role: req.user.role },
        assignedToId: updated.assignedToId ?? null,
        payload: {
          type: "OCCURRENCE_COMPLETED",
          title: "Task completed",
          body: `“${updated.title ?? "Untitled"}” marked complete.`,
          taskId: updated.taskId,
          occurrenceId: updated.id,
        },
      });
    }

    const orgId = req.user.orgId;
    req.io.to(`org:${orgId}`).emit("occurrence:completed", {
      orgId,
      occurrence: {
        id: updated.id,
        taskId: updated.taskId,
        // core + routing + detail fields
        title: updated.title,
        description: updated.description,
        remarks: updated.remarks,
        status: updated.status, // "COMPLETED"
        isCompleted: updated.isCompleted ?? true,
        completedAt: updated.completedAt,
        assignedToId: updated.assignedToId,
        priority: updated.priority,
        clientId: updated.clientId,
        projectId: updated.projectId,
        startDate: updated.startDate,
        dueDate: updated.dueDate,
      },
    });
  } catch (err) {
    console.error("completeOccurrence error:", err);
    res.status(500).json({ message: "Failed to mark complete", err });
  }
}

/**
 * Update a specific occurrence - guarded + with attachment scope safety
 */
export const updateOccurrence = [
  uploadTaskFiles,
  requireDocsFeatureIfDocOps,
  async (req: Request & { user?: any }, res: Response) => {
    try {
      const occurrenceId = req.params.id;
      const {
        title,
        description,
        startDate,
        dueDate,
        assignedToId,
        assignedToIds: rawAssignedToIds,
        priority,
        remarks,
        status,
        customValues = [],
      } = req.body;

      const orgPrisma = await resolveOrgPrisma(req);
      const prisma = await getCorePrisma();

      // Permission
      const canEdit = await canEmployeeEditOccurrence(
        orgPrisma,
        prisma,
        req,
        occurrenceId
      );
      if (!canEdit) {
        return res
          .status(403)
          .json({ message: "You are not allowed to edit this occurrence" });
      }

      // normalize assignedToIds for occurrence-level update
      // return type: string[] | undefined
      const normalizeAssignedToIds = (v: any): string[] | undefined => {
        if (v === undefined || v === null) return undefined; // <--- important: undefined = "not provided"
        if (Array.isArray(v)) return v.map(String).filter(Boolean);
        if (typeof v === "string") {
          const trimmed = v.trim();
          // try parse JSON
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed))
              return parsed.map(String).filter(Boolean);
          } catch {}
          // CSV fallback
          if (trimmed.includes(","))
            return trimmed
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
          if (trimmed) return [trimmed];
          return []; // empty string -> explicit empty array (client sent "")
        }
        return undefined;
      };

      // previously: normalize(rawAssignedToIds ?? assignedToId)
      // now: prefer the raw param if provided, else undefined
      const assignedToIdsNew = normalizeAssignedToIds(
        rawAssignedToIds !== undefined
          ? rawAssignedToIds
          : assignedToId !== undefined
          ? assignedToId
          : undefined
      );

      let parsedCustomValues: any[] = [];
      if (typeof customValues === "string") {
        try {
          parsedCustomValues = JSON.parse(customValues);
        } catch {
          parsedCustomValues = [];
        }
      } else if (Array.isArray(customValues)) {
        parsedCustomValues = customValues;
      }

      const beforeUpdate = await orgPrisma.taskOccurrence.findUnique({
        where: { id: occurrenceId },
        include: {
          attachments: true,
          task: {
            include: {
              attachments: true,
              assignees: { select: { userId: true } },
            },
          },
          assignees: { select: { userId: true } },
        },
      });

      if (!beforeUpdate) {
        return res.status(404).json({ message: "Occurrence not found" });
      }

      // Parse attachments to remove for THIS OCCURRENCE ONLY
      let occurrenceAttachmentsToRemove: string[] = [];
      if (req.body.attachmentsToRemove) {
        try {
          const parsed = JSON.parse(req.body.attachmentsToRemove);
          if (Array.isArray(parsed))
            occurrenceAttachmentsToRemove = parsed.map(String);
        } catch (parseError) {
          console.error("Failed to parse attachmentsToRemove:", parseError);
        }
      }

      // Only delete attachments that belong to THIS OCCURRENCE
      if (occurrenceAttachmentsToRemove.length > 0) {
        for (const attachmentId of occurrenceAttachmentsToRemove) {
          const attachment = await orgPrisma.taskOccurrenceAttachment.findFirst(
            {
              where: { id: attachmentId, occurrenceId },
            }
          );

          if (attachment) {
            try {
              await deleteFileFromSpaces(attachment.key);
              await orgPrisma.taskOccurrenceAttachment.delete({
                where: { id: attachmentId },
              });
            } catch (deleteError) {
              console.error(
                `Failed to delete attachment ${attachmentId}:`,
                deleteError
              );
            }
          }
        }
      }

      // Add new attachments to THIS OCCURRENCE ONLY
      let newAttachmentKeys: string[] = [];
      if (req.files && Array.isArray(req.files)) {
        newAttachmentKeys = await Promise.all(
          (req.files as any[]).map(async (file: any) =>
            uploadFileToSpaces(file, req.user.orgId)
          )
        );

        if (newAttachmentKeys.length) {
          await orgPrisma.taskOccurrenceAttachment.createMany({
            data: newAttachmentKeys.map((key) => ({ key, occurrenceId })),
          });
        }
      }

      // Update the occurrence data
      // Update the occurrence data
      const updated = await orgPrisma.taskOccurrence.update({
        where: { id: occurrenceId },
        data: {
          title,
          description,
          startDate: startDate
            ? DateTime.fromISO(startDate, { zone: "utc" }).toJSDate()
            : undefined,
          dueDate: dueDate
            ? DateTime.fromISO(dueDate, { zone: "utc" }).toJSDate()
            : undefined,
          assignedToId:
            assignedToIdsNew && assignedToIdsNew.length > 0
              ? assignedToIdsNew[0]
              : assignedToId ?? undefined,
          priority,
          remarks,
          status,
        },
        include: {
          attachments: true, // occurrence-specific
          task: {
            include: {
              attachments: true,
              customValues: { include: { field: true } },
              assignees: { select: { userId: true } },
            }, // task-level
          },
          assignees: { select: { userId: true } },
        },
      });

      // if assignedToIds passed, update occurrence assignee join rows
      if (assignedToIdsNew !== undefined) {
        // delete existing occurrence assignees and recreate
        await orgPrisma.taskOccurrenceAssignee.deleteMany({
          where: { occurrenceId },
        });
        if (assignedToIdsNew.length) {
          await orgPrisma.taskOccurrenceAssignee.createMany({
            data: assignedToIdsNew.map((uid) => ({
              occurrenceId,
              userId: uid,
            })),
            skipDuplicates: true,
          });
        }
      }

      if (parsedCustomValues.length > 0) {
        await orgPrisma.task.update({
          where: { id: updated.taskId },
          data: {
            customValues: {
              deleteMany: {}, // clear existing
              create: parsedCustomValues.map((cv) => ({
                fieldId: cv.fieldId,
                value: cv.value,
              })),
            },
          },
        });
      }

      const finalTask = await orgPrisma.task.findUnique({
        where: { id: updated.taskId },
        include: {
          customValues: { include: { field: true } },
          assignees: { select: { userId: true } },
        },
      });

      // Normalize custom values for client
      const normalizedCustomValues =
        finalTask?.customValues.map((cv: any) => ({
          id: cv.id,
          fieldId: cv.fieldId,
          fieldName: cv.field?.name,
          type: cv.field?.type,
          value: cv.value,
        })) ?? [];

      // Process occurrence-specific attachments with URLs
      const occurrenceAttachmentsWithUrls = await Promise.all(
        updated.attachments.map(async (att: any) => ({
          id: att.id,
          key: att.key,
          url: await getCachedFileUrlFromSpaces(att.key, req.user.orgId),
          type: "occurrence",
          source: "occurrence_specific",
        }))
      );

      // Process task-level attachments with URLs
      const taskAttachmentsWithUrls = await Promise.all(
        updated.task.attachments.map(async (att: any) => ({
          id: att.id,
          key: att.key,
          url: await getCachedFileUrlFromSpaces(att.key, req.user.orgId),
          type: "task",
          source: "task_level",
        }))
      );

      res.json({
        ...updated,
        attachments: occurrenceAttachmentsWithUrls, // ONLY occurrence-specific
        taskAttachments: taskAttachmentsWithUrls,
        customValues: normalizedCustomValues, // Task-level (shared)
        assignedToIds: (
          await orgPrisma.taskOccurrenceAssignee.findMany({
            where: { occurrenceId },
            select: { userId: true },
          })
        ).map((r: any) => r.userId),
        taskAssignedToIds:
          finalTask?.assignees?.map((a: any) => a.userId) ?? [],
        debug: {
          occurrenceId,
          removedCount: occurrenceAttachmentsToRemove.length,
          addedCount: newAttachmentKeys.length,
          finalOccurrenceAttachments: occurrenceAttachmentsWithUrls.length,
          finalTaskAttachments: taskAttachmentsWithUrls.length,
        },
      });

      // Fire-and-forget cache invalidation so clients re-fetch fresh data.
      // await invalidateOrgCaches(req.user.orgId).catch((e) =>
      //   console.warn("invalidateOrgCaches failed", e)
      // );

      // After updating occurrence
      // ✅ Updated: Fetch assignees and pass to notification
      const occurrenceAssignees =
        await orgPrisma.taskOccurrenceAssignee.findMany({
          where: { occurrenceId },
          select: { userId: true },
        });

      await notifyCounterparties({
        orgPrisma,
        corePrisma: prisma,
        io: req.io,
        orgId: req.user.orgId,
        actor: { id: req.user.id, role: req.user.role },
        assigneeIds: occurrenceAssignees.map((a: any) => a.userId),
        payload: {
          type: "OCCURRENCE_COMPLETED",
          title: "Task completed",
          body: `"${updated.title ?? "Untitled"}" marked complete.`,
          taskId: updated.taskId,
          occurrenceId: updated.id,
          projectId: updated.projectId ?? undefined,
        },
      });

      const orgId = req.user.orgId;
      req.io.to(`org:${orgId}`).emit("occurrence:updated", {
        orgId,
        occurrence: {
          id: updated.id,
          taskId: updated.taskId,
          // core fields
          title: updated.title,
          description: updated.description,
          remarks: updated.remarks,
          status: updated.status,
          startDate: updated.startDate,
          dueDate: updated.dueDate,
          assignedToId: updated.assignedToId,
          assignedToIds: (
            await orgPrisma.taskOccurrenceAssignee.findMany({
              where: { occurrenceId },
              select: { userId: true },
            })
          ).map((r: any) => r.userId),
          priority: updated.priority,
          clientId: updated.clientId,
          projectId: updated.projectId,
          isCompleted: updated.isCompleted ?? false,
        },
      });
    } catch (err) {
      console.error("updateOccurrence error:", err);
      res.status(500).json({ message: "Failed to update occurrence", err });
    }
  },
];

/**
 * Update master task (affects occurrences)
 * Uses simple recurrence: regenerate all when rule/dates meaningfully change.
 * For recurring tasks, we ALWAYS persist start/due (new or existing).
 * For non-recurring tasks, `updateDates` still controls date updates.
 *
 * Also accepts task-level assignedToIds to manage taskAssignee join rows.
 */
// src/controllers/taskController.ts

export const updateTask = [
  uploadTaskFiles,
  requireDocsFeatureIfDocOps,
  async (req: Request & { user?: any }, res: Response) => {
    try {
      const taskId = req.params.id;
      const {
        clientId,
        projectId,
        title,
        description,
        startDate,
        dueDate,
        assignedToId, // legacy single (fallback)
        assignedToIds: rawAssignedToIds,
        priority,
        remarks,
        status,
        recurrenceRule,
        recurrenceEndDate,
        repeatNature,
        updateFutureOccurrences = true,
        customValues: rawCustomValues = [],
      } = req.body;

      // Normalize FK strings
      const normalizedClientId =
        typeof clientId === "string" && clientId.trim() !== ""
          ? clientId
          : null;
      const normalizedProjectId =
        typeof projectId === "string" && projectId.trim() !== ""
          ? projectId
          : null;
      const normalizedAssignedToId =
        typeof assignedToId === "string" && assignedToId.trim() !== ""
          ? assignedToId
          : null;

      const orgPrisma = await resolveOrgPrisma(req);
      const prisma = await getCorePrisma();

      // Upload new task-level attachments
      let newTaskAttachmentKeys: string[] = [];
      try {
        if (
          req.files &&
          Array.isArray(req.files) &&
          (req.files as any[]).length
        ) {
          newTaskAttachmentKeys = await Promise.all(
            (req.files as any[]).map((file: any) =>
              uploadFileToSpaces(file, req.user.orgId)
            )
          );
          if (newTaskAttachmentKeys.length) {
            await orgPrisma.taskAttachment.createMany({
              data: newTaskAttachmentKeys.map((key) => ({ key, taskId })),
              skipDuplicates: true,
            });
          }
        }
      } catch (uploadErr) {
        console.error("[updateTask] attachment upload error:", uploadErr);
      }

      // Normalize assignedToIds
      const normalizeAssignedToIds = (v: any): string[] => {
        if (!v) return [];
        if (Array.isArray(v))
          return v
            .map(String)
            .map((s) => s.trim())
            .filter(Boolean);
        if (typeof v === "string") {
          const trimmed = v.trim();
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed))
              return parsed
                .map(String)
                .map((s) => s.trim())
                .filter(Boolean);
          } catch {}
          if (trimmed.includes(","))
            return trimmed
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean);
          if (trimmed) return [trimmed];
        }
        return [];
      };
      const assignedToIds = normalizeAssignedToIds(
        rawAssignedToIds ?? normalizedAssignedToId
      );

      // Parse custom values
      let customValues = rawCustomValues;
      if (typeof customValues === "string") {
        try {
          customValues = JSON.parse(customValues);
        } catch {
          customValues = [];
        }
      }
      if (!Array.isArray(customValues)) customValues = [];

      // Get existing task
      const existingTask = await orgPrisma.task.findUnique({
        where: { id: taskId },
        select: {
          recurrenceRule: true,
          isRecurring: true,
          startDate: true,
          dueDate: true,
          recurrenceEndDate: true,
          title: true,
          description: true,
          assignedToId: true,
          priority: true,
          remarks: true,
          status: true,
          clientId: true,
          projectId: true,
        },
      });
      if (!existingTask) {
        return res.status(404).json({ message: "Task not found" });
      }

      // 🔍 Detect if Project or Client changed
      const isProjectChanged = existingTask.projectId !== normalizedProjectId;
      const isClientChanged = existingTask.clientId !== normalizedClientId;

      // Flags & parsing
      const updateDatesFlag =
        req.body.updateDates === true ||
        String(req.body.updateDates).toLowerCase() === "true";
      const updateFutureOccurrencesFlag =
        updateFutureOccurrences === true ||
        String(updateFutureOccurrences).toLowerCase() === "true";

      const rawRecurrenceInput =
        typeof recurrenceRule === "string" && recurrenceRule.trim() !== ""
          ? recurrenceRule.trim()
          : typeof repeatNature === "string" && repeatNature.trim() !== ""
          ? repeatNature.trim()
          : null;

      const parsedSimpleRule = parseRecurrenceRule(rawRecurrenceInput);

      const wasRecurring = existingTask.isRecurring;
      const willBeRecurring = !!rawRecurrenceInput;
      const isRecurrenceStatusChanged = wasRecurring !== willBeRecurring;

      const parseISO = (v?: string) =>
        v ? DateTime.fromISO(v, { zone: "utc" }) : null;
      const isValidDT = (dt: DateTime | null) => !!dt && dt.isValid;

      const startDT = (willBeRecurring ? true : updateDatesFlag)
        ? parseISO(startDate as any)
        : null;
      const dueDT = (willBeRecurring ? true : updateDatesFlag)
        ? parseISO(dueDate as any)
        : null;

      const newStartDate =
        (willBeRecurring ? true : updateDatesFlag) && isValidDT(startDT)
          ? startDT!.toJSDate()
          : existingTask.startDate;

      const newDueDate =
        (willBeRecurring ? true : updateDatesFlag) && isValidDT(dueDT)
          ? dueDT!.toJSDate()
          : existingTask.dueDate;

      const newRecurrenceEndDate = recurrenceEndDate
        ? DateTime.fromISO(recurrenceEndDate, { zone: "utc" }).toJSDate()
        : existingTask.recurrenceEndDate;

      const normalizeRule = (r: string | null) => (r ? r.trim() : null);
      const isRecurrenceRuleChanged =
        normalizeRule(existingTask.recurrenceRule) !==
        normalizeRule(rawRecurrenceInput ?? null);

      const isStartDateChanged =
        Math.abs(newStartDate.getTime() - existingTask.startDate.getTime()) >
        60000;
      const isDueDateChanged =
        Math.abs(newDueDate.getTime() - existingTask.dueDate.getTime()) > 60000;
      const isEndDateChanged =
        (existingTask.recurrenceEndDate?.getTime() || 0) !==
        (newRecurrenceEndDate?.getTime() || 0);

      const needsOccurrenceRegeneration =
        isRecurrenceRuleChanged ||
        isRecurrenceStatusChanged ||
        (willBeRecurring &&
          (isStartDateChanged || isDueDateChanged || isEndDateChanged));

      // 🔴 Recurring → Non-recurring
      if (isRecurrenceStatusChanged && !willBeRecurring) {
        // ... (Keep existing conversion logic) ...
        await orgPrisma.$transaction(async (tx: any) => {
          await tx.task.update({
            where: { id: taskId },
            data: {
              clientId: normalizedClientId,
              projectId: normalizedProjectId,
              title,
              description,
              startDate: newStartDate,
              dueDate: newDueDate,
              assignedToId: assignedToIds.length ? assignedToIds[0] : normalizedAssignedToId,
              priority,
              remarks,
              status,
              recurrenceRule: null,
              recurrenceEndDate: null,
              isRecurring: false,
              lastGeneratedUntil: null,
              customValues: {
                deleteMany: {},
                create: customValues.map((cv: any) => ({
                  fieldId: cv.fieldId,
                  value: cv.value,
                })),
              },
            },
          });

          await tx.taskOccurrence.deleteMany({ where: { taskId } });

          const occ = await tx.taskOccurrence.create({
            data: {
              taskId,
              occurrenceIndex: 0,
              title: title ?? existingTask.title,
              description: description ?? existingTask.description,
              startDate: newStartDate,
              dueDate: newDueDate,
              assignedToId: assignedToIds.length ? assignedToIds[0] : normalizedAssignedToId ?? existingTask.assignedToId,
              priority: priority ?? existingTask.priority,
              remarks: remarks ?? existingTask.remarks,
              status: status ?? existingTask.status,
              clientId: clientId ?? existingTask.clientId,
              projectId: projectId ?? existingTask.projectId,
            },
            select: { id: true },
          });

          if (assignedToIds.length) {
            await tx.taskOccurrenceAssignee.deleteMany({ where: { occurrenceId: occ.id } });
            await tx.taskOccurrenceAssignee.createMany({
              data: assignedToIds.map((uid) => ({ occurrenceId: occ.id, userId: uid })),
              skipDuplicates: true,
            });
          }
        });

        const finalTask = await orgPrisma.task.findUnique({
          where: { id: taskId },
          include: { attachments: true, customValues: { include: { field: true } } },
        });
        const attachmentsWithUrls = await Promise.all(
          (finalTask?.attachments || []).map(async (att: any) => ({
            id: att.id,
            key: att.key,
            url: await getCachedFileUrlFromSpaces(att.key, req.user.orgId),
          }))
        );

        res.json({
          ...finalTask,
          attachments: attachmentsWithUrls,
          taskId: finalTask?.id,
          message: "Converted to non-recurring.",
        });
        
        const orgId = req.user.orgId;
        req.io.to(`org:${orgId}`).emit("task:updated", { orgId, task: { id: finalTask?.id } });
        req.io.to(`org:${orgId}`).emit("occurrence:refresh", { orgId, taskId });
        return;
      }

      // 5) Update master task
      const updated = await orgPrisma.task.update({
        where: { id: taskId },
        data: {
          clientId: normalizedClientId,
          projectId: normalizedProjectId,
          title,
          description,
          startDate: willBeRecurring ? newStartDate : updateDatesFlag ? newStartDate : undefined,
          dueDate: willBeRecurring ? newDueDate : updateDatesFlag ? newDueDate : undefined,
          assignedToId: assignedToIds.length ? assignedToIds[0] : normalizedAssignedToId,
          priority,
          remarks,
          status,
          recurrenceRule: rawRecurrenceInput ?? null,
          recurrenceEndDate: newRecurrenceEndDate,
          isRecurring: !!rawRecurrenceInput,
          lastGeneratedUntil: needsOccurrenceRegeneration ? null : undefined,
        },
        include: { attachments: true },
      });

      // Custom values update
      if (Array.isArray(customValues)) {
        await orgPrisma.task.update({
          where: { id: taskId },
          data: {
            customValues: {
              deleteMany: {},
              create: customValues.map((cv: any) => ({
                fieldId: cv.fieldId,
                value: cv.value,
              })),
            },
          },
        });
      }

      // ✅ 5.5) CRITICAL FIX: Update ALL occurrences (History + Future) immediately if Project/Client changed.
      // We do this BEFORE regeneration so that even preserved history occurrences get the new project ID.
      if (isProjectChanged || isClientChanged) {
         await orgPrisma.taskOccurrence.updateMany({
           where: { taskId }, // No date filter = update everything
           data: {
             clientId: normalizedClientId ?? undefined,
             projectId: normalizedProjectId ?? undefined
           }
         });
      }

      // 6) Occurrence updates/regeneration
      if (needsOccurrenceRegeneration) {
        try {
          const freshTask = await orgPrisma.task.findUnique({
            where: { id: taskId },
          });
          if (freshTask && parseRecurrenceRule(freshTask.recurrenceRule)) {
            await generateTaskOccurrencesSimple(orgPrisma, freshTask);
            
            // Notify about regeneration
            const firstOccurrence = await orgPrisma.taskOccurrence.findFirst({
              where: { taskId },
              include: { assignees: { select: { userId: true } } },
            });
            if (firstOccurrence) {
              await notifyCounterparties({
                orgPrisma,
                corePrisma: prisma,
                io: req.io,
                orgId: req.user.orgId,
                actor: { id: req.user.id, role: req.user.role },
                assigneeIds: firstOccurrence.assignees.map((a: any) => a.userId),
                payload: {
                  type: "TASK_UPDATED",
                  title: `Task updated: ${freshTask.title}`,
                  body: "Task occurrences have been regenerated",
                  taskId: freshTask.id,
                },
              });
            }
          }
        } catch (genErr) {
          console.error("Failed to generate occurrences:", genErr);
        }
      } else {
        // Non-regeneration logic: sync other fields to future only
        if (updated.isRecurring && updateFutureOccurrencesFlag) {
          const now = DateTime.utc().toJSDate();

          // Get future, not completed occurrences
          const occsToSync = await orgPrisma.taskOccurrence.findMany({
            where: { taskId, startDate: { gte: now }, isCompleted: false },
            select: { id: true },
          });
          const occIds = occsToSync.map((o: any) => o.id);

          if (occIds.length) {
            await orgPrisma.taskOccurrence.updateMany({
              where: { id: { in: occIds } },
              data: {
                title: title || undefined,
                description: description !== undefined ? description : undefined,
                assignedToId: assignedToIds.length ? assignedToIds[0] : normalizedAssignedToId ?? undefined,
                priority,
                remarks,
                status,
                // Redundant but safe: ensure future ones are definitely synced
                clientId: normalizedClientId ?? undefined,
                projectId: normalizedProjectId ?? undefined,
              },
            });

            // Update assignees for future occurrences
            if (assignedToIds.length > 0 || normalizedAssignedToId) {
              const userIds = assignedToIds.length
                ? assignedToIds
                : normalizedAssignedToId
                ? [normalizedAssignedToId]
                : [];
              await orgPrisma.taskOccurrenceAssignee.deleteMany({
                where: { occurrenceId: { in: occIds } },
              });

              if (userIds.length) {
                const createPayload = occIds.flatMap((occId:string) => userIds.map(uid => ({ occurrenceId: occId, userId: uid })));
                const CHUNK = 500;
                for (let i = 0; i < createPayload.length; i += CHUNK) {
                  await orgPrisma.taskOccurrenceAssignee.createMany({
                    data: createPayload.slice(i, i + CHUNK),
                    skipDuplicates: true,
                  });
                }
              }
            }
          }
        } else if (!updated.isRecurring) {
          // Single task: update everything on the single occurrence
          const primaryAssignedId = assignedToIds.length
            ? assignedToIds[0]
            : normalizedAssignedToId ?? null;

          await orgPrisma.taskOccurrence.updateMany({
            where: { taskId: updated.id, occurrenceIndex: 0 },
            data: {
              clientId: normalizedClientId ?? undefined,
              projectId: normalizedProjectId ?? undefined,
              title: title || undefined,
              description: description !== undefined ? description : undefined,
              startDate: updateDatesFlag ? newStartDate : undefined,
              dueDate: updateDatesFlag ? newDueDate : undefined,
              assignedToId: primaryAssignedId ?? undefined,
              priority,
              remarks,
              status,
            },
          });

          // Replace join rows
          if (assignedToIds.length || normalizedAssignedToId) {
            const occ = await orgPrisma.taskOccurrence.findFirst({
              where: { taskId: updated.id, occurrenceIndex: 0 },
              select: { id: true },
            });
            if (occ) {
              await orgPrisma.taskOccurrenceAssignee.deleteMany({
                where: { occurrenceId: occ.id },
              });
              const userIds = assignedToIds.length
                ? assignedToIds
                : normalizedAssignedToId
                ? [normalizedAssignedToId]
                : [];
              if (userIds.length) {
                await orgPrisma.taskOccurrenceAssignee.createMany({
                  data: userIds.map((uid) => ({ occurrenceId: occ.id, userId: uid })),
                  skipDuplicates: true,
                });
              }
            }
          }
        }
      }

      // 7) Response
      const finalTask = await orgPrisma.task.findUnique({
        where: { id: taskId },
        include: {
          attachments: true,
          customValues: { include: { field: true } },
        },
      });
      const attachmentsWithUrls = await Promise.all(
        (finalTask?.attachments || []).map(async (att: any) => ({
          id: att.id,
          key: att.key,
          url: await getCachedFileUrlFromSpaces(att.key, req.user.orgId),
        }))
      );

      const responseMessage = needsOccurrenceRegeneration
        ? "Task updated and occurrences regenerated"
        : "Task updated successfully";

      res.json({
        ...finalTask,
        attachments: attachmentsWithUrls,
        message: responseMessage,
        taskAssignedToIds: [],
        debug: {
          regeneratedOccurrences: needsOccurrenceRegeneration,
          changes: {
            recurrenceRule: isRecurrenceRuleChanged,
            startDate: isStartDateChanged,
            dueDate: isDueDateChanged,
            projectChanged: isProjectChanged,
          },
        },
      });

      // Realtime
      const orgId = req.user.orgId;
      req.io.to(`org:${orgId}`).emit("task:updated", {
        orgId,
        task: {
          id: finalTask?.id,
          title: finalTask?.title,
          status: finalTask?.status,
          priority: finalTask?.priority,
          clientId: finalTask?.clientId,
          projectId: finalTask?.projectId,
          startDate: finalTask?.startDate,
          dueDate: finalTask?.dueDate,
          attachments: attachmentsWithUrls,
        },
      });
      if (needsOccurrenceRegeneration) {
        req.io.to(`org:${orgId}`).emit("occurrence:refresh", { orgId, taskId });
      }
    } catch (err) {
      console.error("updateTask error:", err);
      res.status(500).json({ message: "Failed to update task", err });
    }
  },
];

/**
 * List tasks by project (occurrences)
 */
export async function listTasksByProject(req: Request, res: Response) {
  try {
    const { project } = req.query;

    if (!project) {
      return res
        .status(400)
        .json({ message: "project query parameter required" });
    }

    const orgPrisma = await resolveOrgPrisma(req); // resolve from req.orgPrisma or container

    const occurrences = await orgPrisma.taskOccurrence.findMany({
      where: { projectId: String(project) },
      include: {
        task: true,
        attachments: true,
        assignees: { select: { userId: true } },
      },
      orderBy: { startDate: "asc" },
    });

    res.json({ occurrences });
  } catch (err) {
    console.error("listTasksByProject error:", err);
    res.status(500).json({ message: "Failed to fetch tasks by project", err });
  }
}

// PATCH /task/occurrence/:id/status
export async function updateOccurrenceStatus(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const occurrenceId = req.params.id;
    const { status, scope = "SINGLE" } = req.body;

    if (!status) {
      return res.status(400).json({ message: "status is required" });
    }

    const orgPrisma = await resolveOrgPrisma(req);
    const prisma = getCorePrisma();

    // Permission check
    const canEdit = await canEmployeeEditOccurrence(
      orgPrisma,
      prisma,
      req,
      occurrenceId
    );
    if (!canEdit) {
      return res
        .status(403)
        .json({ message: "You are not allowed to update this occurrence" });
    }

    // Fetch occurrence before update
    const beforeUpdate = await orgPrisma.taskOccurrence.findUnique({
      where: { id: occurrenceId },
      include: {
        task: {
          include: {
            customValues: { include: { field: true } },
          },
        },
        assignees: {
          select: { userId: true },
        },
      },
    });

    if (!beforeUpdate) {
      return res.status(404).json({ message: "Occurrence not found" });
    }

    // 🔴 SPECIAL CASE: CANCELLED + FUTURE
    if (status === "CANCELLED" && scope === "FUTURE") {
      await orgPrisma.taskOccurrence.updateMany({
        where: {
          taskId: beforeUpdate.taskId,
          startDate: {
            gte: beforeUpdate.startDate, // current + future only
          },
        },
        data: {
          status: "CANCELLED",
          isCompleted: false,
          completedAt: null,
        },
      });

      // emit once (frontend will refetch anyway)
      req.io.to(`org:${req.user.orgId}`).emit("occurrence:status", {
        orgId: req.user.orgId,
        taskId: beforeUpdate.taskId,
        scope: "FUTURE",
        status: "CANCELLED",
      });

      return res.json({
        ok: true,
        scope: "FUTURE",
        status: "CANCELLED",
      });
    }

    const previousStatus = beforeUpdate.status;
    const statusChanged = status !== previousStatus;

    // Update the occurrence status
    const updated = await orgPrisma.taskOccurrence.update({
      where: { id: occurrenceId },
      data: { status },
      include: {
        task: {
          include: {
            customValues: { include: { field: true } },
          },
        },
        assignees: {
          select: { userId: true },
        },
      },
    });

    // Get actor details
    const actor = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, role: true },
    });
    const actorName = actor?.name || "Someone";
    const taskTitle = updated.title || "Untitled task";

    let notificationResult = {
      emailsSent: 0,
      notificationsSent: 0,
      clientEmailSent: false,
      recipients: { assignees: [] as string[] },
    };

    // Send notifications if status changed
    if (statusChanged) {
      const emailSubject = `Status Changed: ${taskTitle}`;
      const emailBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Status Update</h2>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3 style="margin-top: 0;">${taskTitle}</h3>
            <p><strong>Status changed from:</strong> ${
              previousStatus || "Unknown"
            } → <strong>${status}</strong></p>
            <p><strong>Changed by:</strong> ${actorName}</p>
            ${
              updated.task.description
                ? `<p><strong>Description:</strong> ${updated.task.description}</p>`
                : ""
            }
            ${
              updated.dueDate
                ? `<p><strong>Due Date:</strong> ${new Date(
                    updated.dueDate
                  ).toLocaleDateString()}</p>`
                : ""
            }
          </div>
          
          <p style="color: #666; font-size: 12px;">
            This is an automated notification from TaskBizz. Please do not reply to this email.
          </p>
        </div>
      `;

      // ---------- Build attachments to include with client email ----------
      let emailAttachmentsForNotify: Array<{
        filename: string;
        content: Buffer;
        contentType?: string;
      }> = [];

      try {
        if (updated.clientId) {
          // Fetch task + occurrence attachments
          const [taskAttachments, occAttachments] = await Promise.all([
            orgPrisma.taskAttachment.findMany({
              where: { taskId: updated.taskId },
            }),
            orgPrisma.taskOccurrenceAttachment.findMany({
              where: { occurrenceId: updated.id },
            }),
          ]);
          const allAttachments = [...taskAttachments, ...occAttachments];

          if (allAttachments.length > 0) {
            const axios = (await import("axios")).default;
            const fallbackUrls: string[] = [];

            await Promise.all(
              allAttachments.map(async (att: any) => {
                try {
                  const url = await getCachedFileUrlFromSpaces(
                    att.key,
                    req.user.orgId
                  );
                  const resp = await axios.get(url, {
                    responseType: "arraybuffer",
                    validateStatus: (s) => s >= 200 && s < 300,
                  });
                  const buf = Buffer.from(resp.data as ArrayBuffer);

                  const filename =
                    att.filename ||
                    String(att.key).split("/").filter(Boolean).pop() ||
                    `attachment-${att.id || Date.now()}`;

                  const contentType =
                    (resp.headers &&
                      (resp.headers["content-type"] as string)) ||
                    undefined;

                  emailAttachmentsForNotify.push({
                    filename,
                    content: buf,
                    contentType,
                  });
                } catch (dlErr) {
                  console.warn(
                    `[updateOccurrenceStatus] failed to download att ${
                      att.id || att.key
                    }:`,
                    (dlErr as any)?.message ?? dlErr
                  );
                  try {
                    // store fallback link for email body if needed
                    const url = await getCachedFileUrlFromSpaces(
                      att.key,
                      req.user.orgId
                    );
                    fallbackUrls.push(url);
                  } catch (e) {
                    // ignore
                  }
                }
              })
            );

            // if you want to include fallbackUrls in the notify body, pass them too or let notify helper add them
          }
        }
      } catch (e) {
        console.warn(
          "Failed to prepare attachments for notify:",
          (e as any)?.message ?? e
        );
      }
      // ---------- end attachments ----------

      // Send notifications to assignees AND client
      notificationResult = await notifyOccurrenceAssigneesAndClient(
        orgPrisma,
        prisma,
        req.io,
        req.user.orgId,
        occurrenceId,
        emailSubject,
        emailBody,
        {
          type: "STATUS_CHANGED",
          title: "Task status changed",
          body: `${actorName} changed the status of "${taskTitle}" from ${
            previousStatus || "Unknown"
          } to ${status}.`,
          taskId: updated.taskId,
          occurrenceId: updated.id,
        },
        {
          // new optional param: attachments for client email
          attachments: emailAttachmentsForNotify,
          // optionally pass fallbackUrls: fallbackUrls (if you collected them)
        }
      );

      // console.log(
      //   `Status change notifications: ${notificationResult.emailsSent} assignee emails, client email: ${notificationResult.clientEmailSent}, ${notificationResult.notificationsSent} in-app notifications`
      // );
    }

    // Emit socket event
    const orgId = req.user.orgId;
    req.io.to(`org:${orgId}`).emit("occurrence:status", {
      orgId,
      occurrence: {
        id: updated.id,
        taskId: updated.taskId,
        title: updated.title,
        description: updated.description,
        remarks: updated.remarks,
        status: updated.status,
        isCompleted: updated.isCompleted ?? false,
        assignedToId: updated.assignedToId,
        assignedToIds: updated.assignees?.map((a: any) => a.userId) || [],
        priority: updated.priority,
        clientId: updated.clientId,
        projectId: updated.projectId,
        startDate: updated.startDate,
        dueDate: updated.dueDate,
      },
    });

    res.json({
      ok: true,
      occurrence: updated,
      emailsSent: notificationResult.emailsSent,
      clientEmailSent: notificationResult.clientEmailSent,
      notificationsSent: notificationResult.notificationsSent,
      recipients: notificationResult.recipients,
    });

    try {
      const occurrenceAssignees =
        updated.assignees?.map((a: any) => a.userId) || [];

      await notifyCounterparties({
        orgPrisma,
        corePrisma: prisma,
        io: req.io,
        orgId: req.user.orgId,
        actor: { id: req.user.id, role: req.user.role },
        assigneeIds: occurrenceAssignees,
        payload: {
          type: "STATUS_CHANGED",
          title: "Task status changed",
          body: `${actorName} changed the status of "${taskTitle}" from ${
            previousStatus || "Unknown"
          } to ${status}`,
          taskId: updated.taskId,
          occurrenceId: updated.id,
          projectId: updated.projectId ?? undefined,
        },
      });
    } catch (notifyError) {
      console.error("In-app notification error:", notifyError);
    }
  } catch (err) {
    console.error("updateOccurrenceStatus error:", err);
    res.status(500).json({ message: "Failed to update status", err });
  }
}

/**
 * Delete a task and all its occurrences
 */
export async function deleteTask(req: Request & { user?: any }, res: Response) {
  try {
    const taskId = req.params.id;
    const orgPrisma = await resolveOrgPrisma(req);

    // Get task details first
    const task = await orgPrisma.task.findUnique({
      where: { id: taskId },
      include: {
        attachments: true,
      },
    });

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    // Get all occurrences to clean up their attachments
    const occurrences = await orgPrisma.taskOccurrence.findMany({
      where: { taskId },
      include: { attachments: true },
    });

    // Delete all occurrence attachments from S3
    for (const occurrence of occurrences) {
      for (const attachment of occurrence.attachments) {
        try {
          await deleteFileFromSpaces(attachment.key);
        } catch (error) {
          console.error(
            `Failed to delete occurrence attachment ${attachment.key}:`,
            error
          );
        }
      }
    }

    // Delete all task-level attachments from S3
    for (const attachment of task.attachments) {
      try {
        await deleteFileFromSpaces(attachment.key);
      } catch (error) {
        console.error(
          `Failed to delete task attachment ${attachment.key}:`,
          error
        );
      }
    }

    // Delete all occurrences (this will cascade delete occurrence attachments via DB)
    await orgPrisma.taskOccurrence.deleteMany({
      where: { taskId },
    });

    // Delete task-level attachments
    await orgPrisma.taskAttachment.deleteMany({
      where: { taskId },
    });

    // Delete task-level assignees join rows
    await orgPrisma.taskAssignee.deleteMany({ where: { taskId } });

    // Finally delete the master task
    await orgPrisma.task.delete({
      where: { id: taskId },
    });

    res.json({
      message: "Task and all occurrences deleted successfully",
      deletedOccurrences: occurrences.length,
      deletedTaskAttachments: task.attachments.length,
    });

    // Invalidate caches
    // await invalidateOrgCaches(req.user.orgId).catch((e) =>
    //   console.warn("invalidateOrgCaches failed", e)
    // );

    const orgId = req.user.orgId;
    req.io.to(`org:${orgId}`).emit("task:deleted", { orgId, id: taskId });
  } catch (err) {
    console.error("deleteTask error:", err);
    res.status(500).json({ message: "Failed to delete task", err });
  }
}

// POST /org/:orgId/custom-fields
export async function createCustomField(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const orgPrisma = await resolveOrgPrisma(req);
    const { name, type, options = [] } = req.body;

    const field = await orgPrisma.taskCustomField.create({
      data: {
        orgId: req.user.orgId,
        name,
        type,
        options,
      },
    });

    res.status(201).json(field);

    // Invalidate caches so new custom field is available in lists / dashboards
    // await invalidateOrgCaches(req.user.orgId).catch((e) =>
    //   console.warn("invalidateOrgCaches failed", e)
    // );
  } catch (err) {
    console.error("createCustomField error:", err);
    res.status(500).json({ message: "Failed to create custom field", err });
  }
}

// GET /org/:orgId/custom-fields
export async function listCustomFields(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const orgPrisma = await resolveOrgPrisma(req);
    const fields = await orgPrisma.taskCustomField.findMany({
      where: { orgId: req.user.orgId },
    });
    res.json(fields);
  } catch (err) {
    console.error("listCustomFields error:", err);
    res.status(500).json({ message: "Failed to list custom fields", err });
  }
}

/**
 * Bulk upload tasks (from parsed CSV/Excel JSON array)
 * POST /tasks/bulk
 */
export const bulkUploadTasks = async (
  req: Request & { user?: any },
  res: Response
) => {
  try {
    const { tasks } = req.body;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ message: "tasks array is required" });
    }

    const orgPrisma = await resolveOrgPrisma(req);
    const results: any[] = [];

    for (const row of tasks) {
      try {
        const {
          title,
          description,
          startDate,
          dueDate,
          priority,
          status,
          assignedToId,
          clientId,
          projectId,
          remarks,
        } = row;

        if (!title || !startDate || !dueDate) {
          results.push({
            ok: false,
            error: "Missing required fields: title, startDate, dueDate",
            row,
          });
          continue;
        }

        // Parse dates safely (Excel serials or strings)
        const parsedStart = parseDateInput(startDate);
        const parsedDue = parseDateInput(dueDate);

        if (!parsedStart || !parsedDue) {
          results.push({
            ok: false,
            error: "Invalid startDate or dueDate",
            row,
          });
          continue;
        }

        // Create non-recurring task
        const createdTask = await orgPrisma.task.create({
          data: {
            clientId: clientId || null,
            projectId: projectId || null,
            title,
            description: description || null,
            startDate: parsedStart,
            dueDate: parsedDue,
            assignedToId: assignedToId || null,
            priority: priority || "LOW",
            remarks: remarks || null,
            status: status || "OPEN",
            recurrenceRule: null,
            recurrenceEndDate: null,
            isRecurring: false, // ✅ always non-recurring
            createdById: req.user.id,
          },
        });

        // Always ensure exactly one occurrence
        await orgPrisma.taskOccurrence.upsert({
          where: {
            taskId_occurrenceIndex: {
              taskId: createdTask.id,
              occurrenceIndex: 0,
            },
          },
          update: {
            title: createdTask.title,
            description: createdTask.description,
            startDate: createdTask.startDate,
            dueDate: createdTask.dueDate,
            assignedToId: createdTask.assignedToId,
            priority: createdTask.priority,
            remarks: createdTask.remarks,
            status: createdTask.status,
            clientId: createdTask.clientId,
            projectId: createdTask.projectId,
          },
          create: {
            taskId: createdTask.id,
            occurrenceIndex: 0,
            title: createdTask.title,
            description: createdTask.description,
            startDate: createdTask.startDate,
            dueDate: createdTask.dueDate,
            assignedToId: createdTask.assignedToId,
            priority: createdTask.priority,
            remarks: createdTask.remarks,
            status: createdTask.status,
            clientId: createdTask.clientId,
            projectId: createdTask.projectId,
          },
        });

        results.push({
          ok: true,
          taskId: createdTask.id,
          title: createdTask.title,
        });
      } catch (taskErr: any) {
        console.error("bulkUploadTasks error for row:", taskErr);
        results.push({ ok: false, error: taskErr.message, row });
      }
    }

    res.status(201).json({
      message: `Processed ${tasks.length} tasks`,
      results,
    });

    // Invalidate caches after bulk upload so clients see the new tasks
    // await invalidateOrgCaches(req.user.orgId).catch((e) =>
    //   console.warn("invalidateOrgCaches failed", e)
    // );
  } catch (err) {
    console.error("bulkUploadTasks error:", err);
    res.status(500).json({ message: "Bulk upload failed", err });
  }
};

// DELETE /task/custom-fields/:id
export async function deleteCustomField(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const { id } = req.params;
    const orgPrisma = await resolveOrgPrisma(req);

    // Ensure field exists in this org
    const field = await orgPrisma.taskCustomField.findUnique({ where: { id } });
    if (!field) {
      return res.status(404).json({ message: "Custom field not found" });
    }

    // Delete related values first (to avoid FK constraint errors)
    await orgPrisma.taskCustomValue.deleteMany({
      where: { fieldId: id },
    });

    // Now delete the field itself
    await orgPrisma.taskCustomField.delete({ where: { id } });

    // Invalidate caches
    // await invalidateOrgCaches(req.user.orgId).catch((e) =>
    //   console.warn("invalidateOrgCaches failed", e)
    // );

    return res.json({ success: true });
  } catch (err) {
    console.error("Delete custom field error", err);
    return res.status(500).json({ message: "Failed to delete custom field" });
  }
}

// ====== WhatsApp env/config ======
// Add/ensure near top of file with your other imports:
// import axios from "axios";

// ======= WhatsApp config (env-first, fallback to values you supplied) =======
const WH_API_VERSION = process.env.WHATSAPP_API_VERSION || "v17.0";
// Phone node ID (your phone ID was 727373040468092 when testing sends, WABA is 656579633456771)
// Use the phone node ID for /<PHONE_ID>/messages endpoint (you used 727373040468092 earlier).
const WH_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// Token: prefer env var. Fallback here to the token you posted (rotate it ASAP).
const WH_TOKEN = process.env.WHATSAPP_TOKEN;

// Template name & language (use 'hello_world' as you said)
let WH_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME || "hello_world";
const WH_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";

// Masked config log so you can verify the server loaded config
function mask(s?: string) {
  if (!s) return "<missing>";
  return s.length > 8 ? s.slice(0, 4) + "..." + s.slice(-4) : "****";
}
// console.log(
//   "[WA CONFIG] PHONE_ID:",
//   WH_PHONE_ID,
//   "TOKEN_SET:",
//   !!WH_TOKEN,
//   "TEMPLATE:",
//   WH_TEMPLATE_NAME,
//   "LANG:",
//   WH_TEMPLATE_LANG
// );

// ======= Helpers =======

function normalizeIndianNumber(raw?: string): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  // remove typical punctuation/whitespace
  s = s.replace(/[\s\-\.\(\)]/g, "");

  // already E.164?
  if (/^\+\d{6,15}$/.test(s)) return s;

  // international 00 prefix -> +...
  if (/^00\d{6,15}$/.test(s)) return "+" + s.slice(2);

  // strip leading zeros
  s = s.replace(/^0+/, "");

  // if starts with 91 + 10 digits -> +91...
  if (/^91\d{10}$/.test(s)) return "+" + s;

  // naked 10-digit Indian -> add +91
  if (/^\d{10}$/.test(s)) return "+91" + s;

  // fallback: plausible digits -> prefix +
  if (/^\d{11,14}$/.test(s)) return "+" + s;

  return null;
}

function isE164(s: string) {
  return /^\+\d{6,15}$/.test(s);
}

function extractAxiosError(err: any) {
  return err?.response?.data ?? err?.message ?? err;
}

/**
 * Send template message via WhatsApp Cloud API.
 * Returns { ok: boolean, status?, data?, error? } where data is Graph API success response.
 */
async function sendWhatsAppTemplate(toE164: string, clientName: string) {
  if (!WH_TOKEN || !WH_PHONE_ID) {
    return {
      ok: false,
      error: "WhatsApp not configured (missing token or phone id)",
    };
  }
  if (!isE164(toE164)) {
    return { ok: false, error: `Invalid E.164 phone: ${toE164}` };
  }

  const url = `https://graph.facebook.com/${WH_API_VERSION}/${WH_PHONE_ID}/messages`;
  const payload: any = {
    messaging_product: "whatsapp",
    to: toE164,
    type: "template",
    template: {
      name: WH_TEMPLATE_NAME,
      language: { code: WH_TEMPLATE_LANG },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", text: clientName || "Customer" }],
        },
      ],
    },
  };

  console.debug("WA template payload:", JSON.stringify(payload));
  try {
    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WH_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    console.debug("WA template response:", r.status, r.data);
    return { ok: true, status: r.status, data: r.data };
  } catch (err: any) {
    console.error("WA template error:", extractAxiosError(err));
    return { ok: false, error: extractAxiosError(err) };
  }
}

/**
 * Send plain text (only works inside 24-hour session window).
 */
async function sendWhatsAppText(toE164: string, textBody: string) {
  // console.log("[WA] sendWhatsAppText called", {
  //   toE164,
  //   length: textBody?.length ?? 0,
  // });
  if (!WH_TOKEN || !WH_PHONE_ID) {
    // console.log("[WA] missing config (token or phone id)");
    return {
      ok: false,
      error: "WhatsApp not configured (missing token or phone id)",
    };
  }
  if (!isE164(toE164)) {
    // console.log("[WA] invalid e164:", toE164);
    return { ok: false, error: `Invalid E.164 phone: ${toE164}` };
  }

  const url = `https://graph.facebook.com/${WH_API_VERSION}/${WH_PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: toE164,
    type: "text",
    text: { body: textBody },
  };

  // console.log("[WA] POST ->", url, "text-length:", textBody?.length ?? 0);
  try {
    const r = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WH_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });
    // console.log("[WA] text send success:", r.status, JSON.stringify(r.data));
    return { ok: true, status: r.status, data: r.data };
  } catch (err: any) {
    // console.log(
    //   "[WA] text send error:",
    //   JSON.stringify(extractAxiosError(err))
    // );
    return { ok: false, error: extractAxiosError(err) };
  }
}

    // helper: format date as "20 Oct, 2025"
    function formatDateNice(input?: string | Date | null): string {
      if (!input) return "—";
      const d = new Date(input as any);
      if (isNaN(d.getTime())) return String(input);
      const day = String(d.getDate()).padStart(2, "0");
      // month short like "Oct"
      const month = d.toLocaleString("en-US", { month: "short" });
      const year = d.getFullYear();
      return `${day} ${month}, ${year}`;
    }


// ======= Updated sendTaskToClient handler =======
export async function sendTaskToClient(
  req: Request & { user?: any },
  res: Response
) {
  try {
    // Support multiple input shapes for backward compatibility:
    // Preferred: { occurrenceId }
    // Or: { taskId, occurrenceIndex } // compound unique
    // Or fallback: { taskId } -> finds first occurrence for that taskId
    const prisma = await getCorePrisma();
    const body = (req.body as any) ?? {};
    const { occurrenceId, taskId, occurrenceIndex } = body;

    // Optional frontend-provided assignees (preferred if present)
    // expected shape: [{ id?, name?, email?, mobile? }, ...]
    const frontendAssignees = Array.isArray(body.assignees)
      ? (body.assignees as any[])
      : null;

    const orgPrisma = await resolveOrgPrisma(req);

    // Debug log helpful when callers send wrong payload
    if (!occurrenceId && !taskId) {
      console.warn(
        "sendTaskToClient called without occurrenceId or taskId. Request body:",
        JSON.stringify(body)
      );
    }

    // Fetch organization name (control DB)
    let organizationName = "TaskBizz"; // Default fallback
    try {
      if (req.user?.orgId) {
        const organization = await prisma.organization.findUnique({
          where: { id: req.user.orgId },
          select: { name: true },
        });
        if (organization?.name) {
          organizationName = organization.name;
        }
      }
    } catch (e) {
      console.warn("Could not fetch organization name from database:", e);
    }

    // Fetch occurrence and include task (task should include assignees & attachments) and occurrence attachments
    let occurrence: any | null = null;
    if (occurrenceId) {
      occurrence = await orgPrisma.taskOccurrence.findUnique({
        where: { id: occurrenceId },
        include: {
          task: { include: { attachments: true, assignees: true } },
          attachments: true,
          assignees: true,
        },
      });
    } else if (
      taskId &&
      occurrenceIndex !== undefined &&
      occurrenceIndex !== null
    ) {
      occurrence = await orgPrisma.taskOccurrence.findUnique({
        where: {
          taskId_occurrenceIndex: {
            taskId,
            occurrenceIndex: Number(occurrenceIndex),
          },
        },
        include: {
          task: { include: { attachments: true, assignees: true } },
          attachments: true,
          assignees: true,
        },
      });
    } else if (taskId) {
      occurrence = await orgPrisma.taskOccurrence.findFirst({
        where: { taskId },
        orderBy: { occurrenceIndex: "asc" },
        include: {
          task: { include: { attachments: true, assignees: true } },
          attachments: true,
          assignees: true,
        },
      });
    } else {
      return res.status(400).json({
        error:
          "Missing identifier. Provide occurrenceId, or taskId + occurrenceIndex.",
      });
    }

    if (!occurrence) {
      return res.status(404).json({
        error:
          "Task occurrence not found. Confirm occurrenceId, or taskId + occurrenceIndex, or valid taskId.",
      });
    }

    if (!occurrence.clientId) {
      return res
        .status(400)
        .json({ error: "This task occurrence has no linked client" });
    }

    if ((occurrence.clientMailSendCount ?? 0) >= 3) {
      return res.status(400).json({
        error: "Send limit reached (3/3)",
        count: occurrence.clientMailSendCount ?? 0,
      });
    }

    // Fetch client
    const client = await orgPrisma.client.findUnique({
      where: { id: occurrence.clientId },
      select: { name: true, email: true, mobile: true },
    });

    if (!client || !client.email) {
      return res
        .status(404)
        .json({ error: "Client not found or client missing email" });
    }

    // Fetch attachments: master task attachments + this occurrence's attachments
    // (we already included attachments on task & occurrence, but keep this for compatibility)
    const [taskAttachments, occAttachments] = await Promise.all([
      orgPrisma.taskAttachment.findMany({
        where: { taskId: occurrence.taskId },
      }),
      orgPrisma.taskOccurrenceAttachment.findMany({
        where: { occurrenceId: occurrence.id },
      }),
    ]);

    const allAttachments = [...taskAttachments, ...occAttachments];

    // Resolve cached URLs then download the files as buffers so they can be attached to email.
    const axios = (await import("axios")).default;

    const downloadedAttachments: Array<{
      filename: string;
      content: Buffer;
      contentType?: string;
    }> = [];

    const fallbackUrls: string[] = [];

    await Promise.all(
      allAttachments.map(async (att: any) => {
        try {
          const url = await getCachedFileUrlFromSpaces(att.key, req.user.orgId);

          const resp = await axios.get(url, {
            responseType: "arraybuffer",
            validateStatus: (s) => s >= 200 && s < 300,
          });

          const buf = Buffer.from(resp.data as ArrayBuffer);

          const filename =
            att.filename ||
            String(att.key).split("/").filter(Boolean).pop() ||
            `attachment-${att.id || Date.now()}`;

          const contentType =
            (resp.headers && (resp.headers["content-type"] as string)) ||
            undefined;

          downloadedAttachments.push({
            filename,
            content: buf,
            contentType,
          });
        } catch (downloadErr) {
          console.warn(
            `Failed to download attachment ${att.id || att.key}:`,
            (downloadErr as any)?.message || downloadErr
          );
          try {
            const url = await getCachedFileUrlFromSpaces(
              att.key,
              req.user.orgId
            );
            fallbackUrls.push(url);
          } catch (err2) {
            // give up quietly
          }
        }
      })
    );

    // === Use frontend-provided assignees if present, else prefer occurrence.assignees, then task.assignees ===
    // Normalize to array of { name?, email?, mobile?, id? }
    let normalizedAssignees: Array<{
      id?: string;
      name?: string;
      email?: string;
      phone?: string;
    }> = [];

    // 1) Frontend-provided assignees (highest priority)
    if (Array.isArray(frontendAssignees) && frontendAssignees.length > 0) {
      const cap = 20;
      normalizedAssignees = frontendAssignees
        .slice(0, cap)
        .map((a: any) => ({
          id: a?.id ? String(a.id) : undefined,
          name: a?.name ? String(a.name) : undefined,
          email: a?.email ? String(a.email) : undefined,
          phone: a?.phone ? String(a.phone) : undefined,
        }))
        .filter((a) => a.name || a.email || a.phone || a.id);
    } else {
      // 2) Prefer occurrence-level assignees (TaskOccurrenceAssignee[] -> userId)
      try {
        const occAssignees = (occurrence.assignees ?? []) as any[];
        if (Array.isArray(occAssignees) && occAssignees.length > 0) {
          normalizedAssignees = occAssignees
            .map((a) => ({
              id: a?.userId
                ? String(a.userId)
                : a?.id
                ? String(a.id)
                : undefined,
            }))
            .filter((a) => a.id);
        } else {
          // 3) Fallback to task-level assignees (may have richer fields if present)
          const taskAssignees = (occurrence.task?.assignees ?? []) as any[];
          if (Array.isArray(taskAssignees) && taskAssignees.length > 0) {
            normalizedAssignees = taskAssignees
              .map((u) => ({
                id: u?.userId
                  ? String(u.userId)
                  : u?.id
                  ? String(u.id)
                  : undefined,
                name:
                  u && (u.name || u.fullName || u.displayName)
                    ? String(u.name || u.fullName || u.displayName)
                    : undefined,
                email:
                  u && (u.email || u.userEmail)
                    ? String(u.email || u.userEmail)
                    : undefined,
                phone:
                  u && (u.phone || u.phone)
                    ? String(u.phone || u.phone)
                    : undefined,
              }))
              .filter((a) => a.name || a.email || a.phone || a.id);
          }
        }
      } catch (e) {
        console.warn("assignee parsing from occurrence/task failed:", e);
      }
    }

    // Final friendly display strings
    const assigneeLinesText =
      normalizedAssignees.length === 0
        ? "Unassigned"
        : normalizedAssignees
            .map((a) => {
              const name = a.name ?? `#${a.id ?? "?"}`;
              const email = a.email ?? "—";
              return `${name}\n${email}`;
            })
            .join("\n\n");

    // HTML: show name and email under it (compact stacked blocks)
    const assigneeNameEmailHtml =
      normalizedAssignees.length === 0
        ? "—"
        : normalizedAssignees
            .map((a) => {
              const name = a.name ?? `#${a.id ?? "?"}`;
              const email = a.email ?? "—";
              // keep simple styling consistent with your template
              return `<div style="margin-bottom:8px;">
                        <div style="font-weight:600; color:#111827;">${name}</div>
                        <div style="font-size:12px; color:#6b7280;">${email}</div>
                      </div>`;
            })
            .join("");

    // Contact numbers: only phone numbers (joined). If none, show em dash.
    const contactNumbersArr = normalizedAssignees
      .map((a) => a.phone)
      .filter(Boolean) as string[];
    const contactNumbersText =
      contactNumbersArr.length > 0 ? contactNumbersArr.join("; ") : "—";

    // ... end of normalizedAssignees construction ...

    // ---------- INSERT: fetch core user details for the assignee IDs ----------
    try {
      // Collect IDs we need to resolve (preserve order)
      const assigneeIds = normalizedAssignees
        .map((a) => a.id)
        .filter(Boolean) as string[];

      if (assigneeIds.length > 0) {
        // Attempt 1: core users table (common)
        let coreUsers: any[] = [];
        try {
          if (typeof prisma?.user?.findMany === "function") {
            coreUsers = await prisma.user.findMany({
              where: { id: { in: assigneeIds } },
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
              },
            });
            // console.log(coreUsers);
          }
        } catch (e) {
          console.warn(
            "prisma.user.findMany failed:",
            (e as any)?.message ?? e
          );
        }

        // Attempt 2: directoryUser mapping (fallback)
        if (
          (!coreUsers || coreUsers.length === 0) &&
          typeof orgPrisma?.directoryUser?.findMany === "function"
        ) {
          try {
            const dirs = await orgPrisma.directoryUser.findMany({
              where: { userId: { in: assigneeIds } },
              select: { userId: true, name: true, avatarUrl: true },
            });
            coreUsers = dirs.map((d: any) => ({
              id: d.userId ?? d.user_id,
              name: d.name,
            }));
          } catch (e) {
            console.warn(
              "prisma.directoryUser.findMany failed:",
              (e as any)?.message ?? e
            );
          }
        }

        // Build lookup map
        const usersById: Record<string, any> = (coreUsers || []).reduce(
          (acc: Record<string, any>, u: any) => {
            acc[String(u.id ?? u.userId ?? u.user_id)] = u;
            return acc;
          },
          {}
        );

        // Merge fetched fields back into normalizedAssignees (don't overwrite existing fields)
        normalizedAssignees = normalizedAssignees.map((a) => {
          const u = usersById[String(a.id)];
          if (!u) return a;
          return {
            id: a.id,
            // keep existing a.name/email/mobile if present, else use core user values
            name: a.name ?? (u.name ? String(u.name) : undefined),
            email: a.email ?? (u.email ? String(u.email) : undefined),
            phone:
              a.phone ??
              (u.phone ?? u.phone ? String(u.phone ?? u.phone) : undefined),
          };
        });

        // Warn about unresolved ids (optional/informational)
        const unresolved = normalizedAssignees
          .filter((a) => !a.name && !a.email && !a.phone)
          .map((x) => x.id);
        if (unresolved.length > 0) {
          console.debug(
            "[sendTaskToClient] unresolved assignee ids (no profile found):",
            unresolved
          );
        }
      }
    } catch (e) {
      console.warn(
        "Failed to fetch assignee profiles from core DB:",
        (e as any)?.message ?? e
      );
    }
    // ---------- END INSERT ----------

    // Format due date
        const dueDateStr = formatDateNice(occurrence.dueDate);


    // Build subject and body per requested template:
    // Subject: {TaskName} is "{TaskStatus}" Now
    const subject = `${occurrence.title ?? "Task"} is "${
      occurrence.status ?? "Open"
    }"`;

    // Plain text body
    const textParts = [
      organizationName,
      "",
      `Current Status: ${occurrence.status ?? "—"}`,
      `Assigned Person:\n${assigneeLinesText}`,
      `Contact: ${contactNumbersText}`,
      `Due Date: ${dueDateStr}`,
      "",
      "",
      "Details:",
      occurrence.description ?? "",
      "",
    ];

    if (fallbackUrls.length > 0) {
      textParts.push("Attachments (couldn't attach these files, links below):");
      textParts.push(...fallbackUrls);
    }

    textParts.push(
      "Please do not reply to this email. This mailbox is not monitored."
    );

    const text = textParts.join("\n");

    // HTML body — minimal, requested fields
    const attachmentsHtmlSection =
      downloadedAttachments.length > 0
        ? `<p style="margin-top:12px;">${downloadedAttachments.length} file(s) attached to this email.</p>`
        : fallbackUrls.length > 0
        ? `<p style="margin-top:12px;">Attachment links: ${fallbackUrls
            .map((u) => `<a href="${u}">${u}</a>`)
            .join("<br/>")}</p>`
        : `<p style="margin-top:12px; color:#6b7280;">No attachments provided.</p>`;

    const html = `
      <div style="font-family: Arial, sans-serif; background:#f9fafb; padding:20px; color:#111827;">
        <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.05);">
          
          <!-- Header -->
          <div style="background:#ffffff; padding:20px; text-align:center; border-bottom:1px solid #e5e7eb;">
            <h2 style="margin:0; color:#111827; font-size:18px;">${organizationName}</h2>
            <h3 style="margin:6px 0 0; color:#2563eb; font-size:16px;">${
              occurrence.title ?? "Task"
            }</h3>
          </div>

          <div style="padding:20px;">
            <table style="width:100%; border-collapse:collapse;">
              <tr style="background:#f9fafb;">
                <td style="padding:8px; font-weight:bold; color:#111827;">Current Status:</td>
                <td style="padding:8px; color:#111827;">${
                  occurrence.status ?? "—"
                }</td>
              </tr>
              <tr>
                <td style="padding:8px; font-weight:bold; color:#111827;">Assigned Person:</td>
                <td style="padding:8px; color:#111827;">${assigneeNameEmailHtml}</td>
              </tr>
              <tr style="background:#f9fafb;">
                <td style="padding:8px; font-weight:bold; color:#111827;">Contact:</td>
                <td style="padding:8px; color:#111827;">${contactNumbersText}</td>
              </tr>
              <tr>
                <td style="padding:8px; font-weight:bold; color:#111827;">Due Date for Submission:</td>
                <td style="padding:8px; color:#111827;">${dueDateStr}</td>
              </tr>
            </table>

            <div style="margin-top:16px; color:#374151;">
              <p style="margin:0 0 8px;">${occurrence.description ?? ""}</p>
            </div>

            ${attachmentsHtmlSection}
          </div>

          <div style="background:#f9fafb; padding:12px; text-align:center; font-size:12px; color:#6b7280;">
            <div style="font-size:12px; color:#6b7280; margin-bottom:6px;">
              Please do not reply to this email. This inbox is not monitored.
            </div>
            <div>
              Powered by TaskBizz - manage Business in smarter way
            </div>
          </div>

        </div>
      </div>
    `;

    // Build attachments payload for sendTaskEmail
    const emailAttachments = downloadedAttachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    }));

    // Send email (assumes sendTaskEmail supports an `attachments` array)
    await sendTaskEmail({
      to: client.email,
      subject,
      text,
      html,
      attachments: emailAttachments,
    });

    // Increment clientMailSendCount on the occurrence row
    const updated = await orgPrisma.taskOccurrence.update({
      where: { id: occurrence.id },
      data: { clientMailSendCount: { increment: 1 } },
      select: { clientMailSendCount: true },
    });

    void sendTaskBizzServiceUpdate({
      phone: client.mobile || "",
      organizationName,
      clientName: client.name ?? "",
      work: occurrence.title ?? "Task",
      dueDate: new Date(occurrence.dueDate!).toLocaleDateString("en-IN"),
      assignedTo: normalizedAssignees[0]?.name ?? "Team",
      status: occurrence.status ?? "OPEN",
    });


    return res.json({
      success: true,
      sentTo: client.email,
      attachmentsSent: emailAttachments.length,
      attachmentsFallbackLinks: fallbackUrls.length,
      count: updated.clientMailSendCount,
    });
  } catch (err) {
    console.error("sendTaskToClient error:", err);
    return res.status(500).json({
      error: "Failed to send task",
      details: (err as any)?.message ?? err,
    });
  }
}



/**
 * Minimal helper to escape text for HTML injection safety in email content.
 * You can replace this with a library if you prefer.
 */
// function escapeHtml(input: any) {
//   const s = String(input ?? "");
//   return s
//     .replaceAll("&", "&amp;")
//     .replaceAll("<", "&lt;")
//     .replaceAll(">", "&gt;")
//     .replaceAll('"', "&quot;")
//     .replaceAll("'", "&#39;");
// }


// export async function sendTaskToClient(
//   req: Request & { user?: any },
//   res: Response
// ) {
//   try {
//     const { taskId } = req.body;
//     const orgPrisma = await resolveOrgPrisma(req);

//     // 1️⃣ Fetch task with mail count + clientId
//     const task = await orgPrisma.task.findUnique({
//       where: { id: taskId },
//       select: {
//         id: true,
//         title: true,
//         description: true,
//         clientId: true,
//         startDate: true,
//         dueDate: true,
//         status: true,
//         clientMailSendCount: true, // ✅ include count
//       },
//     });

//     if (!task) {
//       return res.status(404).json({ error: "Task not found" });
//     }
//     if (!task.clientId) {
//       return res.status(400).json({ error: "This task has no linked client" });
//     }

//     // ⛔ Reject if already sent 3 times
//     if (task.clientMailSendCount >= 3) {
//       return res.status(400).json({
//         error: "Send limit reached (3/3)",
//         count: task.clientMailSendCount,
//       });
//     }

//     // 2️⃣ Fetch client
//     const client = await orgPrisma.client.findUnique({
//       where: { id: task.clientId },
//       select: { name: true, email: true },
//     });

//     if (!client?.email) {
//       return res
//         .status(404)
//         .json({ error: "Client not found or has no email" });
//     }

//     // 3️⃣ Fetch attachments (task + occurrence)
//     const [taskAttachments, occAttachments] = await Promise.all([
//       orgPrisma.taskAttachment.findMany({ where: { taskId } }),
//       orgPrisma.taskOccurrenceAttachment.findMany({
//         where: { occurrence: { taskId } },
//       }),
//     ]);

//     const attachmentUrls = await Promise.all(
//       [...taskAttachments, ...occAttachments].map(async (att) => ({
//         id: att.id,
//         url: await getCachedFileUrlFromSpaces(att.key, req.user.orgId),
//       }))
//     );

//     // 5️⃣ Build email HTML with attachment links
//     const html = `
//   <div style="font-family: Arial, sans-serif; background:#f9fafb; padding:20px; color:#111827;">
//     <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.05);">

//       <!-- Header -->
//       <div style="background:#ffffff; padding:24px; text-align:center; border-bottom:1px solid #e5e7eb;">
//         <img src="https://bucket.mailersendapp.com/z3m5jgr8emldpyo6/ywj2lpnw5kmg7oqz/images/9fc9b95f-249b-472e-b63e-2594051491a1.png" alt="TaskBizz" style="height:50px; margin-bottom:8px;" />
//         <h1 style="color:#2563eb; margin:0; font-size:22px;">Task Update</h1>
//       </div>

//       <!-- Task Details -->
//       <div style="padding:24px;">
//         <h2 style="margin-top:0; color:#111827;">${task.title}</h2>
//         <p style="margin:0 0 12px; color:#374151;">${task.description}</p>

//         <table style="width:100%; border-collapse:collapse; margin-top:16px;">
//           <tr>
//             <td style="padding:8px; font-weight:bold; color:#111827;">Due Date:</td>
//             <td style="padding:8px; color:#dc2626; font-weight:600;">
//               ${
//                 task.dueDate ? new Date(task.dueDate).toLocaleDateString() : "—"
//               }
//             </td>
//           </tr>
//           <tr style="background:#f9fafb;">
//             <td style="padding:8px; font-weight:bold; color:#111827;">Status:</td>
//             <td style="padding:8px; color:#2563eb; font-weight:600;">${
//               task.status || "Open"
//             }</td>
//           </tr>
//         </table>

//         <!-- Attachments -->
//         ${
//           attachmentUrls.length > 0
//             ? `
//               <div style="margin-top:20px;">
//                 <h3 style="margin:0 0 8px; color:#111827;">📎 Attachments</h3>
//                 <ul style="margin:0; padding-left:20px; color:#2563eb;">
//                   ${attachmentUrls
//                     .map(
//                       (a) =>
//                         `<li><a href="${a.url}" style="color:#2563eb; text-decoration:underline;">${a.url}</a></li>`
//                     )
//                     .join("")}
//                 </ul>
//               </div>
//             `
//             : `<p style="margin-top:20px; color:#6b7280;">No attachments provided.</p>`
//         }

//         <!-- CTA Button -->
//         <div style="text-align:center; margin-top:30px;">
//           <a href="https://portal.taskbizz.com/client/tasks"
//              style="display:inline-block; padding:12px 24px; background:#2563eb; color:#ffffff; font-weight:bold; text-decoration:none; border-radius:6px;">
//              View Task in TaskBizz
//           </a>
//         </div>
//       </div>

//       <!-- Footer -->
//       <div style="background:#f9fafb; padding:16px; text-align:center; font-size:12px; color:#6b7280;">
//         TaskBizz • Helping you manage tasks smarter
//       </div>
//     </div>
//   </div>
// `;

//     await sendTaskEmail({
//       to: client.email,
//       subject: `Task: ${task.title}`,
//       text: `Details:\n${
//         task.description || ""
//       }\n\nAttachments:\n${attachmentUrls.map((a) => a.url).join("\n")}`,
//       html,
//     });

//     // 6️⃣ Increment count
//     const updated = await orgPrisma.task.update({
//       where: { id: taskId },
//       data: { clientMailSendCount: { increment: 1 } },
//       select: { clientMailSendCount: true },
//     });

//     // Invalidate caches — client UI should re-fetch if needed
//     invalidateOrgCaches(req.user.orgId).catch((e) =>
//       console.warn("invalidateOrgCaches failed", e)
//     );

//     return res.json({
//       success: true,
//       sentTo: client.email,
//       attachments: attachmentUrls.length,
//       count: updated.clientMailSendCount, // ✅ return updated count
//     });
//   } catch (err) {
//     console.error("sendTaskToClient error:", err);
//     res.status(500).json({ error: "Failed to send task" });
//   }
// }

const inflight = new Map<string, Promise<any>>();

// --------- Safe date utils ---------
function parseISODate(v?: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function startOfDaySafe(d: Date) {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}
function endOfDaySafe(d: Date) {
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c;
}

export const getDashboard = async (
  req: Request & { user?: any },
  res: Response
) => {
  try {
    const prisma = getCorePrisma();
    const orgId = req.user.orgId;
    const { start, end, weekStart } = req.query as Record<string, string>;
    const user = req.user;

    /* ================= CACHE ================= */

    const cacheKey = orgKey(
      orgId,
      "dashboard",
      `u=${user.id}:s=${start}:e=${end}`
    );

    const cached = (await cacheGetJson(cacheKey)) as any;
    if (cached) return res.json({ ...cached, cached: true });

    const orgPrisma = await resolveOrgPrisma(req);

    /* ================= DATE ================= */

    const dateStart = new Date(start);
    const dateEnd = new Date(end);
    const now = new Date();

    const selectedWeekStart = weekStart ? new Date(weekStart) : undefined;
    const selectedWeekEnd = selectedWeekStart
      ? endOfWeek(selectedWeekStart, { weekStartsOn: 1 })
      : undefined;

    /* ================= ROLE ================= */

    const isManager = user.role === "MANAGER";
    const managerProjectScope = isManager
      ? { task: { project: { head: user.id } } }
      : undefined;

    /* ================= FETCH (OPTIMIZED DATE FILTER) ================= */

    const [rawOccurrences, projects, clients] = await Promise.all([
      orgPrisma.taskOccurrence.findMany({
        where: {
          OR: [
            { startDate: { gte: dateStart, lte: dateEnd } },
            { dueDate: { gte: dateStart, lte: dateEnd } },
          ],
          ...(managerProjectScope ? managerProjectScope : {}),
        },
        include: {
          task: {
            select: {
              clientId: true,
              status: true,
              projectId: true,
              project: {
                select: { head: true },
              },
            },
          },
        },
        orderBy: { startDate: "asc" },
      }),
      orgPrisma.project.findMany({
        where: isManager ? { head: user.id } : undefined,
      }),
      orgPrisma.client.findMany(),
    ]);

    /* ================= FILTER CANCELLED ================= */

    const occurrences = rawOccurrences.filter((t: any) => {
      const occStatus = (t.status || "").toUpperCase();
      const taskStatus = (t.task?.status || "").toUpperCase();
      return occStatus !== "CANCELLED" && taskStatus !== "CANCELLED";
    });

    /* ================= HELPERS ================= */

    const isTaskCompleted = (t: any) =>
      t.isCompleted === true ||
      (t.status || t.task?.status || "").toUpperCase() === "COMPLETED";

    const isOpen = (t: any) =>
      (t.status || t.task?.status || "").toUpperCase() === "OPEN";

    const toDateSafe = (v: any): Date | null => {
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(v);
      return isNaN(d.getTime()) ? null : d;
    };

    const startOfDaySafe = (d: Date) => {
      const c = new Date(d);
      c.setHours(0, 0, 0, 0);
      return c;
    };

    const endOfDaySafe = (d: Date) => {
      const c = new Date(d);
      c.setHours(23, 59, 59, 999);
      return c;
    };

    const isOverdue = (t: any) => {
      const due = toDateSafe(t.dueDate);
      if (!due) return false;
      if (isTaskCompleted(t)) return false;
      return startOfDaySafe(due) < startOfDaySafe(now);
    };

    /* ================= COMPLETED COUNT ================= */

    const completedTasks = await orgPrisma.taskOccurrence.count({
      where: {
        status: "COMPLETED",
        updatedAt: { gte: dateStart, lte: dateEnd },
        ...(managerProjectScope ?? {}),
      },
    });

    // const completedInOccurrences = occurrences.filter(isTaskCompleted).length;
    // const completedTasks = completedInOccurrences;
    // let completedTasks = 0;

    const assignedTasks = occurrences.filter((t: any) => t.assignedToId).length;

    const completionRate =
      assignedTasks > 0
        ? Math.round((completedTasks / assignedTasks) * 100)
        : 0;


    /* ================= LICENSE / RENEWALS ================= */

    const startToday = startOfDaySafe(now);
    const startTomorrow = new Date(startToday);
    startTomorrow.setDate(startTomorrow.getDate() + 1);
    const nextMonthStart = startOfMonth(addMonths(now, 1));

    const [totalLicenses, expiringThisMonth, expiredLicenses] =
      await Promise.all([
        orgPrisma.license.count(),
        orgPrisma.license.count({
          where: {
            expiresOn: { gte: startTomorrow, lt: nextMonthStart },
          },
        }),
        orgPrisma.license.count({
          where: { expiresOn: { lt: startTomorrow } },
        }),
      ]);

    /* ================= SINGLE PASS AGGREGATION ================= */

    const byProject = new Map<string, any[]>();
    const byUser = new Map<string, any[]>();

    const createdInWindow: any[] = [];
    const completedInWindow: any[] = [];

    const openInWindow: any[] = [];
    const overdueInWindow: any[] = [];

    let openTasks = 0;
    let todayDue = 0;

    const todayStart = startOfDaySafe(now);
    const todayEnd = endOfDaySafe(now);

    for (const t of occurrences) {
      if (t.projectId) {
        if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
        byProject.get(t.projectId)!.push(t);
      }

      if (t.assignedToId) {
        if (!byUser.has(t.assignedToId)) byUser.set(t.assignedToId, []);
        byUser.get(t.assignedToId)!.push(t);
      }

      if (isOpen(t)) {
        openTasks++;
        openInWindow.push(t);
      }

      if (isOverdue(t)) overdueInWindow.push(t);

      const due = toDateSafe(t.dueDate);

      if (!isTaskCompleted(t) && due && due >= todayStart && due <= todayEnd) {
        todayDue++;
      }

      if (t.createdAt >= dateStart && t.createdAt <= dateEnd) {
        createdInWindow.push(t);
      }

      if (isTaskCompleted(t)) {
        const completedTime = t.completedAt || t.updatedAt;
        if (
          completedTime &&
          completedTime >= dateStart &&
          completedTime <= dateEnd
        ) {
          completedInWindow.push(t);
        }
      }
    }

    const weeklyCompletionRate =
      createdInWindow.length > 0
        ? Math.round((completedInWindow.length / createdInWindow.length) * 100)
        : 0;

    /* ================= WEEK DUE ================= */

    const weekDue =
      selectedWeekStart && selectedWeekEnd
        ? occurrences.filter((t: any) => {
            if (isTaskCompleted(t)) return false;
            const due = toDateSafe(t.dueDate);
            return due
              ? due >= selectedWeekStart && due <= selectedWeekEnd
              : false;
          }).length
        : occurrences.filter((t: any) => !isTaskCompleted(t) && t.dueDate)
            .length;

    /* ================= PROJECT PROGRESS ================= */

    const projectProgress = projects.map((p: any) => {
      const pts = byProject.get(p.id) ?? [];
      const done = pts.filter(isTaskCompleted).length;
      return {
        id: p.id,
        name: p.name,
        totalTasks: pts.length,
        completedTasks: done,
        progress: pts.length ? Math.round((done / pts.length) * 100) : 0,
      };
    });

    /* ================= USERS + TEAM STATUS ================= */

    let users = await prisma.user.findMany({ where: { orgId } });

    if (isManager) {
      const involvedIds = new Set(
        occurrences.map((t: any) => t.assignedToId).filter(Boolean)
      );
      users = users.filter((u) => involvedIds.has(u.id));
    }

    const teamStatus = users.map((u) => {
      const uTasks = byUser.get(u.id) ?? [];

      const completed = uTasks.filter(isTaskCompleted).length;
      const open = uTasks.length - completed;
      const overdue = uTasks.filter(isOverdue).length;

      const today = uTasks.filter((t) => {
        if (isTaskCompleted(t)) return false;

        const due = toDateSafe(t.dueDate ?? t.task?.dueDate ?? t.occurrenceDue);

        return due && due >= todayStart && due <= todayEnd;
      }).length;

      return {
        id: u.id,
        name: u.name,

        totalTasks: uTasks.length,
        openTasks: open,
        completedTasks: completed,

        overdueTasks: overdue,
        todayTasks: today,

        overdueIssues: 0,
        todayIssues: 0,
        openIssues: 0,
      };
    });

    /* ================= TASK DISTRIBUTION ================= */

    const counts = rawOccurrences.reduce((acc: any, t: any) => {
      const st = (
        t.status ||
        t.task?.status ||
        (t.isCompleted ? "COMPLETED" : "OPEN")
      )
        .toString()
        .toUpperCase();
      acc[st] = (acc[st] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const taskDistribution = Object.entries(counts).map(([status, count]) => ({
      status,
      count,
    }));

    /* ================= CUSTOMER ACTIVITY ================= */

    const clientAggMap = new Map<string, any>();

    clients.forEach((c: any) => {
      clientAggMap.set(c.id, {
        clientId: c.id,
        clientName: c.name,
        projectIds: new Set<string>(),
        totalProjects: 0,
        activeProjects: 0,
        openTasks: 0,
        completedTasks: 0,
        progressPct: 0,
      });
    });

    for (const t of occurrences) {
      const clientId = t.clientId ?? t.task?.clientId;
      if (!clientId) continue;

      const c = clientAggMap.get(clientId);
      if (!c) continue;

      if (t.projectId) c.projectIds.add(t.projectId);

      if (isTaskCompleted(t)) c.completedTasks++;
      else c.openTasks++;
    }

    // ✅ finalize aggregation ONCE
    clientAggMap.forEach((c) => {
      c.totalProjects = c.projectIds.size;
      const totalTasks = c.openTasks + c.completedTasks;
      c.progressPct = totalTasks
        ? Math.round((c.completedTasks / totalTasks) * 100)
        : 0;

      delete c.projectIds; // clean response
    });

    const customerReport = Array.from(clientAggMap.values()).slice(0, 8);

    const getLastActivityTime = (t: any): number => {
      return (
        t.completedAt?.getTime?.() ??
        t.updatedAt?.getTime?.() ??
        t.createdAt?.getTime?.() ??
        0
      );
    };

    const recentTasks = occurrences
      .filter((t: any) => {
        const st = (t.status || t.task?.status || "").toUpperCase();
        return st !== "CANCELLED";
      })
      .map((t: any) => {
        const lastActivityAt = t.completedAt ?? t.updatedAt ?? t.createdAt;

        const activityType = t.completedAt
          ? "COMPLETED"
          : t.updatedAt && t.updatedAt > t.createdAt
          ? "UPDATED"
          : "CREATED";

        return {
          id: t.id,
          title: t.title,
          status: t.status || t.task?.status || "OPEN",
          priority: t.priority || t.task?.priority || "MEDIUM",
          dueDate: t.dueDate ?? t.task?.dueDate ?? null,
          startDate: t.startDate ?? null,
          assignedToId: t.assignedToId,
          projectId: t.projectId,
          isCompleted: isTaskCompleted(t),
          activityType,
          lastActivityAt,
        };
      })
      .sort(
        (a: any, b: any) =>
          new Date(b.lastActivityAt).getTime() -
          new Date(a.lastActivityAt).getTime()
      )
      .slice(0, 10);

    /* ================= RESPONSE ================= */

    const payload = {
      stats: {
        totalTasks: occurrences.length,
        completedTasks,
        overdueTasks: overdueInWindow.length,
        openTasks,
        totalProjects: projects.length,
        activeProjects: projectProgress.filter(
          (p: any) => p.totalTasks > p.completedTasks
        ).length,
        totalClients: clients.length,
        totalUsers: users.length,
        activeUsers: users.filter((u) => u.status === "ACTIVE").length,
        todayDue,
        weekDue,
        completionRate: completionRate,
        licenses: {
          total: totalLicenses,
          expired: expiredLicenses,
          expiringThisMonth,
          active: Math.max(
            0,
            totalLicenses - expiredLicenses - expiringThisMonth
          ),
        },
      },
      recentTasks: recentTasks,
      overdueTasks: overdueInWindow,
      projectProgress: projectProgress
        .sort((a: any, b: any) => b.totalTasks - a.totalTasks)
        .slice(0, 6),
      taskDistribution,
      customerReport,
      teamStatus,
      weeklyDigest: {
        weekStart: dateStart,
        weekEnd: dateEnd,
        created: createdInWindow.length,
        completed: completedInWindow.length,
        open: openInWindow.length,
        overdue: overdueInWindow.length,
        completionRate: weeklyCompletionRate,
        topPerformers: [],
      },
      deltas: {},
    };

    await cacheSetJson(cacheKey, payload, 120);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load dashboard" });
  }
};

// GET /task/occurrence/:id/docs
// ===== Replace getOccurrenceDocs with the debug version below =====
export async function getOccurrenceDocs(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const occurrenceId = req.params.id;
    const orgId = req.user.orgId;
    const docsEnabled =
      !!req.subscriptionCtx?.plan?.features?.features?.documentManagement;

    // DEBUG logs
    // console.log(
    //   `[DEBUG getOccurrenceDocs] org=${orgId} occurrence=${occurrenceId} docsEnabled=${docsEnabled}`
    // );

    const orgPrisma = await resolveOrgPrisma(req);

    // Quick DB counts for debugging (non-destructive)
    try {
      const [taskAttachmentCount, occAttachmentCount, occRow] =
        await Promise.all([
          orgPrisma.taskAttachment
            .count({
              where: { task: { occurrences: { some: { id: occurrenceId } } } },
            })
            .catch((e: any) => {
              // Fall back: taskAttachment count for the task related to occurrence (if we can fetch occurrence)
              return 0;
            }),
          orgPrisma.taskOccurrenceAttachment
            .count({
              where: { occurrenceId },
            })
            .catch((e: any) => 0),
          orgPrisma.taskOccurrence
            .findUnique({
              where: { id: occurrenceId },
              include: { task: true },
            })
            .catch(() => null),
        ]);

      // console.log(
      //   `[DEBUG getOccurrenceDocs] counts: taskAttachments=${taskAttachmentCount} occurrenceAttachments=${occAttachmentCount}`
      // );
      // if (occRow && occRow.task) {
      //   console.log(
      //     `[DEBUG getOccurrenceDocs] occurrence.taskId=${occRow.task.id} task.title=${occRow.task.title}`
      //   );
      // }
    } catch (countErr) {
      console.warn("[DEBUG getOccurrenceDocs] count check failed:", countErr);
    }

    // Fetch occurrence with attachments (task + occurrence)
    const occ = await orgPrisma.taskOccurrence.findUnique({
      where: { id: occurrenceId },
      include: {
        attachments: true, // occurrence-specific attachments
        task: {
          include: { attachments: true }, // task-level attachments
        },
      },
    });

    if (!occ) {
      // console.log(`[DEBUG getOccurrenceDocs] occurrence not found: ${occurrenceId}`);
      return res.status(404).json({ message: "Occurrence not found" });
    }

    // Make sure we actually have raw DB rows
    const occRaw = Array.isArray(occ.attachments) ? occ.attachments : [];
    const taskRaw = Array.isArray(occ.task?.attachments) ? occ.task.attachments : [];

    // console.log(
    //   `[DEBUG getOccurrenceDocs] raw rows: occRaw=${occRaw.length} taskRaw=${taskRaw.length}`
    // );

    // Build presigned URLs robustly and log any presign errors
    const occAttachmentsWithUrls = await Promise.all(
      occRaw.map(async (att: any) => {
        try {
          const url = await getCachedFileUrlFromSpaces(att.key, orgId);
          if (!url) {
            console.warn(
              "[DEBUG getOccurrenceDocs] presign returned falsy URL for",
              att.key
            );
          }
          return {
            id: att.id,
            key: att.key,
            url,
            type: "occurrence",
            source: "occurrence_specific",
          };
        } catch (err) {
          console.error(
            "[DEBUG getOccurrenceDocs] presign failed for",
            att.key,
            err
          );
          return {
            id: att.id,
            key: att.key,
            url: null,
            type: "occurrence",
            source: "occurrence_specific",
            presignError: String(err),
          };
        }
      })
    );

    const taskAttachmentsWithUrls = await Promise.all(
      taskRaw.map(async (att: any) => {
        try {
          const url = await getCachedFileUrlFromSpaces(att.key, orgId);
          if (!url) {
            console.warn(
              "[DEBUG getOccurrenceDocs] presign returned falsy URL for",
              att.key
            );
          }
          return {
            id: att.id,
            key: att.key,
            url,
            type: "task",
            source: "task_level",
          };
        } catch (err) {
          console.error(
            "[DEBUG getOccurrenceDocs] presign failed for",
            att.key,
            err
          );
          return {
            id: att.id,
            key: att.key,
            url: null,
            type: "task",
            source: "task_level",
            presignError: String(err),
          };
        }
      })
    );

    // For debugging: return attachments even if docsEnabled is false so client can see DB state.
    // Remove this bypass when done.
    if (!docsEnabled) {
      console.warn(`[DEBUG getOccurrenceDocs] docsEnabled is false for org=${orgId}; returning DB attachments for debug`);
    }

    res.json({
      attachments: occAttachmentsWithUrls,
      taskAttachments: taskAttachmentsWithUrls,
      debug: {
        docsEnabled,
        rawCounts: { occRaw: occRaw.length, taskRaw: taskRaw.length },
      },
    });
  } catch (err) {
    console.error("getOccurrenceDocs error:", err);
    res.status(500).json({ message: "Failed to fetch occurrence docs", err });
  }
}

// DELETE /task/attachment/:id
export async function deleteTaskAttachment(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const { id } = req.params;
    const orgPrisma = await resolveOrgPrisma(req);

    const att = await orgPrisma.taskAttachment.findUnique({ where: { id } });
    if (!att) return res.status(404).json({ message: "Attachment not found" });

    // OPTIONAL: verify att.taskId belongs to org (if multi-tenant) or check permissions

    // delete S3 object (best-effort)
    try {
      await deleteFileFromSpaces(att.key);
    } catch (s3Err) {
      console.warn("[deleteTaskAttachment] S3 delete failed for", att.key, s3Err);
      // still proceed to try DB delete — don't block client for S3 issues
    }

    await orgPrisma.taskAttachment.delete({ where: { id } });

    // invalidate caches & emit task:update so other clients refresh if necessary
    // await invalidateOrgCaches(req.user.orgId).catch(() => {});
    req.io?.to(`org:${req.user.orgId}`).emit("task:attachment:deleted", { orgId: req.user.orgId, attachmentId: id, taskId: att.taskId });

    return res.json({ ok: true, id });
  } catch (err) {
    console.error("deleteTaskAttachment error:", err);
    return res.status(500).json({ message: "Failed to delete attachment", err });
  }
}

// import { notifyOccurrenceAssigneesAndClient } from "../utils/notifyUtils"; // (make sure this stays)
export async function bulkUpdateOccurrences(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const prisma = getCorePrisma();
    const {
      ids,
      status,
      assignedToId,
      assignedToIds: rawAssignedToIds,
    } = req.body ?? {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids (array) is required" });
    }

    // helpers
    const normalizeAssignedToIds = (v: any): string[] | undefined => {
      if (v === undefined || v === null) return undefined;
      if (Array.isArray(v))
        return v
          .map(String)
          .map((s) => s.trim())
          .filter(Boolean);
      if (typeof v === "string") {
        const trimmed = v.trim();
        try {
          const parsed = JSON.parse(trimmed);
          if (Array.isArray(parsed))
            return parsed
              .map(String)
              .map((s) => s.trim())
              .filter(Boolean);
        } catch {}
        if (trimmed.includes(","))
          return trimmed
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
        if (trimmed === "") return [];
        return [trimmed];
      }
      return undefined;
    };

    const assignedToIds: string[] | undefined =
      rawAssignedToIds !== undefined
        ? normalizeAssignedToIds(rawAssignedToIds)
        : assignedToId !== undefined
        ? normalizeAssignedToIds(assignedToId)
        : undefined;

    const orgPrisma = await resolveOrgPrisma(req);

    // 1) Permission
    const denied: string[] = [];
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await canEmployeeEditOccurrence(orgPrisma, prisma, req, id);
      if (!ok) denied.push(id);
    }
    if (denied.length) {
      return res.status(403).json({
        message: "You are not allowed to update some occurrences",
        denied,
      });
    }

    // track
    let deletedAssigneeRows = 0;
    let createdAssigneeRows = 0;

    // 2) TX — update only occurrence-level fields + join rows
    await orgPrisma.$transaction(async (tx: any) => {
      const data: any = {};
      if (typeof status === "string") data.status = status;

      // (Optional) still set scalar occurrence.assignedToId for legacy UX:
      if (typeof assignedToId === "string") {
        data.assignedToId = assignedToId;
      } else if (assignedToIds !== undefined) {
        data.assignedToId = assignedToIds.length > 0 ? assignedToIds[0] : null;
      }

      if (Object.keys(data).length) {
        await tx.taskOccurrence.updateMany({
          where: { id: { in: ids } },
          data,
        });
      }

      // Replace occurrence-level join rows when assignedToIds explicitly provided
      if (assignedToIds !== undefined) {
        const delRes = await tx.taskOccurrenceAssignee.deleteMany({
          where: { occurrenceId: { in: ids } },
        });
        deletedAssigneeRows =
          (delRes && typeof (delRes as any).count === "number"
            ? (delRes as any).count
            : typeof delRes === "number"
            ? delRes
            : 0) ?? 0;

        if (assignedToIds.length > 0) {
          const createPayload: Array<{ occurrenceId: string; userId: string }> =
            [];
          for (const occId of ids) {
            for (const uid of assignedToIds) {
              createPayload.push({ occurrenceId: occId, userId: uid });
            }
          }

          const CHUNK = 500;
          for (let i = 0; i < createPayload.length; i += CHUNK) {
            const chunk = createPayload.slice(i, i + CHUNK);
            const createRes = await tx.taskOccurrenceAssignee.createMany({
              data: chunk,
              skipDuplicates: true,
            });
            const added =
              (createRes && typeof (createRes as any).count === "number"
                ? (createRes as any).count
                : chunk.length) ?? chunk.length;
            createdAssigneeRows += added;
          }
        }
      }
    });

    // 3) Fetch updated occurrences
    const updatedOccurrences = await orgPrisma.taskOccurrence.findMany({
      where: { id: { in: ids } },
      include: {
        task: { select: { title: true, clientId: true } }, // no task-level assignees now
        assignees: { select: { userId: true } }, // ✅ occurrence-level only
      },
    });

    // 3.5) Email clients on status change (only if `status` present + client opted in)
    if (typeof status === "string") {
      const orgId = req.user.orgId;

      // fetch client opt-ins
      const clientIds = Array.from(
        new Set(
          updatedOccurrences
            .map((o: any) => o.task?.clientId)
            .filter((cid: string | null | undefined): cid is string => !!cid)
        )
      );

      const optInMap: Record<string, boolean> = {};
      if (clientIds.length > 0) {
        type ClientMini = { id: string; clientCommunication: boolean | null };
        const clients = (await orgPrisma.client.findMany({
          where: { id: { in: clientIds } },
          select: { id: true, clientCommunication: true },
        })) as ClientMini[];
        for (const c of clients) optInMap[c.id] = !!c.clientCommunication;
      }

      // Helper: download attachments for a single occurrence and return Nodemailer-style attachments + fallback URLs.
      // It will avoid attaching files if total size > MAX_ATTACHMENT_BYTES.
      const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB threshold, adjust as needed

      async function prepareAttachmentsForOccurrence(occurrenceId: string) {
        const result: {
          attachments: Array<{
            filename: string;
            content: Buffer;
            contentType?: string;
          }>;
          fallbackUrls: string[];
          totalBytes: number;
        } = { attachments: [], fallbackUrls: [], totalBytes: 0 };

        try {
          // get the taskId for this occurrence
          const occRow = await orgPrisma.taskOccurrence.findUnique({
            where: { id: occurrenceId },
            select: { taskId: true },
          });
          const taskId = occRow?.taskId;
          if (!taskId) return result;

          const [taskAttachments, occAttachments] = await Promise.all([
            orgPrisma.taskAttachment.findMany({ where: { taskId } }),
            orgPrisma.taskOccurrenceAttachment.findMany({
              where: { occurrenceId },
            }),
          ]);

          const allAttachments = [...taskAttachments, ...occAttachments];
          if (allAttachments.length === 0) return result;

          const axios = (await import("axios")).default;

          await Promise.all(
            allAttachments.map(async (att: any) => {
              try {
                const url = await getCachedFileUrlFromSpaces(
                  att.key,
                  req.user.orgId
                );
                const resp = await axios.get(url, {
                  responseType: "arraybuffer",
                  validateStatus: (s: number) => s >= 200 && s < 300,
                });
                const buf = Buffer.from(resp.data as ArrayBuffer);

                const filename =
                  att.filename ||
                  String(att.key).split("/").filter(Boolean).pop() ||
                  `attachment-${att.id || Date.now()}`;

                const contentType =
                  (resp.headers && (resp.headers["content-type"] as string)) ||
                  undefined;

                result.attachments.push({
                  filename,
                  content: buf,
                  contentType,
                });
                result.totalBytes += buf.length;
              } catch (dlErr) {
                console.warn(
                  `[bulkUpdateOccurrences] failed download for att ${
                    att.id || att.key
                  } (occ ${occurrenceId}):`,
                  (dlErr as any)?.message ?? dlErr
                );
                try {
                  const url = await getCachedFileUrlFromSpaces(
                    att.key,
                    req.user.orgId
                  );
                  result.fallbackUrls.push(url);
                } catch (e) {
                  // ignore
                }
              }
            })
          );

          // If total size too big, drop attachments and only provide fallback links
          if (result.totalBytes > MAX_ATTACHMENT_BYTES) {
            console.info(
              `[bulkUpdateOccurrences] total attachments for occurrence ${occurrenceId} exceed ${MAX_ATTACHMENT_BYTES} bytes; sending links instead of attachments`
            );
            // Attempt to generate signed URLs for all attachments
            result.attachments = [];
            const signedPromises = allAttachments.map(async (att: any) => {
              try {
                return await getCachedFileUrlFromSpaces(
                  att.key,
                  req.user.orgId
                );
              } catch {
                return null;
              }
            });
            const signed = await Promise.all(signedPromises);
            for (const s of signed) if (s) result.fallbackUrls.push(s);
            result.totalBytes = 0;
          }
        } catch (e) {
          console.warn(
            `[bulkUpdateOccurrences] prepareAttachmentsForOccurrence failed for ${occurrenceId}:`,
            (e as any)?.message ?? e
          );
        }

        return result;
      }

      // Build per-occurrence email jobs (concurrent but downloads happen per item)
      const emailJobs = updatedOccurrences.map(async (occ: any) => {
        const clientId = occ.task?.clientId as string | undefined;
        if (!clientId || !optInMap[clientId]) return;

        const title = occ.task?.title || occ.title || "Your Task";
        const emailSubject = `Status Update: ${title}`;
        const emailBody = `
          <p><strong>Current Status:</strong> ${occ.status}</p>
          ${
            occ.dueDate
              ? `<p><strong>Due Date:</strong> ${new Date(
                  occ.dueDate
                ).toLocaleDateString()}</p>`
              : ""
          }
        `.trim();

        try {
          // Prepare attachments for this occurrence (downloads + fallback links)
          const { attachments, fallbackUrls } =
            await prepareAttachmentsForOccurrence(occ.id);

          // Prepare notify options, pass attachments/fallbackUrls through
          const notifyOpts: NotifyOptions = {
            sendAssigneeEmails: false,
            sendInAppNotifications: false,
            respectClientOptIn: true,
            attachments: attachments.length ? attachments : undefined,
            fallbackUrls: fallbackUrls.length ? fallbackUrls : undefined,
          };

          await notifyOccurrenceAssigneesAndClient(
            orgPrisma,
            prisma,
            req.io,
            orgId,
            occ.id,
            emailSubject,
            emailBody,
            undefined,
            notifyOpts
          );
        } catch (e) {
          console.warn("Client email notify failed for occ", occ.id, e);
        }
      });

      await Promise.allSettled(emailJobs);
    }

    // 4) (Optional) internal notifications – unchanged
    await Promise.all(
      updatedOccurrences.map(async (occ: any) => {
        // ✅ Fetch occurrence assignees for each occurrence
        const occAssignees = await orgPrisma.taskOccurrenceAssignee.findMany({
          where: { occurrenceId: occ.id },
          select: { userId: true },
        });

        try {
          await notifyCounterparties({
            orgPrisma,
            corePrisma: prisma,
            io: req.io,
            orgId: req.user.orgId,
            actor: { id: req.user.id, role: req.user.role },
            assigneeIds: occAssignees.map((a: any) => a.userId),
            payload: {
              type: "OCCURRENCE_UPDATED",
              title: `Task updated: ${occ.title ?? "Untitled"}`,
              body: `Status: ${occ.status ?? "N/A"}`,
              taskId: occ.taskId,
              occurrenceId: occ.id,
              projectId: occ.projectId ?? undefined,
            },
          });
        } catch (e) {
          console.warn("notifyCounterparties failed for occ", occ.id, e);
        }
      })
    );

    // 5) Emit via websocket
    const orgId = req.user.orgId;
    req.io.to(`org:${orgId}`).emit("occurrence:bulk", {
      orgId,
      occurrences: updatedOccurrences.map((u: any) => ({
        id: u.id,
        taskId: u.taskId,
        title: u.title,
        status: u.status,
        assignedToId: u.assignedToId, // legacy scalar (optional)
        assignedToIds: (u as any).assignees?.map((a: any) => a.userId) ?? [], // ✅ source of truth
        priority: u.priority,
        clientId: u.clientId,
        projectId: u.projectId,
        startDate: u.startDate,
        dueDate: u.dueDate,
        isCompleted: u.isCompleted ?? false,
      })),
    });

    return res.json({
      ok: true,
      occurrences: updatedOccurrences,
      debug: {
        assignedToIdsProvided: assignedToIds !== undefined,
        deletedAssigneeRows,
        createdAssigneeRows,
        taskAssigneesUpdated: 0, // no longer syncing task-level
      },
    });
  } catch (err) {
    console.error("bulkUpdateOccurrences error:", err);
    res.status(500).json({ message: "Failed to update occurrences", err });
  }
}

/**
 * POST /api/task/occurrence/copy-attachments
 *
 * Body:
 * {
 *   mappings: [
 *     { fromOccurrenceId: string, toOccurrenceId: string },
 *     ...
 *   ]
 * }
 *
 * Copies attachment DB rows from `fromOccurrenceId` to `toOccurrenceId`.
 * - Does NOT re-upload files; it duplicates DB rows pointing to the same storage key.
 * - Skips creating a duplicate if an attachment with the same key already exists
 *   for the destination occurrence.
 */
export async function copyOccurrenceAttachments(req: Request & { user?: any }, res: Response) {
  try {
    const userId = req.user?.id ?? null;

    const { mappings } = req.body as {
      mappings?: Array<{ fromOccurrenceId: string; toOccurrenceId: string }>;
    };

    if (!Array.isArray(mappings) || mappings.length === 0) {
      return res
        .status(400)
        .json({ error: "mappings (array) is required in request body" });
    }

    for (const m of mappings) {
      if (!m?.fromOccurrenceId || !m?.toOccurrenceId) {
        return res
          .status(400)
          .json({
            error:
              "Each mapping must include fromOccurrenceId and toOccurrenceId",
          });
      }
    }

    const summary: Array<{
      fromOccurrenceId: string;
      toOccurrenceId: string;
      found: number;
      copied: number;
      skippedDuplicates: number;
    }> = [];

    const orgPrisma = await resolveOrgPrisma(req);

    // Use prisma transaction; inside we cast tx to `any` (txAny) so TS won't complain
    await orgPrisma.$transaction(async (tx: any) => {
      // txAny is the same runtime object but with `any` typing for flexibility
      const txAny = tx as any;

      for (const mapping of mappings) {
        const { fromOccurrenceId, toOccurrenceId } = mapping;

        // fetch attachments from source occurrence
        // (using txAny to avoid TS errors if the generated client type differs)
        const srcAttachments: Array<{
          id: string;
          occurrenceId: string;
          key: string;
          createdAt?: Date;
        }> = await txAny.taskOccurrenceAttachment.findMany({
          where: { occurrenceId: fromOccurrenceId },
        });

        let copied = 0;
        let skipped = 0;

        for (const att of srcAttachments) {
          // Duplicate detection: same key already exists on target occurrence
          const exists = await txAny.taskOccurrenceAttachment.findFirst({
            where: {
              occurrenceId: toOccurrenceId,
              key: att.key,
            },
          });

          if (exists) {
            skipped++;
            continue;
          }

          // create duplicate row pointing to same key
          await txAny.taskOccurrenceAttachment.create({
            data: {
              occurrenceId: toOccurrenceId,
              key: att.key,
            },
          });

          copied++;
        }

        summary.push({
          fromOccurrenceId,
          toOccurrenceId,
          found: srcAttachments.length,
          copied,
          skippedDuplicates: skipped,
        });
      }
    });

    return res.status(200).json({ ok: true, summary });
  } catch (err) {
    console.error("copyOccurrenceAttachments error:", err);
    return res
      .status(500)
      .json({
        error: "Failed to copy occurrence attachments",
        details: String(err),
      });
  }
}

// DELETE /task/occurrence/:occurrenceId/docs/:attachmentId
export async function deleteOccurrenceAttachment(
  req: Request & { user?: any },
  res: Response
) {
  try {
    const { occurrenceId, attachmentId } = { occurrenceId: req.params.occurrenceId, attachmentId: req.params.attachmentId };
    const orgPrisma = await resolveOrgPrisma(req);

    // ensure the attachment belongs to this occurrence
    const att = await orgPrisma.taskOccurrenceAttachment.findUnique({
      where: { id: attachmentId },
    });

    if (!att || String(att.occurrenceId) !== String(occurrenceId)) {
      return res.status(404).json({ message: "Occurrence attachment not found" });
    }

    // best-effort delete file from storage
    try {
      await deleteFileFromSpaces(att.key);
    } catch (s3Err) {
      console.warn("[deleteOccurrenceAttachment] file delete failed for", att.key, s3Err);
      // continue to delete DB row anyway
    }

    await orgPrisma.taskOccurrenceAttachment.delete({ where: { id: attachmentId } });

    // emit socket event so other clients can refresh
    req.io?.to(`org:${req.user.orgId}`).emit("occurrence:attachment:deleted", {
      orgId: req.user.orgId,
      occurrenceId,
      attachmentId,
    });

    return res.json({ ok: true, id: attachmentId });
  } catch (err) {
    console.error("deleteOccurrenceAttachment error:", err);
    return res.status(500).json({ message: "Failed to delete occurrence attachment", err });
  }
}

// Utility: very simple HTML → text (fallback if you don't already have one)
function plainTextFromHtml(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type NotifyAttachment = {
  filename: string;
  content: Buffer | string;
  contentType?: string;
};
type NotifyOptions = {
  sendAssigneeEmails?: boolean; // default false
  sendInAppNotifications?: boolean; // default false
  respectClientOptIn?: boolean; // default false (force send to client)
  attachments?: NotifyAttachment[];
  fallbackUrls?: string[];
};

export async function notifyOccurrenceAssigneesAndClient(
  orgPrisma: any,
  corePrisma: any,
  io: any,
  orgId: string,
  occurrenceId: string,
  emailSubject: string,   // used for assignees
  emailBody: string,      // HTML body for assignees (not used for client now)
  notificationPayload?: {
    type: string;
    title: string;
    body: string;
    taskId: string;
    occurrenceId: string;
  },
  opts: NotifyOptions = {}
): Promise<{
  emailsSent: number;
  notificationsSent: number;
  clientEmailSent: boolean;
  recipients: { assignees: string[]; client?: string };
}> {
  const {
    sendAssigneeEmails = false,
    sendInAppNotifications = false,
    respectClientOptIn = false,
  } = opts;

  // 1) Load occurrence with task, client ref (+ fields we need for the template)
  const occurrence = await orgPrisma.taskOccurrence.findUnique({
    where: { id: occurrenceId },
    include: {
      assignees: { select: { userId: true } },
      task: {
        select: {
          clientId: true,
          title: true,
        },
      },
    },
  });

  if (!occurrence) {
    return {
      emailsSent: 0,
      notificationsSent: 0,
      clientEmailSent: false,
      recipients: { assignees: [] },
    };
  }

  // 1.a) Org name for header
  // Adjust table/column names if your core schema differs
  let organizationName = "TaskBizz";
  try {
    const orgRow = await corePrisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    });
    if (orgRow?.name) organizationName = orgRow.name;
  } catch {
    // ignore, fallback remains
  }

  const assigneeUserIds: string[] = occurrence.assignees?.map((a: any) => a.userId) || [];

  // 2) Fetch assignees (we need them for the email content regardless)
  const assigneeUsers =
    assigneeUserIds.length > 0
      ? await corePrisma.user.findMany({
          where: { id: { in: assigneeUserIds } },
          select: { id: true, name: true, email: true, phone: true },
        })
      : [];

  // Build "Assigned Person" HTML
  const assigneeNameEmailHtml =
    assigneeUsers.length > 0
      ? assigneeUsers
          .map((u: any) => {
            const name = u.name || "User";
            const email = u.email ? ` <a href="mailto:${u.email}">${u.email}</a>` : "";
            return `<div>${name}${email}</div>`;
          })
          .join("")
      : "—";

  // Build "Contact" text (numbers only)
  const contactNumbersText =
    assigneeUsers
      .map((u: any) => (u.phone || "").toString().trim())
      .filter(Boolean)
      .join(", ") || "—";

  // 2.b) Try to pull attachments (optional; ignore errors if table differs)
  let attachmentsHtmlSection = "";
  try {
    const attachments = await orgPrisma.taskOccurrenceAttachment.findMany({
      where: { occurrenceId },
      select: { id: true, filename: true, url: true },
      orderBy: { createdAt: "asc" },
    });

    if (attachments && attachments.length > 0) {
      const list = attachments
        .map(
          (a: any) =>
            `<li style="margin:4px 0;">
               ${
                 a.url
                   ? `<a href="${a.url}" style="color:#2563eb; text-decoration:none;">${a.filename || "Attachment"}</a>`
                   : `${a.filename || "Attachment"}`
               }
             </li>`
        )
        .join("");

      attachmentsHtmlSection = `
        <div style="margin-top:16px;">
          <div style="font-weight:bold; color:#111827; margin-bottom:8px;">Attachments</div>
          <ul style="padding-left:18px; margin:0; color:#111827;">${list}</ul>
        </div>
      `;
    }
  } catch {
    // If the model/table name is different, just leave this section empty
    attachmentsHtmlSection = "";
  }

  // 3) Client (for sending email)
  const client =
    occurrence.task?.clientId
      ? await orgPrisma.client.findUnique({
          where: { id: occurrence.task.clientId },
          select: { id: true, name: true, email: true, mobile:true, clientCommunication: true },
        })
      : null;

  let emailsSent = 0;
  let notificationsSent = 0;
  let clientEmailSent = false;
  const recipients: { assignees: string[]; client?: string } = { assignees: [] };

  // 4) Email assignees (optional; unchanged)
  const assigneeEmailPromises =
    sendAssigneeEmails
      ? assigneeUsers
          .filter((u: any) => !!u.email)
          .map(async (user: any) => {
            try {
              await sendTaskEmail({
                to: user.email!,
                subject: emailSubject,
                text: plainTextFromHtml(emailBody),
                html: emailBody,
              });
              emailsSent++;
              recipients.assignees.push(user.email!);
            } catch (err) {
              console.error(`Failed to email assignee ${user.id} (${user.email}):`, err);
            }
          })
      : [];

  // 5) Email client (CURRENT STATUS UI)
  let clientEmailPromise = Promise.resolve();
  if (client?.email && (client.clientCommunication || !respectClientOptIn)) {
    const dueDateStr = occurrence.dueDate
      ? new Date(occurrence.dueDate).toLocaleDateString()
      : "—";

    // Build the exact UI you provided (uses current status)
    const html = `
      <div style="font-family: Arial, sans-serif; background:#f9fafb; padding:20px; color:#111827;">
        <div style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.05);">
          
          <!-- Header -->
          <div style="background:#ffffff; padding:20px; text-align:center; border-bottom:1px solid #e5e7eb;">
            <h2 style="margin:0; color:#111827; font-size:18px;">${organizationName}</h2>
            <h3 style="margin:6px 0 0; color:#2563eb; font-size:16px;">${
              occurrence.title ?? "Task"
            }</h3>
          </div>

          <div style="padding:20px;">
            <table style="width:100%; border-collapse:collapse;">
              <tr style="background:#f9fafb;">
                <td style="padding:8px; font-weight:bold; color:#111827;">Current Status:</td>
                <td style="padding:8px; color:#111827;">${
                  occurrence.status ?? "—"
                }</td>
              </tr>
              <tr>
                <td style="padding:8px; font-weight:bold; color:#111827;">Assigned Person:</td>
                <td style="padding:8px; color:#111827;">${assigneeNameEmailHtml}</td>
              </tr>
              <tr style="background:#f9fafb;">
                <td style="padding:8px; font-weight:bold; color:#111827;">Contact:</td>
                <td style="padding:8px; color:#111827;">${contactNumbersText}</td>
              </tr>
              <tr>
                <td style="padding:8px; font-weight:bold; color:#111827;">Due Date for Submission:</td>
                <td style="padding:8px; color:#111827;">${dueDateStr}</td>
              </tr>
            </table>

            <div style="margin-top:16px; color:#374151;">
              <p style="margin:0 0 8px;">${occurrence.description ?? ""}</p>
            </div>

            ${attachmentsHtmlSection}
          </div>

          <div style="background:#f9fafb; padding:12px; text-align:center; font-size:12px; color:#6b7280;">
            <div style="font-size:12px; color:#6b7280; margin-bottom:6px;">
              Please do not reply to this email. This inbox is not monitored.
            </div>
            <div>
              Powered by TaskBizz - manage Business in smarter way
            </div>
          </div>

        </div>
      </div>
    `.trim();

    const subject = `Status Update: ${occurrence.task?.title || occurrence.title || "Your Task"}`;
    const text = plainTextFromHtml(html);

 clientEmailPromise = (async () => {
   try {
     // Prepare final HTML by appending fallback links (if any)
     let finalHtml = html;
     const fallbackLinks = Array.isArray((opts as any)?.fallbackUrls)
       ? (opts as any).fallbackUrls
       : [];

     if (fallbackLinks.length > 0) {
       finalHtml += `<div style="margin-top:12px;"><strong>Attachment links:</strong><br/>${fallbackLinks
         .map((u: string) => `<a href="${u}">${u}</a>`)
         .join("<br/>")}</div>`;
     }

     // If opts.attachments provided, prepare both shapes (nodemailer & api/base64)
     const providedAttachments = Array.isArray((opts as any)?.attachments)
       ? (opts as any).attachments
       : [];

     // Build a small attachments-summary section for the HTML (shows filenames)
     if (providedAttachments.length > 0) {
       const fileListHtml = providedAttachments
         .map((a: any) => `<li>${a.filename ?? "Attachment"}</li>`)
         .join("");
       finalHtml += `
        <div style="margin-top:12px;">
          <div style="font-weight:600; color:#111827; margin-bottom:6px;">Attached files</div>
          <ul style="margin:0 0 0 18px; padding:0; color:#111827;">${fileListHtml}</ul>
        </div>
      `;
     }

     const subjectWithTask =
       subject ||
       `Status Update: ${
         occurrence.task?.title || occurrence.title || "Your Task"
       }`;

     // Choose mailer shape (default nodemailer)
     const mailerType = (process.env.MAILER_TYPE || "nodemailer").toLowerCase();

     if (mailerType === "api") {
       // convert to API/base64 attachments
       const apiAttachments = providedAttachments.map((a: any) => ({
         content:
           a.content instanceof Buffer
             ? (a.content as Buffer).toString("base64")
             : String(a.content || ""),
         filename: a.filename,
         type: a.contentType || "application/octet-stream",
         disposition: "attachment",
       }));

       await sendTaskEmail({
         to: client.email!,
         subject: subjectWithTask,
         text: plainTextFromHtml(finalHtml),
         html: finalHtml,
         attachments: apiAttachments.length ? apiAttachments : undefined,
       });
     } else {
       // nodemailer-style: Buffer attachments
       const nodemailerAttachments = providedAttachments.map((a: any) => ({
         filename: a.filename,
         content: a.content,
         contentType: a.contentType,
       }));

       await sendTaskEmail({
         to: client.email!,
         subject: subjectWithTask,
         text: plainTextFromHtml(finalHtml),
         html: finalHtml,
         attachments: nodemailerAttachments.length
           ? nodemailerAttachments
           : undefined,
       });
     }

     clientEmailSent = true;
     recipients.client = client.email!;
     emailsSent++;

     // Fire WhatsApp / service update as before (keeps your existing behavior)
     void (async () => {
       try {
         const dueDateStr2 = occurrence.dueDate
           ? new Date(occurrence.dueDate).toLocaleDateString("en-IN")
           : "—";
         const primaryAssigneeName = assigneeUsers[0]?.name ?? "Team";

         await sendTaskBizzServiceUpdate({
           phone: client.mobile || "",
           organizationName,
           clientName: client.name ?? "",
           work: occurrence.title ?? "Task",
           dueDate: dueDateStr2,
           assignedTo: primaryAssigneeName,
           status: occurrence.status ?? "OPEN",
           refId: `OCC-${Date.now()}`,
         });
       } catch (e) {
         console.warn("[WA] Client send failed:", (e as any)?.message ?? e);
       }
     })();
   } catch (error) {
     console.error(`Failed to send client email to ${client.email}:`, error);
   }
 })();
  }

  // 6) In-app notifications (optional; unchanged)
  const notificationPromises =
    sendInAppNotifications
      ? assigneeUsers.map(async (user: any) => {
          if (!notificationPayload) return;
          try {
            await notifyCounterparties({
              orgPrisma,
              corePrisma,
              io,
              orgId,
              actor: { id: "system", role: "SYSTEM" },
              assignedToId: user.id,
              payload: notificationPayload,
            });
            notificationsSent++;
          } catch (error) {
            console.error(`Failed to send notification to ${user.id}:`, error);
          }
        })
      : [];

  // 7) Await all
  await Promise.allSettled([...assigneeEmailPromises, clientEmailPromise, ...notificationPromises]);

  return { emailsSent, notificationsSent, clientEmailSent, recipients };
}

/**
 * Enhanced updateOccurrenceStatus with client email notifications
 */


/**
 * Enhanced task creation with client email notifications
 */
export async function sendTaskCreationNotifications(
  orgPrisma: any,
  corePrisma: any,
  io: any,
  orgId: string,
  taskId: string,
  occurrenceAssigneeIds: string[],
  creatorId: string
) {
  try {
    // Get task details
    const task = await orgPrisma.task.findUnique({
      where: { id: taskId },
      include: {
        client: {
          select: { 
            id: true, 
            name: true, 
            email: true, 
            clientCommunication: true 
          }
        }
      }
    });

    if (!task) return;

    // Get creator details
    const creator = await corePrisma.user.findUnique({
      where: { id: creatorId },
      select: { name: true }
    });
    const creatorName = creator?.name || "TaskBizz Team";

    // Send notifications to assignees
    if (occurrenceAssigneeIds.length > 0) {
      const assigneeUsers = await corePrisma.user.findMany({
        where: { 
          id: { in: occurrenceAssigneeIds },
          clientCommunication: true 
        },
        select: { id: true, name: true, email: true }
      });

      for (const user of assigneeUsers) {
        try {
          await sendEmail(
            user.email,
            `New Task Assigned: ${task.title}`,
            `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>New Task Assignment</h2>
              <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <h3 style="margin-top: 0;">${task.title}</h3>
                <p><strong>Description:</strong> ${task.description || 'No description provided'}</p>
                <p><strong>Due Date:</strong> ${DateTime.fromJSDate(task.dueDate).toFormat("dd LLL yyyy")}</p>
                <p><strong>Priority:</strong> ${task.priority || 'Normal'}</p>
                <p><strong>Assigned by:</strong> ${creatorName}</p>
              </div>
              <p style="color: #666; font-size: 12px;">
                This is an automated notification from TaskBizz. Please do not reply to this email.
              </p>
            </div>`
          );
          // console.log(`Task creation email sent to assignee ${user.email}`);
        } catch (emailErr) {
          console.warn(`Failed to send assignment email to ${user.email}:`, emailErr);
        }
      }
    }

    // Send notification to client if conditions are met
    if (task.client && task.client.email && task.client.clientCommunication) {
      try {
        await sendEmail(
          task.client.email,
          `New Task Created: ${task.title}`,
          `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>New Task Created</h2>
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <h3 style="margin-top: 0;">${task.title}</h3>
              <p>Dear ${task.client.name || 'Valued Client'},</p>
              <p>A new task has been created for you:</p>
              <p><strong>Description:</strong> ${task.description || 'No description provided'}</p>
              <p><strong>Due Date:</strong> ${DateTime.fromJSDate(task.dueDate).toFormat("dd LLL yyyy")}</p>
              <p><strong>Priority:</strong> ${task.priority || 'Normal'}</p>
              <p><strong>Status:</strong> ${task.status || 'Open'}</p>
            </div>
            <p style="margin-top: 20px;">
              We will keep you updated on the progress. If you have any questions, please don't hesitate to contact us.
            </p>
            <p style="color: #666; font-size: 12px; margin-top: 30px;">
              This is an automated notification from TaskBizz. Please do not reply to this email.
            </p>
          </div>`
        );
        // console.log(`Task creation email sent to client ${task.client.email}`);
      } catch (clientEmailErr) {
        console.warn(`Failed to send client creation email to ${task.client.email}:`, clientEmailErr);
      }
    }

  } catch (err) {
    console.error('Error in sendTaskCreationNotifications:', err);
  }
}

export const getEmployeeDashboard = async (
  req: Request & { user?: any },
  res: Response
) => {
  try {
    const user = req.user;
    const orgId = user.orgId;

    const { start, end } = req.query as Record<string, string>;
    const dateStart = new Date(start);
    const dateEnd = new Date(end);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - ((today.getDay() + 6) % 7)); // ISO Monday
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const orgPrisma = await resolveOrgPrisma(req);

    /* ================= CACHE ================= */

    const cacheKey = orgKey(
      orgId,
      "employee-dashboard",
      `u=${user.id}:s=${start}:e=${end}`
    );

    const cached = await cacheGetJson(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    /* ================= FETCH ================= */

    const occurrences = await orgPrisma.taskOccurrence.findMany({
      where: {
        assignedToId: user.id,
        OR: [
          { startDate: { gte: dateStart, lte: dateEnd } },
          { dueDate: { gte: dateStart, lte: dateEnd } },
          { completedAt: { gte: dateStart, lte: dateEnd } },
        ],
      },
      include: {
        task: {
          select: {
            title: true,
            status: true,
            priority: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    /* ================= HELPERS ================= */

    const getStatus = (t: any) =>
      (t.status || t.task?.status || "OPEN").toUpperCase();

    const isCancelled = (t: any) => getStatus(t) === "CANCELLED";
    const isCompleted = (t: any) => getStatus(t) === "COMPLETED";

    const normalizeTask = (t: any) => ({
      ...t,
      occurrenceDue: t.dueDate ?? null,
    });

    const isOverdue = (t: any) => {
      if (isCompleted(t) || isCancelled(t)) return false;
      if (!t.dueDate) return false;
      return new Date(t.dueDate) < today;
    };

    /* ================= AGGREGATION ================= */

    let completedTasks = 0;
    let openTasks = 0;
    let overdueTasks = 0;

    const tasksByStatus: Record<string, number> = {};
    const upcomingDeadlines: any[] = [];
    const overdueTasksList: any[] = [];
    const dueTodayList: any[] = [];
    const dueThisWeekList: any[] = [];
    const recentTasks: any[] = [];

    for (const t of occurrences) {
      if (isCancelled(t)) continue;

      const status = getStatus(t);
      const due = t.dueDate ? new Date(t.dueDate) : null;

      tasksByStatus[status] = (tasksByStatus[status] || 0) + 1;

      if (isCompleted(t)) completedTasks++;
      else openTasks++;

      if (isOverdue(t)) {
        overdueTasks++;
        overdueTasksList.push(normalizeTask(t));
      }

      // ---------- DUE TODAY ----------
      if (
        !isCompleted(t) &&
        due &&
        due >= today &&
        due < new Date(today.getTime() + 24 * 60 * 60 * 1000)
      ) {
        dueTodayList.push(normalizeTask(t));
      }

      // ---------- DUE THIS WEEK ----------
      if (
        !isCompleted(t) &&
        due &&
        due >= weekStart &&
        due <= weekEnd &&
        due >= today
      ) {
        dueThisWeekList.push(normalizeTask(t));
      }

      // ---------- UPCOMING ----------
      if (!isCompleted(t) && due && due >= today) {
        upcomingDeadlines.push(normalizeTask(t));
      }

      recentTasks.push({
        id: t.id,
        title: t.title || t.task?.title,
        status,
        priority: t.priority || t.task?.priority,
        occurrenceDue: t.dueDate,
        isCompleted: isCompleted(t),
        lastActivityAt: t.completedAt || t.updatedAt || t.createdAt,
      });
    }

    const assignedTasks = completedTasks + openTasks;

    const completionRate =
      assignedTasks > 0
        ? Math.round((completedTasks / assignedTasks) * 100)
        : 0;

    /* ================= RESPONSE ================= */

    const payload = {
      stats: {
        assignedTasks,
        completedTasks,
        openTasks,
        overdueTasks,
        completionRate,
        dueToday: dueTodayList.length,
        dueThisWeek: dueThisWeekList.length,
      },

      tasksByStatus,

      upcomingDeadlines: upcomingDeadlines
        .sort(
          (a, b) =>
            new Date(a.occurrenceDue).getTime() -
            new Date(b.occurrenceDue).getTime()
        )
        .slice(0, 10),

      overdueTasksList: overdueTasksList
        .sort(
          (a, b) =>
            new Date(a.occurrenceDue).getTime() -
            new Date(b.occurrenceDue).getTime()
        )
        .slice(0, 10),

      dueTodayList: dueTodayList.sort(
        (a, b) =>
          new Date(a.occurrenceDue).getTime() -
          new Date(b.occurrenceDue).getTime()
      ),

      dueThisWeekList: dueThisWeekList.sort(
        (a, b) =>
          new Date(a.occurrenceDue).getTime() -
          new Date(b.occurrenceDue).getTime()
      ),

      recentTasks: recentTasks.slice(0, 10),
    };

    await cacheSetJson(cacheKey, payload, 60);
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load employee dashboard" });
  }
};