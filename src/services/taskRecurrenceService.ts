// src/services/taskRecurrenceService.ts
//
// Business-facing API for recurring tasks. Controllers should call into
// this module rather than touching TaskOccurrence directly for anything
// that spans more than one occurrence.
//
// Edit scopes (mirrors Outlook / Google Calendar semantics):
//
//   THIS_ONLY          -> not handled here. Just PATCH the single
//                         TaskOccurrence row (your existing updateOccurrence
//                         endpoint already does this correctly) — one
//                         occurrence diverging from its template is normal
//                         and never triggers regeneration.
//
//   ALL                -> content fields (title/description/priority/...)
//                         propagate to every live occurrence (past-overdue
//                         included, since those are still active work —
//                         only COMPLETED/CANCELLED are frozen). Schedule
//                         fields (rule/dates) regenerate the future window;
//                         the past is never touched.
//
//   THIS_AND_FOLLOWING -> splits the series at the given occurrence. The
//                         original task is capped to end the day before the
//                         split; a new Task starts at the split date with
//                         the patched content/schedule. See splitSeries()
//                         for the caveat on cross-linking without a schema
//                         change.

import { DateTime } from "luxon";
import { syncOccurrenceWindow, withTaskLock, STEP_ZONE } from "../services/recurrenceEngine";

const DEFAULT_HORIZON_DAYS = 90;

export type EditScope = "THIS_ONLY" | "ALL" | "THIS_AND_FOLLOWING";

export interface TaskTemplatePatch {
  title?: string;
  description?: string;
  priority?: string;
  remarks?: string;
  status?: string;
  clientId?: string | null;
  projectId?: string | null;
  assignedToId?: string | null;
  assignedToIds?: string[];
}

export interface ScheduleChange {
  startDate?: Date;
  dueDate?: Date;
  /** undefined = leave rule as-is. null = stop recurring (collapse to a
   *  single occurrence). string = new rule. */
  recurrenceRule?: string | null;
  recurrenceEndDate?: Date | null;
}

function horizonWindowEnd(days: number): Date {
  return DateTime.now().setZone(STEP_ZONE).plus({ days }).endOf("day").toUTC().toJSDate();
}

function singleOccurrencePayload(task: any) {
  return {
    title: task.title,
    description: task.description,
    startDate: task.startDate,
    dueDate: task.dueDate,
    assignedToId: task.assignedToId,
    priority: task.priority,
    remarks: task.remarks,
    status: task.status,
    clientId: task.clientId,
    projectId: task.projectId,
  };
}

function stripUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj)) {
    if ((obj as any)[k] !== undefined) (out as any)[k] = (obj as any)[k];
  }
  return out;
}

const LIVE_OCCURRENCE_FILTER = {
  isCompleted: false,
  NOT: { status: { in: ["COMPLETED", "CANCELLED"] } },
};

/**
 * Creates a Task and materializes its initial occurrence(s).
 * `createData` is whatever you already assemble today for `orgPrisma.task.create`
 * (title, dates, recurrenceRule, isRecurring, attachments, customValues, ...).
 */
export async function createTaskWithSchedule(orgPrisma: any, createData: any, horizonDays = DEFAULT_HORIZON_DAYS) {
  const task = await orgPrisma.task.create({
    data: createData,
    include: { attachments: true, customValues: { include: { field: true } } },
  });

  if (task.isRecurring) {
    await withTaskLock(orgPrisma, task.id, (tx, lockedTask) =>
      syncOccurrenceWindow(tx, lockedTask, horizonWindowEnd(horizonDays))
    );
  } else {
    await orgPrisma.taskOccurrence.upsert({
      where: { taskId_occurrenceIndex: { taskId: task.id, occurrenceIndex: 0 } },
      update: singleOccurrencePayload(task),
      create: { taskId: task.id, occurrenceIndex: 0, ...singleOccurrencePayload(task) },
    });
  }

  return task;
}

/**
 * ALL-scope update: content propagates to every live occurrence; schedule
 * changes regenerate the future window. Use this for the "apply to all
 * occurrences" path in updateTask.
 */
