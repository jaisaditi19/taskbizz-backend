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

import { getCorePrisma, getOrgPrisma } from "../di/container";
import { extendAllOccurrenceWindows } from "../services/taskRecurrenceService";

const HORIZON_DAYS = 90;

export async function runRecurrenceCronForAllOrgs() {
  const corePrisma = getCorePrisma();
  const orgs = await corePrisma.organization.findMany({
    select: { id: true, name: true },
  });

  const summary: Array<{ orgId: string; ok: boolean; error?: string; [k: string]: any }> = [];

  for (const org of orgs) {
    try {
      const orgPrisma = await getOrgPrisma(org.id);
      const result = await extendAllOccurrenceWindows(orgPrisma, HORIZON_DAYS);
      summary.push({ orgId: org.id, ok: true, ...result });
    } catch (err: any) {
      console.error(`[recurrence-cron] org ${org.id} (${org.name}) failed:`, err);
      summary.push({ orgId: org.id, ok: false, error: err?.message ?? String(err) });
    }
  }

  const failed = summary.filter((s) => !s.ok).length;
  console.info(
    `[recurrence-cron] processed ${orgs.length} orgs, ${failed} failed. ` +
      `Created=${summary.reduce((a, s) => a + (s.occurrencesCreated ?? 0), 0)}, ` +
      `Removed=${summary.reduce((a, s) => a + (s.occurrencesRemoved ?? 0), 0)}`
  );

  return summary;
}
