"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// src/workers/emailWorker.ts
require("dotenv/config");
const bullmq_1 = require("bullmq");
const client_1 = require("@prisma/client");
const org_client_1 = require("../../prisma/generated/org-client");
const dbUrl_1 = require("../utils/dbUrl");
const mailerSend_1 = require("../utils/mailerSend");
const redisClient_1 = __importStar(require("../utils/redisClient"));
const locks_1 = require("../utils/locks");
if (!process.env.REDIS_URL) {
    console.error("ERROR: REDIS_URL is not set");
    process.exit(1);
}
if (!process.env.CORE_DATABASE_URL) {
    console.error("ERROR: CORE_DATABASE_URL is not set");
    process.exit(1);
}
// Core Prisma client (explicitly use CORE_DATABASE_URL)
const core = new client_1.PrismaClient({
    datasources: { db: { url: process.env.CORE_DATABASE_URL } },
});
/**
 * Resolve a recipient email for an occurrence:
 * - prefer first assignee mapped to core.user.email
 * - fallback to tenant client.email
 *
 * Adjust if you want multiple recipients or different lookup logic.
 */
// replace existing resolveRecipient with this function
async function resolveRecipient(corePrisma, tenantPrisma, occ) {
    // 1) Prefer client email if present
    if (occ.clientId) {
        try {
            const c = await tenantPrisma.client.findUnique({
                where: { id: occ.clientId },
                select: { email: true },
            });
            if (c?.email)
                return c.email;
        }
        catch (e) {
            // ignore and try fallback
        }
    }
    return null;
}
// Worker: process send-email jobs
const worker = new bullmq_1.Worker("send-email", async (job) => {
    const { orgId, dbName, occurrenceId } = job.data;
    // build tenant DB URL and client
    const dbUrl = (0, dbUrl_1.getOrgDbUrl)(dbName);
    const tenant = new org_client_1.PrismaClient({ datasources: { db: { url: dbUrl } } });
    try {
        // load occurrence with necessary relations
        const occ = await tenant.taskOccurrence.findUnique({
            where: { id: occurrenceId },
            include: { task: true, assignees: true },
        });
        if (!occ) {
            console.warn(`org=${orgId} occ=${occurrenceId} not found`);
            return;
        }
        // idempotency: skip if already sent
        if (occ.startEmailSent) {
            console.log(`org=${orgId} occ=${occurrenceId} already-sent`);
            return;
        }
        // acquire per-occurrence lock
        const lockKey = `occ-lock:${occurrenceId}`;
        const token = await (0, locks_1.acquireLock)(lockKey);
        if (!token) {
            console.log(`org=${orgId} occ=${occurrenceId} lock-miss - skipping`);
            return;
        }
        try {
            // re-check inside lock
            const fresh = await tenant.taskOccurrence.findUnique({
                where: { id: occurrenceId },
                select: {
                    startEmailSent: true,
                    title: true,
                    taskId: true,
                    clientId: true,
                },
            });
            if (!fresh || fresh.startEmailSent) {
                console.log(`org=${orgId} occ=${occurrenceId} already-sent (recheck)`);
                return;
            }
            // resolve recipient
            const recipient = await resolveRecipient(core, tenant, occ);
            if (!recipient) {
                console.warn(`org=${orgId} occ=${occurrenceId} no recipient found`);
                await tenant.emailLog.create({
                    data: {
                        occurrenceId: occ.id,
                        taskId: occ.taskId,
                        recipient: "unknown",
                        subject: `Task "${occ.title ?? occ.task?.title}" start - no recipient`,
                        status: "FAILED",
                        error: "no recipient found",
                    },
                });
                return;
            }
            // render simple content
            const title = occ.title ?? occ.task?.title ?? "Task";
            const subject = `Task "${title}" starts today`;
            const html = `<p>Your task <strong>${title}</strong> starts today (${new Date(occ.startDate).toUTCString()}).</p>`;
            const text = `Your task "${title}" starts today (${new Date(occ.startDate).toUTCString()}).`;
            // send via your MailerSend helper
            await (0, mailerSend_1.sendTaskEmail)({
                to: recipient,
                subject,
                text,
                html,
                attachments: [],
            });
            // persist audit + mark occurrence sent in a transaction
            await tenant.$transaction([
                tenant.emailLog.create({
                    data: {
                        occurrenceId: occ.id,
                        taskId: occ.taskId,
                        recipient,
                        subject,
                        provider: "mailersend",
                        status: "SENT",
                    },
                }),
                tenant.taskOccurrence.update({
                    where: { id: occ.id },
                    data: {
                        startEmailSent: true,
                        startEmailSentAt: new Date(),
                        clientMailSendCount: { increment: 1 },
                    },
                }),
            ]);
            console.log(`org=${orgId} occ=${occurrenceId} emailed -> ${recipient}`);
        }
        finally {
            // release lock
            await (0, locks_1.releaseLock)(lockKey, token);
        }
    }
    catch (err) {
        console.error(`org=${orgId} occ=${occurrenceId} failed`, err?.message ?? err);
        // best-effort failure log (avoid throwing before logging)
        try {
            await tenant.emailLog.create({
                data: {
                    occurrenceId,
                    taskId: null,
                    recipient: "unknown",
                    subject: `Task start - failed`,
                    status: "FAILED",
                    error: String(err?.message ?? err),
                },
            });
        }
        catch (e) {
            // ignore
        }
        // rethrow to enable BullMQ retries
        throw err;
    }
    finally {
        await tenant.$disconnect().catch(() => { });
    }
}, 
// pass bull connection; cast to any because of typings mismatch in some bullmq versions
redisClient_1.bullConnection);
// events
worker.on("completed", (job) => console.log("send-email job completed", job.id));
worker.on("failed", (job, err) => console.error("send-email job failed", job?.id, err?.message ?? err));
// graceful shutdown
process.on("SIGINT", async () => {
    console.log("shutting down email worker...");
    await worker.close();
    await redisClient_1.default.quit().catch(() => { });
    await core.$disconnect();
    process.exit(0);
});
