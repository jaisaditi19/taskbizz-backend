// src/workers/dailyEnqueueWorker.ts
import { Worker, Queue } from "bullmq";
import IORedis from "ioredis";
import pLimit from "p-limit";
import { DateTime } from "luxon";
import { PrismaClient as CorePrisma } from "@prisma/client";
import { getOrgDbUrl } from "../utils/dbUrl";
import { PrismaClient as OrgPrisma } from "../../prisma/generated/org-client";
import { bullConnection } from "../utils/redisClient";

const core = new CorePrisma({
  datasources: { db: { url: process.env.CORE_DATABASE_URL! } },
});

// sendQueue uses same bullConnection (casted inside redis client util)
const sendQueue = new Queue("send-email", bullConnection);

// helper bounds: UTC day
function utcDayBounds() {
  const now = DateTime.utc();
  const start = now.startOf("day").toJSDate();
  const end = DateTime.fromJSDate(start).plus({ days: 1 }).toJSDate();
  return { start, end };
}

async function enqueueForOrg(org: { id: string; dbName?: string }) {
  const dbName = org.dbName || org.id;
  const dbUrl = getOrgDbUrl(dbName);
  const tenant = new OrgPrisma({ datasources: { db: { url: dbUrl } } });

  try {
    const { start, end } = utcDayBounds();
    const occurrences = await tenant.taskOccurrence.findMany({
      where: { startDate: { gte: start, lt: end }, startEmailSent: false },
      select: { id: true, taskId: true },
    });

    for (const occ of occurrences) {
      await sendQueue.add(
        "send-occurrence-email",
        { orgId: org.id, dbName, occurrenceId: occ.id },
        {
          attempts: 5,
          backoff: { type: "exponential", delay: 60_000 },
          removeOnComplete: true,
          removeOnFail: false,
        }
      );
    }

    console.log(`org=${org.id} enqueued ${occurrences.length} send jobs`);
  } finally {
    await tenant.$disconnect().catch(() => {});
  }
}

// Worker that runs the repeatable `enqueue-today-emails` job and enqueues send jobs
const worker = new Worker(
  "daily-enqueue",
  async (job) => {
    console.log("daily enqueue job running", new Date().toISOString());

    const orgs = await core.organization.findMany({
      select: { id: true, dbName: true },
    });

    const limit = pLimit(10); // parallel org scanning
    await Promise.all(
      orgs.map((org) => limit(() => enqueueForOrg(org as any)))
    );

    console.log("daily enqueue job finished", new Date().toISOString());
  },
  // pass the bullConnection; cast to any inside util, so types match
  bullConnection as any
);

worker.on("completed", () => console.log("daily-enqueue job completed"));
worker.on("failed", (job, err) => console.error("daily-enqueue failed", err));

// graceful shutdown
process.on("SIGINT", async () => {
  console.log("shutting down daily-enqueue worker");
  await worker.close();
  await sendQueue.close();
  await core.$disconnect();
  // close Redis in redisClient module if desired; process will exit anyway
  process.exit(0);
});
