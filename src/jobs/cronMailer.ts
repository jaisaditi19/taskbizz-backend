// src/workers/cronMailer.ts
import "dotenv/config";
import cron from "node-cron";
import pLimit from "p-limit";
import axios from "axios";
import { PrismaClient as CorePrisma } from "@prisma/client";
import { PrismaClient as OrgPrisma } from "../../prisma/generated/org-client";
import { getOrgDbUrl } from "../utils/dbUrl";
import { sendTaskEmail } from "../utils/mailerSend";
import redisClient from "../utils/redisClient";
import { acquireLock, releaseLock } from "../utils/locks";
import { getCachedFileUrlFromSpaces } from "../utils/spacesUtils";

if (!process.env.DATABASE_URL) {
  console.error("ERROR: CORE_DATABASE_URL is not set");
  process.exit(1);
}
if (!process.env.REDIS_URL) {
  console.error("ERROR: REDIS_URL is not set");
  process.exit(1);
}

// ---- config ----
const TENANT_CONCURRENCY = Number(process.env.CRON_TENANT_CONCURRENCY ?? 3);
const EMAIL_CONCURRENCY = Number(process.env.CRON_EMAIL_CONCURRENCY ?? 5);

// Core Prisma client (EXPLICITLY CORE_DATABASE_URL)
const core = new CorePrisma({
  datasources: { db: { url: process.env.DATABASE_URL! } },
});

