"use strict";
// src/jobs/recurrenceCron.ts
//
// Replaces the old on-demand `generateOccurrencesForAllTasks` endpoint.
// Run this on a schedule (every 15-60 min is plenty — occurrences are
// generated 90 days ahead by default, so there's no urgency).
//
// Wire this into whatever scheduler you already use (node-cron, BullMQ
// repeatable job, a serverless cron trigger, etc). Example with node-cron:
//
//   import cron from "node-cron";
//   import { runRecurrenceCronForAllOrgs } from "./jobs/recurrenceCron";
//   cron.schedule("*/30 * * * *", () => runRecurrenceCronForAllOrgs());
//
// This file assumes you have a way to enumerate org DBs — adjust
// `listActiveOrgIds` to whatever your DI container / core Prisma client
// already exposes.
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRecurrenceCronForAllOrgs = runRecurrenceCronForAllOrgs;
const container_1 = require("../di/container");
const taskRecurrenceService_1 = require("../services/taskRecurrenceService");
const HORIZON_DAYS = 90;
async function runRecurrenceCronForAllOrgs() {
    const corePrisma = (0, container_1.getCorePrisma)();
    const orgs = await corePrisma.organization.findMany({
        select: { id: true, name: true },
    });
    const summary = [];
    for (const org of orgs) {
        try {
            const orgPrisma = await (0, container_1.getOrgPrisma)(org.id);
            const result = await (0, taskRecurrenceService_1.extendAllOccurrenceWindows)(orgPrisma, HORIZON_DAYS);
            summary.push({ orgId: org.id, ok: true, ...result });
        }
        catch (err) {
            console.error(`[recurrence-cron] org ${org.id} (${org.name}) failed:`, err);
            summary.push({ orgId: org.id, ok: false, error: err?.message ?? String(err) });
        }
    }
    const failed = summary.filter((s) => !s.ok).length;
    console.info(`[recurrence-cron] processed ${orgs.length} orgs, ${failed} failed. ` +
        `Created=${summary.reduce((a, s) => a + (s.occurrencesCreated ?? 0), 0)}, ` +
        `Removed=${summary.reduce((a, s) => a + (s.occurrencesRemoved ?? 0), 0)}`);
    return summary;
}
