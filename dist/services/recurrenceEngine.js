"use strict";
// src/services/recurrenceEngine.ts
//
// Low-level occurrence materialization. This module owns exactly one job:
// given a Task (the recurrence template) and a target window, make sure the
// right TaskOccurrence rows exist for that window — nothing more.
//
// It knows nothing about "scope" (this/all/this-and-following) or content
// propagation — that's taskRecurrenceService.ts. Keeping this layer dumb
// and mechanical is what makes it safe to call from multiple places
// (create, update, cron horizon-extension) without duplicating the
// history-preservation rules in three places.
//
// Hard invariants enforced here, unconditionally:
//   1. An occurrence with isCompleted=true, or status COMPLETED/CANCELLED,
//      is NEVER updated or deleted by this module.
//   2. An occurrence whose startDate is in the past (relative to "now" at
//      call time) is NEVER created or deleted by this module — we don't
//      fabricate or erase history.
//   3. Calling syncOccurrenceWindow twice with the same task state and
//      window produces zero changes the second time (idempotent).
//   4. All writes happen inside the caller's transaction (`tx`), which must
//      already hold a lock on the task row — see withTaskLock below.
Object.defineProperty(exports, "__esModule", { value: true });
exports.STEP_ZONE = void 0;
exports.syncOccurrenceWindow = syncOccurrenceWindow;
exports.withTaskLock = withTaskLock;
const luxon_1 = require("luxon");
const rrule_1 = require("../utils/rrule");
exports.STEP_ZONE = "Asia/Kolkata";
async function syncOccurrenceWindow(tx, task, windowEndUTC) {
    const rule = (0, rrule_1.parseRecurrenceRule)(task.recurrenceRule);
    if (!rule) {
        return { created: 0, removedFutureStale: 0, windowEnd: windowEndUTC };
    }
    const seriesStart = luxon_1.DateTime.fromJSDate(task.startDate).setZone(exports.STEP_ZONE);
    const seriesDue = luxon_1.DateTime.fromJSDate(task.dueDate).setZone(exports.STEP_ZONE);
    const durationMs = seriesDue.toMillis() - seriesStart.toMillis();
    const now = luxon_1.DateTime.now().setZone(exports.STEP_ZONE);
    const windowStart = seriesStart;
    let windowEnd = luxon_1.DateTime.fromJSDate(windowEndUTC).setZone(exports.STEP_ZONE);
    if (task.recurrenceEndDate) {
        const ruleEnd = luxon_1.DateTime.fromJSDate(task.recurrenceEndDate)
            .setZone(exports.STEP_ZONE)
            .endOf("day");
        if (ruleEnd < windowEnd)
            windowEnd = ruleEnd;
    }
    // lastGeneratedUntil (existing column) doubles as a resume checkpoint so
    // we don't re-walk the whole series from its start on every extension.
    const resumeFrom = task.lastGeneratedUntil
        ? luxon_1.DateTime.fromJSDate(task.lastGeneratedUntil)
            .setZone(exports.STEP_ZONE)
            .minus({ days: 1 })
        : undefined;
    const candidates = (0, rrule_1.enumerateOccurrences)({
        rule,
        seriesStart,
        windowStart,
        windowEnd,
        resumeFrom,
    });
    // Only ever WRITE occurrences dated today-or-later. Anything the rule
    // would place in the past that was never materialized is intentionally
    // left ungenerated.
    const todayStart = now.startOf("day");
    const writableCandidates = candidates.filter((c) => c.date >= todayStart);
    const candidateTimes = new Set(writableCandidates.map((c) => c.date.toUTC().toMillis()));
    // No lower bound here on purpose: if the series anchor moves *earlier*
    // than it used to be, occurrences from the old anchor onward still need
    // to be evaluated for staleness. The loop below only ever deletes rows
    // that are future, non-immutable, and not in the new candidate set, so
    // including older rows here is harmless — they just won't match those
    // conditions and get left alone.
    const existing = await tx.taskOccurrence.findMany({
        where: {
            taskId: task.id,
            startDate: { lte: windowEnd.toUTC().toJSDate() },
        },
        select: { id: true, startDate: true, isCompleted: true, status: true },
    });
    const existingTimes = new Set(existing.map((o) => new Date(o.startDate).getTime()));
    // ---- Remove stale future placeholders (rule shrank / changed) ----
    const staleIds = [];
    for (const occ of existing) {
        const occTime = new Date(occ.startDate).getTime();
        const isFuture = occTime >= now.toUTC().toMillis();
        const isImmutable = occ.isCompleted ||
            occ.status === "COMPLETED" ||
            occ.status === "CANCELLED";
        const stillValid = candidateTimes.has(occTime);
        if (isFuture && !isImmutable && !stillValid) {
            staleIds.push(occ.id);
        }
    }
    if (staleIds.length) {
        await tx.taskOccurrence.deleteMany({ where: { id: { in: staleIds } } });
    }
    // ---- Create missing occurrences ----
    const toCreate = [];
    for (const c of writableCandidates) {
        const t = c.date.toUTC().toMillis();
        if (existingTimes.has(t))
            continue;
        const startDateUTC = c.date.toUTC().toJSDate();
        toCreate.push({
            taskId: task.id,
            title: task.title,
            description: task.description,
            startDate: startDateUTC,
            dueDate: new Date(startDateUTC.getTime() + durationMs),
            assignedToId: task.assignedToId,
            priority: task.priority,
            remarks: task.remarks,
            status: "OPEN",
            clientId: task.clientId,
            projectId: task.projectId,
        });
    }
    if (toCreate.length) {
        // occurrenceIndex is a pure uniqueness/ordering tiebreaker, not a
        // semantic date offset — this avoids collisions when regeneration runs
        // multiple times over a series' lifetime with rule changes in between.
        const maxIdxRow = await tx.taskOccurrence.findFirst({
            where: { taskId: task.id },
            orderBy: { occurrenceIndex: "desc" },
            select: { occurrenceIndex: true },
        });
        let nextIndex = (maxIdxRow?.occurrenceIndex ?? -1) + 1;
        for (const row of toCreate) {
            row.occurrenceIndex = nextIndex++;
        }
        await tx.taskOccurrence.createMany({
            data: toCreate,
            skipDuplicates: true,
        });
        const taskAssignees = await tx.taskAssignee.findMany({
            where: { taskId: task.id },
            select: { userId: true },
        });
        if (taskAssignees.length) {
            const created = await tx.taskOccurrence.findMany({
                where: {
                    taskId: task.id,
                    startDate: { in: toCreate.map((r) => r.startDate) },
                },
                select: { id: true },
            });
            const rows = created.flatMap((occ) => taskAssignees.map((a) => ({
                occurrenceId: occ.id,
                userId: a.userId,
            })));
            if (rows.length) {
                await tx.taskOccurrenceAssignee.createMany({
                    data: rows,
                    skipDuplicates: true,
                });
            }
        }
    }
    await tx.task.update({
        where: { id: task.id },
        data: { lastGeneratedUntil: windowEnd.toUTC().toJSDate() },
    });
    return {
        created: toCreate.length,
        removedFutureStale: staleIds.length,
        windowEnd: windowEnd.toUTC().toJSDate(),
    };
}
/**
 * Runs `fn` with an exclusive lock on the task row held for the whole
 * transaction, so two concurrent regenerations (a user edit racing the
 * cron horizon-extension, or two tabs saving at once) can't interleave and
 * corrupt the series.
 *
 * Implementation note: this takes a real row lock via a no-op UPDATE inside
 * the transaction (standard technique — an UPDATE, even one that changes
 * nothing, takes a row lock that's held until COMMIT/ROLLBACK). No new
 * table or column required. We use `title` as the touched field since it's
 * a required, always-present column on Task; swap it for any other
 * guaranteed-present required field if you prefer.
 */
async function withTaskLock(orgPrisma, taskId, fn) {
    return orgPrisma.$transaction(async (tx) => {
        const current = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
        const task = await tx.task.update({
            where: { id: taskId },
            data: { title: current.title }, // no-op write; acquires the row lock
        });
        return fn(tx, task);
    }, { timeout: 30000 });
}
