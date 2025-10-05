"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/workers/dailyEnqueueWorker.ts
const bullmq_1 = require("bullmq");
const p_limit_1 = __importDefault(require("p-limit"));
const luxon_1 = require("luxon");
const client_1 = require("@prisma/client");
const dbUrl_1 = require("../utils/dbUrl");
const org_client_1 = require("../../prisma/generated/org-client");
const redisClient_1 = require("../utils/redisClient");
const core = new client_1.PrismaClient({
    datasources: { db: { url: process.env.CORE_DATABASE_URL } },
});
// sendQueue uses same bullConnection (casted inside redis client util)
const sendQueue = new bullmq_1.Queue("send-email", redisClient_1.bullConnection);
// helper bounds: UTC day
function utcDayBounds() {
    const now = luxon_1.DateTime.utc();
    const start = now.startOf("day").toJSDate();
    const end = luxon_1.DateTime.fromJSDate(start).plus({ days: 1 }).toJSDate();
    return { start, end };
}
async function enqueueForOrg(org) {
    const dbName = org.dbName || org.id;
    const dbUrl = (0, dbUrl_1.getOrgDbUrl)(dbName);
    const tenant = new org_client_1.PrismaClient({ datasources: { db: { url: dbUrl } } });
    try {
        const { start, end } = utcDayBounds();
        const occurrences = await tenant.taskOccurrence.findMany({
            where: { startDate: { gte: start, lt: end }, startEmailSent: false },
            select: { id: true, taskId: true },
        });
        for (const occ of occurrences) {
            await sendQueue.add("send-occurrence-email", { orgId: org.id, dbName, occurrenceId: occ.id }, {
                attempts: 5,
                backoff: { type: "exponential", delay: 60000 },
                removeOnComplete: true,
                removeOnFail: false,
            });
        }
        console.log(`org=${org.id} enqueued ${occurrences.length} send jobs`);
    }
    finally {
        await tenant.$disconnect().catch(() => { });
    }
}
// Worker that runs the repeatable `enqueue-today-emails` job and enqueues send jobs
const worker = new bullmq_1.Worker("daily-enqueue", async (job) => {
    console.log("daily enqueue job running", new Date().toISOString());
    const orgs = await core.organization.findMany({
        select: { id: true, dbName: true },
    });
    const limit = (0, p_limit_1.default)(10); // parallel org scanning
    await Promise.all(orgs.map((org) => limit(() => enqueueForOrg(org))));
    console.log("daily enqueue job finished", new Date().toISOString());
}, 
// pass the bullConnection; cast to any inside util, so types match
redisClient_1.bullConnection);
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
