// src/jobs/dailyReportMailer.ts

import cron from "node-cron";
import pLimit from "p-limit";

import { getCorePrisma, getOrgPrisma } from "../di/container";

import { sendTaskEmail } from "../utils/mailerSend";
import redisClient from "../utils/redisClient";
import { acquireLock, releaseLock } from "../utils/locks";

import { generateDailyTaskReport } from "../services/dailyTaskReportService";
import { generateDailyTaskExcel } from "../services/dailyTaskExcelService";
import { generateDailyTaskEmail } from "../services/dailyTaskEmailService";

// ==================================================
// CONFIGURATION
// ==================================================

const TENANT_CONCURRENCY = Number(
  process.env.DAILY_REPORT_TENANT_CONCURRENCY ?? 3,
);

const EMAIL_CONCURRENCY = Number(
  process.env.DAILY_REPORT_EMAIL_CONCURRENCY ?? 5,
);

const REPORT_TIMEZONE = "Asia/Kolkata";

// ==================================================
// BUILD EMAIL
// ==================================================

function buildDailyReportEmail(report: any, recipientName?: string) {
  const overdueCount = Number(report.summary?.overdue ?? 0);

  const totalTasks = Number(report.summary?.total ?? 0);

  const subject =
    overdueCount > 0
      ? `TaskBizz Daily Summary — ${report.date} | ${overdueCount} Overdue Tasks`
      : `TaskBizz Daily Summary — ${report.date} | ${totalTasks} Tasks`;

  const html = generateDailyTaskEmail(report, recipientName);

  const text = [
    "TaskBizz Daily Task Summary",
    "",
    `Date: ${report.date}`,
    "",
    `Total Tasks: ${report.summary?.total ?? 0}`,
    `Completed: ${report.summary?.completed ?? 0}`,
    `In Progress: ${report.summary?.inProgress ?? 0}`,
    `Pending: ${report.summary?.pending ?? 0}`,
    `On Track: ${report.summary?.onTrack ?? 0}`,
    `Delayed: ${report.summary?.delayed ?? 0}`,
    `Overdue: ${report.summary?.overdue ?? 0}`,
    `High Priority: ${report.summary?.highPriority ?? 0}`,
    "",
    "Detailed task information is available in the attached Excel report.",
    "",
    "This is an automated email from TaskBizz.",
  ].join("\n");

  return {
    subject,
    text,
    html,
  };
}

// ==================================================
// SEND REPORT TO ONE RECIPIENT
// ==================================================

async function sendReportToRecipient({
  orgId,
  recipient,
}: {
  orgId: string;
  recipient: {
    id: string;
    name: string | null;
    email: string | null;
    role: string;
  };
}) {
  // No email → nothing to send
  if (!recipient.email) {
    return;
  }

  // Get tenant Prisma through the already
  // registered factory from src/index.ts.
  const tenant = await getOrgPrisma(orgId);

  const isManager = recipient.role === "MANAGER";

  console.log(`Generating report for ${recipient.email} (${recipient.role})`);

  // ==================================================
  // REPORT SCOPE
  // ==================================================
  //
  // ADMIN
  // → organization-wide report
  //
  // MANAGER
  // → only projects where manager is project head
  //
  // EMPLOYEE
  // → never reaches this function because recipients
  //   are filtered to ADMIN + MANAGER only.
  // ==================================================

  const report = await generateDailyTaskReport(
    tenant,
    isManager
      ? {
          managerId: recipient.id,
        }
      : undefined,
  );

  // ==================================================
  // GENERATE EXCEL
  // ==================================================

  const excelBuffer = await generateDailyTaskExcel(report);

  // ==================================================
  // GENERATE EMAIL
  // ==================================================

  const { subject, text, html } = buildDailyReportEmail(
    report,
    recipient.name ?? undefined,
  );

  // ==================================================
  // SEND EMAIL
  // ==================================================

  await sendTaskEmail({
    to: recipient.email,
    subject,
    text,
    html,

    attachments: [
      {
        filename: `TaskBizz-Daily-Summary-${report.date}.xlsx`,
        content: excelBuffer,
      },
    ],
  });

  console.log(`Daily report sent successfully to ${recipient.email}`);
}

// ==================================================
// PROCESS ONE ORGANIZATION
// ==================================================