export async function updateTaskAllScope(
  orgPrisma: any,
  taskId: string,
  templatePatch: TaskTemplatePatch,
  scheduleChange: ScheduleChange | undefined,
  horizonDays = DEFAULT_HORIZON_DAYS,
) {
  return withTaskLock(orgPrisma, taskId, async (tx, currentTask) => {
    const now = new Date();

    const scheduleTouchesGeneration =
      !!scheduleChange &&
      (scheduleChange.recurrenceRule !== undefined ||
        scheduleChange.recurrenceEndDate !== undefined ||
        scheduleChange.startDate !== undefined ||
        scheduleChange.dueDate !== undefined);

    // A recurring task's startDate/dueDate pair is the TEMPLATE duration
    // for every occurrence, not "this one occurrence's dates." If the
    // caller only sends one of the two, move the other by the same delta
    // so the pair stays valid. Applying a lone new startDate on top of a
    // stale dueDate can silently produce dueDate < startDate, corrupting
    // every future occurrence with a negative duration — which is exactly
    // what happened.
    let resolvedStartDate = scheduleChange?.startDate;
    let resolvedDueDate = scheduleChange?.dueDate;

    if (resolvedStartDate !== undefined && resolvedDueDate === undefined) {
      const existingDurationMs =
        new Date(currentTask.dueDate).getTime() -
        new Date(currentTask.startDate).getTime();
      resolvedDueDate = new Date(
        resolvedStartDate.getTime() + existingDurationMs,
      );
    } else if (
      resolvedDueDate !== undefined &&
      resolvedStartDate === undefined
    ) {
      resolvedStartDate = currentTask.startDate; // resizing only — start stays put
    }

    if (
      resolvedStartDate !== undefined &&
      resolvedDueDate !== undefined &&
      resolvedDueDate.getTime() < resolvedStartDate.getTime()
    ) {
      throw new Error(
        "Invalid schedule: dueDate cannot be before startDate for a recurring task.",
      );
    }

    // 1) Template update
    const taskUpdateData: any = stripUndefined({
      title: templatePatch.title,
      description: templatePatch.description,
      priority: templatePatch.priority,
      remarks: templatePatch.remarks,
      status: templatePatch.status,
      clientId: templatePatch.clientId,
      projectId: templatePatch.projectId,
      assignedToId:
        templatePatch.assignedToIds?.[0] ?? templatePatch.assignedToId,
    });
    if (resolvedStartDate !== undefined)
      taskUpdateData.startDate = resolvedStartDate;
    if (resolvedDueDate !== undefined) taskUpdateData.dueDate = resolvedDueDate;
    if (scheduleChange?.recurrenceEndDate !== undefined) {
      taskUpdateData.recurrenceEndDate = scheduleChange.recurrenceEndDate;
    }
    if (scheduleChange?.recurrenceRule !== undefined) {
      taskUpdateData.recurrenceRule = scheduleChange.recurrenceRule;
      taskUpdateData.isRecurring = !!scheduleChange.recurrenceRule;
    }
    if (Object.keys(taskUpdateData).length) {
      await tx.task.update({ where: { id: taskId }, data: taskUpdateData });
    }
    const freshTask = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
    });

    // 2) Content propagation to every live occurrence
    const contentFields = stripUndefined({
      title: templatePatch.title,
      description: templatePatch.description,
      priority: templatePatch.priority,
      remarks: templatePatch.remarks,
      status: templatePatch.status,
      clientId: templatePatch.clientId,
      projectId: templatePatch.projectId,
      assignedToId:
        templatePatch.assignedToIds?.[0] ?? templatePatch.assignedToId,
    });
    if (Object.keys(contentFields).length) {
      await tx.taskOccurrence.updateMany({
        where: { taskId, ...LIVE_OCCURRENCE_FILTER },
        data: contentFields,
      });
    }
    if (templatePatch.assignedToIds) {
      const liveOccs = await tx.taskOccurrence.findMany({
        where: { taskId, ...LIVE_OCCURRENCE_FILTER },
        select: { id: true },
      });
      const occIds = liveOccs.map((o: any) => o.id);
      if (occIds.length) {
        await tx.taskOccurrenceAssignee.deleteMany({
          where: { occurrenceId: { in: occIds } },
        });
        const rows = occIds.flatMap((occId: string) =>
          templatePatch.assignedToIds!.map((uid) => ({
            occurrenceId: occId,
            userId: uid,
          })),
        );
        if (rows.length)
          await tx.taskOccurrenceAssignee.createMany({
            data: rows,
            skipDuplicates: true,
          });
      }
    }

    // 3) Schedule regeneration
    if (scheduleTouchesGeneration) {
      if (!freshTask.isRecurring) {
        // Recurring -> non-recurring: collapse to a single occurrence.
        // History (completed/cancelled) is left exactly as-is.
        await tx.taskOccurrence.deleteMany({
          where: { taskId, startDate: { gte: now }, ...LIVE_OCCURRENCE_FILTER },
        });
        await tx.taskOccurrence.upsert({
          where: { taskId_occurrenceIndex: { taskId, occurrenceIndex: 0 } },
          update: singleOccurrencePayload(freshTask),
          create: {
            taskId,
            occurrenceIndex: 0,
            ...singleOccurrencePayload(freshTask),
          },
        });
      } else {
        // Any schedule change invalidates the lastGeneratedUntil checkpoint.
        // That checkpoint is only a valid resume-point for *pure horizon
        // extension* (cron), where the series anchor hasn't moved. When
        // startDate/dueDate/recurrenceRule/recurrenceEndDate change, the
        // old checkpoint was computed under the OLD anchor/phase — using
        // it as a resume point makes the enumerator fast-forward almost
        // to the end of the window, skipping (and then deleting as
        // "stale") every occurrence in between. Reset it so this
        // regeneration always walks from the new seriesStart.
        await tx.task.update({
          where: { id: taskId },
          data: { lastGeneratedUntil: null },
        });
        await syncOccurrenceWindow(
          tx,
          { ...freshTask, lastGeneratedUntil: null },
          horizonWindowEnd(horizonDays),
        );
      }
    }

    return tx.task.findUniqueOrThrow({
      where: { id: taskId },
      include: { attachments: true },
    });
  });
}

