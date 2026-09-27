"use strict";
// src/jobs/licenseMailer.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processLicenseReminders = processLicenseReminders;
exports.startLicenseMailer = startLicenseMailer;
const node_cron_1 = __importDefault(require("node-cron"));
const container_1 = require("../di/container");
const mailerSend_1 = require("../utils/mailerSend");
const CRON_SCHEDULE = "0 8 * * *";
const CRON_TIMEZONE = "Asia/Kolkata";
let running = false;
/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */
function formatDate(date) {
    return new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: CRON_TIMEZONE,
    }).format(date);
}
function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
function getReminderLabel(offsetDays) {
    if (offsetDays === 0) {
        return "expires today";
    }
    if (offsetDays < 0) {
        const days = Math.abs(offsetDays);
        if (days === 1)
            return "expires tomorrow";
        return `expires in ${days} days`;
    }
    return "license expiry reminder";
}
/* -------------------------------------------------------
   Individual license email
------------------------------------------------------- */
async function sendLicenseReminderEmail({ recipient, license, offsetDays, orgName, }) {
    const expiryDate = formatDate(license.expiresOn);
    const reminderLabel = getReminderLabel(offsetDays);
    const subject = `License Reminder: ${license.title} ${reminderLabel}`;
    const text = `Hi ${recipient.name || "there"},

This is a reminder regarding the following license:

License: ${license.title}
License Number: ${license.licenseNumber || "N/A"}
Expiry Date: ${expiryDate}
Status: ${reminderLabel}

Please take the necessary action before the license expires.

Regards,
${orgName}`;
    const html = `
    <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:20px;color:#111827;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,0.05);">

        <div style="background:#2563eb;padding:20px;text-align:center;">
          <h1 style="color:#ffffff;margin:0;font-size:22px;">
            License Expiry Reminder
          </h1>
        </div>

        <div style="padding:24px;">

          <p>
            Hi <strong>${escapeHtml(recipient.name || "there")}</strong>,
          </p>

          <p>
            This is a reminder that the following license
            <strong>${escapeHtml(reminderLabel)}</strong>.
          </p>

          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;">
                License
              </td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:bold;">
                ${escapeHtml(license.title)}
              </td>
            </tr>

            <tr>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;">
                License Number
              </td>
              <td style="padding:10px;border-bottom:1px solid #e5e7eb;font-weight:bold;">
                ${escapeHtml(license.licenseNumber || "N/A")}
              </td>
            </tr>

            <tr>
              <td style="padding:10px;">
                Expiry Date
              </td>
              <td style="padding:10px;font-weight:bold;">
                ${expiryDate}
              </td>
            </tr>
          </table>

          <p>
            Please take the necessary action before the license expires.
          </p>

          <p>
            Regards,<br/>
<strong>${escapeHtml(orgName)}</strong>
          </p>

        </div>

        <div style="background:#f3f4f6;padding:12px;text-align:center;font-size:12px;color:#6b7280;">
          © ${new Date().getFullYear()} TaskBizz
        </div>

      </div>
    </div>
  `;
    await (0, mailerSend_1.sendTaskEmail)({
        to: recipient.email,
        subject,
        text,
        html,
    });
}
/* -------------------------------------------------------
   Process one organization
------------------------------------------------------- */
async function processOrganization(orgId) {
    const orgPrisma = await (0, container_1.getOrgPrisma)(orgId);
    const corePrisma = (0, container_1.getCorePrisma)();
    const org = await corePrisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
    });
    const orgName = org?.name || "Your Organization";
    const now = new Date();
    const reminders = (await orgPrisma.scheduledReminder.findMany({
        where: {
            status: "PENDING",
            runAt: {
                lte: now,
            },
        },
        orderBy: {
            runAt: "asc",
        },
        take: 100,
        include: {
            license: {
                select: {
                    id: true,
                    title: true,
                    licenseNumber: true,
                    expiresOn: true,
                    responsibleId: true,
                    clientId: true,
                },
            },
        },
    }));
    if (!reminders.length) {
        return;
    }
    console.log(`[LicenseMailer] ${orgId}: found ${reminders.length} pending reminder(s)`);
    /*
     * Resolve responsible users
     */
    const responsibleIds = Array.from(new Set(reminders.map((r) => r.license.responsibleId).filter(Boolean)));
    const responsibleUsers = responsibleIds.length > 0
        ? await corePrisma.user.findMany({
            where: {
                id: {
                    in: responsibleIds,
                },
            },
            select: {
                id: true,
                name: true,
                email: true,
            },
        })
        : [];
    const responsibleMap = new Map(responsibleUsers.map((user) => [user.id, user]));
    /*
     * Resolve clients
     */
    const clientIds = Array.from(new Set(reminders.map((r) => r.license.clientId).filter(Boolean)));
    const clients = clientIds.length > 0
        ? await orgPrisma.client.findMany({
            where: {
                id: {
                    in: clientIds,
                },
            },
            select: {
                id: true,
                name: true,
                email: true,
            },
        })
        : [];
    const clientMap = new Map(clients.map((client) => [client.id, client]));
    /*
     * Admins receive one consolidated email
     * for licenses without a responsible person.
     *
     * We use the core user table because responsible
     * users are also stored there.
     */
    const admins = await corePrisma.user.findMany({
        where: {
            role: "ADMIN",
            orgId: orgId,
        },
        select: {
            id: true,
            name: true,
            email: true,
        },
    });
    const adminRecipients = admins.filter((admin) => !!admin.email);
    /*
     * Keep track of licenses without responsible person.
     * These will be included in ONE admin email.
     */
    const unassignedForAdmin = [];
    /*
     * Process individual reminders
     */
    for (const reminder of reminders) {
        try {
            const license = reminder.license;
            /*
             * If responsible person exists:
             * send reminder to responsible person.
             */
            if (license.responsibleId) {
                const responsible = responsibleMap.get(license.responsibleId);
                if (responsible?.email) {
                    await sendLicenseReminderEmail({
                        recipient: {
                            email: responsible.email,
                            name: responsible.name,
                        },
                        license,
                        offsetDays: reminder.offsetDays,
                        orgName,
                    });
                }
            }
            else {
                /*
                 * No responsible person:
                 * do not send admin email yet.
                 * Add it to consolidated list.
                 */
                unassignedForAdmin.push(reminder);
            }
            /*
             * Send to client separately if client email exists.
             */
            if (license.clientId) {
                const client = clientMap.get(license.clientId);
                if (client?.email) {
                    await sendLicenseReminderEmail({
                        recipient: {
                            email: client.email,
                            name: client.name,
                        },
                        license,
                        offsetDays: reminder.offsetDays,
                        orgName,
                    });
                }
            }
            /*
             * Mark reminder as sent.
             */
            await orgPrisma.scheduledReminder.update({
                where: {
                    id: reminder.id,
                },
                data: {
                    status: "SENT",
                    sentAt: new Date(),
                    attempts: {
                        increment: 1,
                    },
                    lastError: null,
                    meta: {
                        offsetDays: reminder.offsetDays,
                        responsibleId: license.responsibleId,
                        clientId: license.clientId,
                    },
                },
            });
            /*
             * Update license reminder bookkeeping.
             */
            await orgPrisma.license.update({
                where: {
                    id: license.id,
                },
                data: {
                    lastReminderAt: new Date(),
                },
            });
        }
        catch (error) {
            console.error(`[LicenseMailer] Failed reminder ${reminder.id}:`, error);
            await orgPrisma.scheduledReminder.update({
                where: {
                    id: reminder.id,
                },
                data: {
                    status: "FAILED",
                    attempts: {
                        increment: 1,
                    },
                    lastError: String(error?.message ?? error).slice(0, 1000),
                },
            });
        }
    }
    /*
     * ONE consolidated admin email.
     */
    if (unassignedForAdmin.length > 0 && adminRecipients.length > 0) {
        const rows = unassignedForAdmin
            .map((reminder) => {
            const license = reminder.license;
            return `
          <tr>
            <td style="padding:10px;border-bottom:1px solid #e5e7eb;">
              ${escapeHtml(license.title)}
            </td>
            <td style="padding:10px;border-bottom:1px solid #e5e7eb;">
              ${escapeHtml(license.licenseNumber || "N/A")}
            </td>
            <td style="padding:10px;border-bottom:1px solid #e5e7eb;">
              ${formatDate(license.expiresOn)}
            </td>
            <td style="padding:10px;border-bottom:1px solid #e5e7eb;">
              ${escapeHtml(getReminderLabel(reminder.offsetDays))}
            </td>
          </tr>
        `;
        })
            .join("");
        const adminHtml = `
      <div style="font-family:Arial,sans-serif;background:#f9fafb;padding:20px;color:#111827;">
        <div style="max-width:750px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;">

          <div style="background:#2563eb;padding:20px;text-align:center;">
            <h1 style="color:#ffffff;margin:0;font-size:22px;">
              License Expiry Summary
            </h1>
          </div>

          <div style="padding:24px;">

            <p>
              The following licenses do not have a responsible person assigned
              and require attention:
            </p>

            <table style="width:100%;border-collapse:collapse;margin-top:20px;">
              <thead>
                <tr style="background:#f3f4f6;">
                  <th style="padding:10px;text-align:left;">License</th>
                  <th style="padding:10px;text-align:left;">Number</th>
                  <th style="padding:10px;text-align:left;">Expiry</th>
                  <th style="padding:10px;text-align:left;">Reminder</th>
                </tr>
              </thead>

              <tbody>
                ${rows}
              </tbody>
            </table>

            <p style="margin-top:24px;">
              Please review these licenses in TaskBizz and assign a responsible
              person where required.
            </p>

          </div>

          <div style="background:#f3f4f6;padding:12px;text-align:center;font-size:12px;color:#6b7280;">
            © ${new Date().getFullYear()} TaskBizz
          </div>

        </div>
      </div>
    `;
        const adminText = `
License Expiry Summary

The following licenses do not have a responsible person assigned:

${unassignedForAdmin
            .map((reminder) => {
            const license = reminder.license;
            return `- ${license.title} | ${license.licenseNumber || "N/A"} | Expiry: ${formatDate(license.expiresOn)} | ${getReminderLabel(reminder.offsetDays)}`;
        })
            .join("\n")}

Please review these licenses in TaskBizz.
`;
        /*
         * If there are multiple admins, each admin gets the
         * same consolidated email.
         */
        for (const admin of adminRecipients) {
            try {
                await (0, mailerSend_1.sendTaskEmail)({
                    to: admin.email,
                    subject: `License Expiry Summary — ${unassignedForAdmin.length} License(s)`,
                    text: adminText,
                    html: adminHtml,
                });
            }
            catch (error) {
                console.error(`[LicenseMailer] Failed admin email to ${admin.email}:`, error);
            }
        }
    }
}
/* -------------------------------------------------------
   Process all organizations
------------------------------------------------------- */
async function processLicenseReminders() {
    if (running) {
        console.log("[LicenseMailer] Previous run still active. Skipping.");
        return;
    }
    running = true;
    try {
        const corePrisma = (0, container_1.getCorePrisma)();
        /*
         * We need all organizations because each organization
         * has its own tenant database.
         */
        const organizations = await corePrisma.organization.findMany({
            select: {
                id: true,
            },
        });
        for (const organization of organizations) {
            try {
                await processOrganization(organization.id);
            }
            catch (error) {
                console.error(`[LicenseMailer] Failed organization ${organization.id}:`, error);
            }
        }
    }
    catch (error) {
        console.error("[LicenseMailer] Fatal error:", error);
    }
    finally {
        running = false;
    }
}
/* -------------------------------------------------------
   Cron
------------------------------------------------------- */
function startLicenseMailer() {
    console.log(`[LicenseMailer] Starting cron: ${CRON_SCHEDULE} (${CRON_TIMEZONE})`);
    node_cron_1.default.schedule(CRON_SCHEDULE, async () => {
        console.log(`[LicenseMailer] Running at ${new Date().toISOString()}`);
        await processLicenseReminders();
    }, {
        timezone: CRON_TIMEZONE,
    });
}