// Helpers
function formatDateNice(d?: Date | string | null) {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "—";
  // e.g., 27 Sep 2025
  return dt.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Resolve recipient for an occurrence:
 * Only send if Client.clientCommunication === true and Client.email exists.
 */
async function resolveRecipient(
  tenant: OrgPrisma,
  occ: { clientId: string | null }
) {
  if (!occ.clientId) return null;
  try {
    const client = await tenant.client.findUnique({
      where: { id: occ.clientId },
      select: { email: true, clientCommunication: true },
    });
    if (client?.clientCommunication === true && client.email) {
      return client.email;
    }
  } catch {}
  return null;
}

async function buildEmailForOccurrence({
  orgId,
  tenant,
  corePrisma,
  occurrence,
}: {
  orgId: string;
  tenant: OrgPrisma;
  corePrisma: CorePrisma;
  occurrence: any;
}) {
  // --- Organization name (core) ---
  let organizationName = "TaskBizz";
  try {
    const org = await corePrisma.organization.findUnique({
      where: { id: orgId },
      select: { name: true },
    });
    if (org?.name) organizationName = org.name;
  } catch {}

  // --- Attachments: task + occurrence ---
  const [taskAttachments, occAttachments] = await Promise.all([
    tenant.taskAttachment.findMany({ where: { taskId: occurrence.taskId } }),
    tenant.taskOccurrenceAttachment.findMany({
      where: { occurrenceId: occurrence.id },
    }),
  ]);
  const allAttachments = [...taskAttachments, ...occAttachments];

  const downloadedAttachments: Array<{
    filename: string;
    content: Buffer;
    contentType?: string;
  }> = [];
  const fallbackUrls: string[] = [];

  await Promise.all(
    allAttachments.map(async (att: any) => {
      try {
        const url = await getCachedFileUrlFromSpaces(att.key, orgId);
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
        downloadedAttachments.push({ filename, content: buf, contentType });
      } catch (err) {
        console.warn(
          `Failed to download attachment ${att.id || att.key}:`,
          (err as any)?.message || err
        );
        try {
          const url = await getCachedFileUrlFromSpaces(att.key, orgId);
          fallbackUrls.push(url);
        } catch {}
      }
    })
  );

  // --- Assignees normalization (occurrence -> task fallback) ---
  let normalizedAssignees: Array<{
    id?: string;
    name?: string;
    email?: string;
    phone?: string;
  }> = [];

  try {
    const occAssignees = (occurrence.assignees ?? []) as any[];
    if (Array.isArray(occAssignees) && occAssignees.length > 0) {
      normalizedAssignees = occAssignees
        .map((a) => ({
          id: a?.userId ? String(a.userId) : a?.id ? String(a.id) : undefined,
        }))
        .filter((a) => a.id);
    } else {
      const taskAssignees = (occurrence.task?.assignees ?? []) as any[];
      if (Array.isArray(taskAssignees) && taskAssignees.length > 0) {
        normalizedAssignees = taskAssignees
          .map((u) => ({
            id: u?.userId ? String(u.userId) : u?.id ? String(u.id) : undefined,
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

  // --- Enrich assignees from core users / directoryUser ---
  try {
    const assigneeIds = normalizedAssignees
      .map((a) => a.id)
      .filter(Boolean) as string[];
    if (assigneeIds.length > 0) {
      let coreUsers: any[] = [];
      try {
        coreUsers = await corePrisma.user.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, name: true, email: true, phone: true },
        });
      } catch (e) {
        console.warn("core.user.findMany failed:", (e as any)?.message ?? e);
      }

      if (!coreUsers || coreUsers.length === 0) {
        try {
          const dirs = await tenant.directoryUser.findMany({
            where: { userId: { in: assigneeIds } },
            select: { userId: true, name: true, avatarUrl: true },
          });
          coreUsers = dirs.map((d: any) => ({ id: d.userId, name: d.name }));
        } catch (e) {
          console.warn(
            "tenant.directoryUser.findMany failed:",
            (e as any)?.message ?? e
          );
        }
      }

      const usersById: Record<string, any> = (coreUsers || []).reduce(
        (acc: Record<string, any>, u: any) => {
          acc[String(u.id)] = u;
          return acc;
        },
        {}
      );

      normalizedAssignees = normalizedAssignees.map((a) => {
        const u = usersById[String(a.id)];
        if (!u) return a;
        return {
          id: a.id,
          name: a.name ?? (u.name ? String(u.name) : undefined),
          email: a.email ?? (u.email ? String(u.email) : undefined),
          phone: a.phone ?? (u.phone ? String(u.phone) : undefined),
        };
      });
    }
  } catch (e) {
    console.warn(
      "Failed to fetch assignee profiles:",
      (e as any)?.message ?? e
    );
  }

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

  const assigneeNameEmailHtml =
    normalizedAssignees.length === 0
      ? "—"
      : normalizedAssignees
          .map((a) => {
            const name = a.name ?? `#${a.id ?? "?"}`;
            const email = a.email ?? "—";
            return `<div style="margin-bottom:8px;">
                      <div style="font-weight:600; color:#111827;">${name}</div>
                      <div style="font-size:12px; color:#6b7280;">${email}</div>
                    </div>`;
          })
          .join("");

  const contactNumbersArr = normalizedAssignees
    .map((a) => a.phone)
    .filter(Boolean) as string[];
  const contactNumbersText =
    contactNumbersArr.length > 0 ? contactNumbersArr.join("; ") : "—";

  const dueDateStr = formatDateNice(occurrence.dueDate);

  // === SUBJECT/TEXT/HTML — SAME STRUCTURE AS sendTaskToClient ===
  const subject = `${occurrence.title ?? "Task"} "Starts" Today`;

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
              <td style="padding:8px; color:#111827;">${occurrence.status}</td>
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
          <div>Powered by TaskBizz - manage Business in smarter way</div>
        </div>
      </div>
    </div>
  `;

  const emailAttachments = downloadedAttachments.map((a) => ({
    filename: a.filename,
    content: a.content,
    contentType: a.contentType,
  }));

  return { subject, text, html, emailAttachments };
}

async function processTenant(org: { id: string; dbName: string }) {
  const dbUrl = getOrgDbUrl(org.dbName);
  const tenant = new OrgPrisma({ datasources: { db: { url: dbUrl } } });

  try {
    // IST day window (cron itself runs at 12:00 IST)
    const now = new Date();
    const dayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0,
      0,
      0,
      0
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    // Occurrences that start today, not sent, and have a client
    const occurrences = await tenant.taskOccurrence.findMany({
      where: {
        startEmailSent: false,
        clientId: { not: null },
        startDate: { gte: dayStart, lt: dayEnd },
      },
      include: {
        task: { include: { attachments: true, assignees: true } },
        attachments: true,
        assignees: true,
      },
      take: 500,
    });

    if (!occurrences.length) return;

    const limit = pLimit(EMAIL_CONCURRENCY);

    await Promise.all(
      occurrences.map((occ) =>
        limit(async () => {
          const lockKey = `occ-start-mail:${occ.id}`;
          const token = await acquireLock(lockKey, 60);
          if (!token) return;

          try {
            // Double-check fresh flags
            const fresh = await tenant.taskOccurrence.findUnique({
              where: { id: occ.id },
              select: {
                id: true,
                taskId: true,
                clientId: true,
                startEmailSent: true,
                clientMailSendCount: true,
              },
            });
            if (!fresh || fresh.startEmailSent) return;

            // Respect 3-send safety, though start mail should be one-time
            if ((fresh.clientMailSendCount ?? 0) >= 3) {
              await tenant.emailLog.create({
                data: {
                  occurrenceId: occ.id,
                  taskId: occ.taskId,
                  recipient: "unknown",
                  subject: `Task "${
                    occ.title ?? occ.task?.title ?? "Task"
                  }" start - not sent`,
                  status: "FAILED",
                  error: "Send limit reached (3/3)",
                },
              });
              return;
            }

            // Enforce clientCommunication & email
            const recipient = await resolveRecipient(tenant, fresh);
            if (!recipient) {
              await tenant.emailLog.create({
                data: {
                  occurrenceId: occ.id,
                  taskId: occ.taskId,
                  recipient: "unknown",
                  subject: `Task "${
                    occ.title ?? occ.task?.title ?? "Task"
                  }" start - not sent`,
                  status: "FAILED",
                  error:
                    "Client communication disabled or missing client email",
                },
              });
              return;
            }

            // Build email content identical to sendTaskToClient
            const { subject, text, html, emailAttachments } =
              await buildEmailForOccurrence({
                orgId: org.id,
                tenant,
                corePrisma: core,
                occurrence: occ,
              });

            await sendTaskEmail({
              to: recipient,
              subject,
              text,
              html,
              attachments: emailAttachments,
            });

            // Log + mark sent + increment counter
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

            console.log(`org=${org.id} occ=${occ.id} emailed -> ${recipient}`);
          } catch (err) {
            console.error(
              `org=${org.id} occ=${occ.id} failed`,
              (err as any)?.message ?? err
            );
            try {
              await tenant.emailLog.create({
                data: {
                  occurrenceId: occ.id,
                  taskId: occ.taskId,
                  recipient: "unknown",
                  subject: `Task start - failed`,
                  status: "FAILED",
                  error: String((err as any)?.message ?? err),
                },
              });
            } catch {}
          } finally {
            await releaseLock(lockKey, token).catch(() => {});
          }
        })
      )
    );
  } finally {
    await tenant.$disconnect().catch(() => {});
  }
}

