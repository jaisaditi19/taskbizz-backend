// // src/jobs/reminderJob.ts
// import cron from "node-cron";
// import { getOrgPrismaClient } from "../utils/tenantUtils";
// import { DateTime } from "luxon";
// import { expandRRuleOccurrences } from "../utils/recurrence";

// /**
//  * Simple reminder job.
//  * - runs every 15 minutes
//  * - looks for occurrences in the next X hours (configurable)
//  * - creates Reminder rows for occurrences that don't have a reminder and are not completed
//  * - sends reminders whose remindAt <= now (here we just log; replace with actual notifier)
//  */
// export function startReminderJob() {
//   cron.schedule("*/15 * * * *", async () => {
//     try {
//       const now = DateTime.utc();
//       const windowStart = now.toJSDate();
//       const lookAheadHours = 24;
//       const windowEnd = now.plus({ hours: lookAheadHours }).toJSDate();

//       const orgPrisma = await getOrgPrismaClient((req.user as any).orgId);

//       // fetch relevant tasks (could filter by assignedToId != null)
//       const tasks = await prisma.task.findMany({
//         where: {},
//       });

//       for (const t of tasks) {
//         if (!t.recurrenceRule) {
//           // one-off: if startDate in window and no completion & no reminder => create reminder
//           if (t.startDate >= windowStart && t.startDate <= windowEnd) {
//             const existing = await prisma.reminder.findFirst({
//               where: { taskId: t.id, occurrenceAt: t.startDate, sent: false },
//             });
//             const completed = await prisma.completionLog.findFirst({
//               where: { taskId: t.id, occurrenceAt: t.startDate },
//             });
//             if (!existing && !completed) {
//               const remindAt = DateTime.fromJSDate(t.startDate)
//                 .minus({ hours: 1 })
//                 .toJSDate();
//               await prisma.reminder.create({
//                 data: {
//                   taskId: t.id,
//                   occurrenceAt: t.startDate,
//                   remindAt,
//                   channel: "in-app",
//                 },
//               });
//             }
//           }
//         } else {
//           // recurring: expand
//           const occs = expandRRuleOccurrences(
//             t.startDate,
//             t.recurrenceRule,
//             windowStart,
//             windowEnd
//           );
//           if (!occs.length) continue;

//           // batch load completion logs & existing reminders for this task-window
//           const completions = await prisma.completionLog.findMany({
//             where: { taskId: t.id, occurrenceAt: { in: occs } },
//           });
//           const completedSet = new Set(
//             completions.map((c) => c.occurrenceAt.getTime())
//           );

//           const existingReminders = await prisma.reminder.findMany({
//             where: { taskId: t.id, occurrenceAt: { in: occs }, sent: false },
//           });
//           const existingSet = new Set(
//             existingReminders.map((r) => r.occurrenceAt.getTime())
//           );

//           for (const occStart of occs) {
//             const key = occStart.getTime();
//             if (completedSet.has(key) || existingSet.has(key)) continue;
//             const remindAt = DateTime.fromJSDate(occStart)
//               .minus({ hours: 1 })
//               .toJSDate();
//             await prisma.reminder.create({
//               data: {
//                 taskId: t.id,
//                 occurrenceAt: occStart,
//                 remindAt,
//                 channel: "in-app",
//               },
//             });
//           }
//         }
//       }

//       // send reminders due now
//       const dueReminders = await prisma.reminder.findMany({
//         where: { sent: false, remindAt: { lte: new Date() } },
//         include: { task: true },
//       });

//       for (const r of dueReminders) {
//         // TODO: replace this with your notification/email/push code
//         console.log(
//           `[Reminder] Task ${
//             r.taskId
//           } occurrence ${r.occurrenceAt.toISOString()} send via ${r.channel}`
//         );

//         // mark sent
//         await prisma.reminder.update({
//           where: { id: r.id },
//           data: { sent: true, sentAt: new Date() },
//         });
//       }
//     } catch (err) {
//       console.error("Reminder job error:", err);
//     }
//   });
// }