async function processOrganization(org: { id: string; dbName: string }) {
  const core = getCorePrisma();

  /*
   * IMPORTANT:
   *
   * User belongs to organization through orgId
   * according to the existing application structure.
   */

  // ==================================================
  // GET REPORT RECIPIENTS
  // ==================================================
  //
  // Only ADMIN and MANAGER receive daily reports.
  // EMPLOYEE does not receive the report.
  // ==================================================

  const recipients = await core.user.findMany({
    where: {
      orgId: org.id,

      role: {
        in: ["ADMIN", "MANAGER"],
      },
    },

    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  });

  console.log(`Organization ${org.id}: ${recipients.length} report recipients`);

  if (!recipients.length) {
    return;
  }

  // ==================================================
  // EMAIL CONCURRENCY
  // ==================================================

  const emailLimit = pLimit(EMAIL_CONCURRENCY);

  await Promise.all(
    recipients.map((recipient) =>
      emailLimit(async () => {
        try {
          await sendReportToRecipient({
            orgId: org.id,
            recipient,
          });
        } catch (error) {
          console.error(
            `Daily report failed for org=${org.id}, recipient=${recipient.email}:`,
            (error as any)?.message ?? error,
          );
        }
      }),
    ),
  );
}

// ==================================================
// PROCESS ONE ORGANIZATION MANUALLY
// ==================================================

export async function processSingleOrganization(orgId: string) {
  const core = getCorePrisma();

  const org = await core.organization.findUnique({
    where: {
      id: orgId,
    },

    select: {
      id: true,
      dbName: true,
    },
  });

  if (!org) {
    throw new Error(`Organization not found: ${orgId}`);
  }

  if (!org.dbName || org.dbName.trim() === "") {
    throw new Error(`Organization ${orgId} has no database configured`);
  }

  console.log(`Running daily report for ONLY org=${org.id}`);

  await processOrganization(org);

  console.log(`Single organization report completed for org=${org.id}`);
}

// ==================================================
// SWEEP ALL ORGANIZATIONS
// ==================================================

export async function sweepAllOrganizations() {
  const core = getCorePrisma();

  // ==================================================
  // GET ALL ORGANIZATIONS
  // ==================================================

  const organizations = await core.organization.findMany({
    where: {
      NOT: {
        dbName: "",
      },
    },

    select: {
      id: true,
      dbName: true,
    },

    take: 1000,
  });

  // ==================================================
  // REMOVE INVALID ORGANIZATIONS
  // ==================================================

  const validOrganizations = organizations.filter(
    (org) => org.dbName && org.dbName.trim() !== "",
  );

  console.log(`Daily report sweep: ${validOrganizations.length} organizations`);

  // ==================================================
  // TENANT CONCURRENCY
  // ==================================================

  const tenantLimit = pLimit(TENANT_CONCURRENCY);

  await Promise.all(
    validOrganizations.map((org) =>
      tenantLimit(async () => {
        // ==================================================
        // REDIS LOCK
        // ==================================================
        //
        // Prevent the same organization's report from
        // being processed concurrently.
        // ==================================================

        const lockKey = `daily-task-report:${org.id}`;

        const token = await acquireLock(lockKey, 60 * 30);

        if (!token) {
          console.log(`Skipping org=${org.id}; daily report already running.`);

          return;
        }

        try {
          await processOrganization(org);
        } catch (error) {
          console.error(
            `Organization ${org.id} daily report failed:`,
            (error as any)?.message ?? error,
          );
        } finally {
          await releaseLock(lockKey, token).catch((error) => {
            console.error(
              `Failed to release daily report lock for org=${org.id}:`,
              error,
            );
          });
        }
      }),
    ),
  );

  console.log("Daily report sweep completed.");
}

// ==================================================
// CRON
// ==================================================

const dailyReportCron = cron.schedule(
  "30 19 * * *",
  async () => {
    console.log("Starting TaskBizz daily management report...");

    try {
      await sweepAllOrganizations();
    } catch (error) {
      console.error(
        "Daily report cron failed:",
        (error as any)?.message ?? error,
      );
    }
  },
  {
    timezone: REPORT_TIMEZONE,
  },
);

// ==================================================
// START DAILY REPORT MAILER
// ==================================================
//
// IMPORTANT:
//
// Prisma and the Org Prisma Factory are initialized
// by src/index.ts BEFORE this function is called.
//
// Therefore this file does NOT create another
// PrismaClient and does NOT initialize DI again.
// ==================================================

export function startDailyReportMailer() {
  console.log("==========================================");

  console.log("TaskBizz Daily Report Mailer started.");

  console.log(`Schedule: Every day at 7:30 PM ${REPORT_TIMEZONE}`);

  console.log(`Tenant concurrency: ${TENANT_CONCURRENCY}`);

  console.log(`Email concurrency: ${EMAIL_CONCURRENCY}`);

  console.log("==========================================");

  dailyReportCron.start();
}

// ==================================================
// STOP DAILY REPORT MAILER
// ==================================================
//
// This only stops the cron.
//
// It intentionally DOES NOT disconnect Prisma,
// because Prisma belongs to src/index.ts.
// ==================================================

export function stopDailyReportMailer() {
  console.log("Stopping TaskBizz daily report mailer...");

  dailyReportCron.stop();
}

// ==================================================
// EXPORT CRON INSTANCE IF NEEDED
// ==================================================

export { dailyReportCron };