/**
 * THIS_AND_FOLLOWING: splits the series at `anchorOccurrenceId`.
 *
 * Caveat: without a schema migration there's no queryable link between the
 * two resulting tasks (no parentTaskId column exists). This is functionally
 * identical to what a user would get by manually ending one recurring task
 * and starting a new one — correct occurrence-level behavior, but if you
 * later want an audit trail ("these two series used to be one"), that needs
 * one new nullable column, e.g. `Task.splitFromTaskId`.
 */
export async function splitSeries(
  orgPrisma: any,
  taskId: string,
  anchorOccurrenceId: string,
  templatePatch: TaskTemplatePatch,
  scheduleChange: ScheduleChange | undefined,
  horizonDays = DEFAULT_HORIZON_DAYS
) {
  return withTaskLock(orgPrisma, taskId, async (tx, oldTask) => {
    const anchor = await tx.taskOccurrence.findUniqueOrThrow({ where: { id: anchorOccurrenceId } });
    if (anchor.taskId !== taskId) {
      throw new Error("anchorOccurrenceId does not belong to this task");
    }

    const splitDate: Date = anchor.startDate;

    // 1) Cap the old series the day before the split point.
    const cappedEnd = DateTime.fromJSDate(splitDate)
      .setZone(STEP_ZONE)
      .minus({ days: 1 })
      .endOf("day")
      .toUTC()
      .toJSDate();
    await tx.task.update({ where: { id: taskId }, data: { recurrenceEndDate: cappedEnd } });

    // Remove old-series future placeholders from the split point on.
    // Anything before the split, or already completed/cancelled, stays.
    await tx.taskOccurrence.deleteMany({
      where: { taskId, startDate: { gte: splitDate }, ...LIVE_OCCURRENCE_FILTER },
    });

    // 2) Create the new series starting at the split point.
    const durationMs = new Date(oldTask.dueDate).getTime() - new Date(oldTask.startDate).getTime();
    const newStart = scheduleChange?.startDate ?? splitDate;
    const newDue = scheduleChange?.dueDate ?? new Date(new Date(newStart).getTime() + durationMs);
    const newRule = scheduleChange?.recurrenceRule !== undefined ? scheduleChange.recurrenceRule : oldTask.recurrenceRule;
    const newEnd =
      scheduleChange?.recurrenceEndDate !== undefined ? scheduleChange.recurrenceEndDate : oldTask.recurrenceEndDate;

    const newTask = await tx.task.create({
      data: {
        clientId: templatePatch.clientId ?? oldTask.clientId,
        projectId: templatePatch.projectId ?? oldTask.projectId,
        title: templatePatch.title ?? oldTask.title,
        description: templatePatch.description ?? oldTask.description,
        startDate: newStart,
        dueDate: newDue,
        assignedToId: templatePatch.assignedToIds?.[0] ?? templatePatch.assignedToId ?? oldTask.assignedToId,
        priority: templatePatch.priority ?? oldTask.priority,
        remarks: templatePatch.remarks ?? oldTask.remarks,
        status: templatePatch.status ?? oldTask.status,
        recurrenceRule: newRule,
        recurrenceEndDate: newEnd,
        isRecurring: !!newRule,
        createdById: oldTask.createdById,
      },
    });

    if (newTask.isRecurring) {
      await syncOccurrenceWindow(tx, newTask, horizonWindowEnd(horizonDays));
    } else {
      await tx.taskOccurrence.create({
        data: { taskId: newTask.id, occurrenceIndex: 0, ...singleOccurrencePayload(newTask) },
      });
    }

    if (templatePatch.assignedToIds?.length) {
      const occ = await tx.taskOccurrence.findFirst({
        where: { taskId: newTask.id },
        orderBy: { occurrenceIndex: "asc" },
        select: { id: true },
      });
      // Seed assignees on all occurrences created for the new series so far.
      const allOccs = await tx.taskOccurrence.findMany({ where: { taskId: newTask.id }, select: { id: true } });
      const rows = allOccs.flatMap((o: any) =>
        templatePatch.assignedToIds!.map((uid) => ({ occurrenceId: o.id, userId: uid }))
      );
      if (rows.length) await tx.taskOccurrenceAssignee.createMany({ data: rows, skipDuplicates: true });
      void occ; // (kept for readability; not otherwise used)
    }

    return {
      oldTask: await tx.task.findUniqueOrThrow({ where: { id: taskId } }),
      newTask,
    };
  });
}