async function sweepAllTenants() {
  // Only orgs with a non-empty dbName (avoids TS error for not: null)
  const orgs = await core.organization.findMany({
    where: { NOT: { dbName: "" } },
    select: { id: true, dbName: true },
    take: 1000,
  });

  const validOrgs = orgs.filter((o) => o.dbName && o.dbName.trim() !== "");
  const limit = pLimit(TENANT_CONCURRENCY);
  await Promise.all(validOrgs.map((o) => limit(() => processTenant(o as any))));
}

// Run once a day at 12:00 PM IST
const task = cron.schedule(
  "0 12 * * *",
  async () => {
    try {
      await sweepAllTenants();
    } catch (e) {
      console.error("cron sweep failed", (e as any)?.message ?? e);
    }
  },
  { timezone: "Asia/Kolkata" }
);

process.on("SIGINT", async () => {
  console.log("shutting down cron mailer...");
  task.stop();
  await core.$disconnect().catch(() => {});
  await redisClient.quit().catch(() => {});
  process.exit(0);
});

// Start scheduler (dev: also run once immediately)
(async () => {
  console.log(`Cron mailer running. Schedule: 12:00 PM Asia/Kolkata daily.`);
  task.start();
  if (process.env.NODE_ENV !== "production") {
    console.log("Running sweepAllTenants() once immediately for testing...");
    await sweepAllTenants();
  }
})();
