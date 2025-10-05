// src/workers/emailWorker.ts
import "dotenv/config";
import { Worker } from "bullmq";
import pLimit from "p-limit";
import { PrismaClient as CorePrisma } from "@prisma/client";
import { PrismaClient as OrgPrisma } from "../../prisma/generated/org-client";
import { getOrgDbUrl } from "../utils/dbUrl";
import { sendTaskEmail } from "../utils/mailerSend";
import redisClient, { bullConnection } from "../utils/redisClient";
import { acquireLock, releaseLock } from "../utils/locks";

if (!process.env.REDIS_URL) {
  console.error("ERROR: REDIS_URL is not set");
  process.exit(1);
}
if (!process.env.CORE_DATABASE_URL) {
  console.error("ERROR: CORE_DATABASE_URL is not set");
  process.exit(1);
}

// Core Prisma client (explicitly use CORE_DATABASE_URL)
const core = new CorePrisma({
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
async function resolveRecipient(corePrisma: any, tenantPrisma: any, occ: any) {
  // 1) Prefer client email if present
  if (occ.clientId) {
    try {
      const c = await tenantPrisma.client.findUnique({
        where: { id: occ.clientId },
        select: { email: true },
      });
      if (c?.email) return c.email;
    } catch (e) {
      // ignore and try fallback
    }
  }
  return null;
}

// Worker: process send-email jobs
const worker = new Worker(
  "send-email",
  async (job) => {
    const { orgId, dbName, occurrenceId } = job.data as {
      orgId: string;
      dbName: string;
      occurrenceId: string;
    };

    // build tenant DB URL and client
    const dbUrl = getOrgDbUrl(dbName);
    const tenant = new OrgPrisma({ datasources: { db: { url: dbUrl } } });

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
      const token = await acquireLock(lockKey);
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
          console.log(
            `org=${orgId} occ=${occurrenceId} already-sent (recheck)`
          );
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
              subject: `Task "${
                occ.title ?? occ.task?.title
              }" start - no recipient`,
              status: "FAILED",
              error: "no recipient found",
            },
          });
          return;
        }

        // render simple content
        const title = occ.title ?? occ.task?.title ?? "Task";
        const subject = `Task "${title}" starts today`;
        const html = `<p>Your task <strong>${title}</strong> starts today (${new Date(
          occ.startDate
        ).toUTCString()}).</p>`;
        const text = `Your task "${title}" starts today (${new Date(
          occ.startDate
        ).toUTCString()}).`;

        // send via your MailerSend helper
        await sendTaskEmail({
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
      } finally {
        // release lock
        await releaseLock(lockKey, token);
      }
    } catch (err) {
      console.error(
        `org=${orgId} occ=${occurrenceId} failed`,
        (err as any)?.message ?? err
      );
      // best-effort failure log (avoid throwing before logging)
      try {
        await tenant.emailLog.create({
          data: {
            occurrenceId,
            taskId: null,
            recipient: "unknown",
            subject: `Task start - failed`,
            status: "FAILED",
            error: String((err as any)?.message ?? err),
          },
        });
      } catch (e) {
        // ignore
      }
      // rethrow to enable BullMQ retries
      throw err;
    } finally {
      await tenant.$disconnect().catch(() => {});
    }
  },
  // pass bull connection; cast to any because of typings mismatch in some bullmq versions
  bullConnection as any
);

// events
worker.on("completed", (job) =>
  console.log("send-email job completed", job.id)
);
worker.on("failed", (job, err) =>
  console.error("send-email job failed", job?.id, (err as any)?.message ?? err)
);

// graceful shutdown
process.on("SIGINT", async () => {
  console.log("shutting down email worker...");
  await worker.close();
  await redisClient.quit().catch(() => {});
  await core.$disconnect();
  process.exit(0);
});