/**
 * Cron entry point. Call every 15-60 minutes. Pushes every active recurring
 * task's occurrence horizon forward so `horizonDays` of OPEN occurrences
 * always exist, without ever generating years of rows upfront.
 */
export async function extendAllOccurrenceWindows(orgPrisma: any, horizonDays = DEFAULT_HORIZON_DAYS) {
  const targetWindowEnd = horizonWindowEnd(horizonDays);

  const tasks = await orgPrisma.task.findMany({
    where: {
      isRecurring: true,
      OR: [{ lastGeneratedUntil: null }, { lastGeneratedUntil: { lt: targetWindowEnd } }],
    },
    select: { id: true },
  });

  let totalCreated = 0;
  let totalRemoved = 0;
  let failures = 0;

  for (const t of tasks) {
    try {
      const result = await withTaskLock(orgPrisma, t.id, async (tx, task) => {
        if (!task.isRecurring) return { created: 0, removedFutureStale: 0 }; // changed mid-run
        return syncOccurrenceWindow(tx, task, targetWindowEnd);
      });
      totalCreated += result.created;
      totalRemoved += result.removedFutureStale;
    } catch (err) {
      failures++;
      console.error(`[recurrence] failed to extend window for task ${t.id}:`, err);
      // One bad task must not block the batch.
    }
  }

  return {
    tasksProcessed: tasks.length,
    occurrencesCreated: totalCreated,
    occurrencesRemoved: totalRemoved,
    failures,
  };
}
