"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTaskCsv = generateTaskCsv;
const csv_stringify_1 = require("csv-stringify");
const report_constants_1 = require("./report.constants");
/* ---------- type helpers ---------- */
function isString(v) {
    return typeof v === "string";
}
async function generateTaskCsv(prisma, where, res) {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=Tasks_Report.csv");
    /* ---------- preload lookups ---------- */
    const clients = await prisma.client.findMany({
        select: { id: true, name: true },
    });
    const clientsById = new Map(clients.map((c) => [c.id, c.name]));
    const users = await prisma.user.findMany({
        select: { id: true, name: true },
    });
    const usersById = new Map(users.map((u) => [u.id, u.name]));
    /* ---------- CSV writer ---------- */
    const csv = (0, csv_stringify_1.stringify)({
        header: true,
        columns: [
            "Task Title",
            "Project Name",
            "Client Name",
            "Status",
            "Priority",
            "Assigned To",
            "Start Date",
            "Due Date",
            "Remarks",
        ],
    });
    csv.pipe(res);
    let cursor = null;
    let total = 0;
    while (true) {
        const rows = await prisma.taskOccurrence.findMany({
            where,
            take: report_constants_1.BATCH_SIZE,
            ...(cursor
                ? {
                    skip: 1,
                    cursor: { startDate_id: cursor },
                }
                : {}),
            orderBy: [{ startDate: "asc" }, { id: "asc" }],
            select: {
                id: true,
                startDate: true,
                dueDate: true,
                status: true,
                priority: true,
                remarks: true,
                clientId: true,
                assignedToId: true,
                assignees: { select: { userId: true } },
                task: {
                    select: {
                        title: true,
                        project: { select: { name: true } },
                        assignees: { select: { userId: true } },
                    },
                },
            },
        });
        if (rows.length === 0)
            break;
        for (const r of rows) {
            /* ---------- assignee resolution ---------- */
            const occurrenceAssignees = r.assignees?.map((a) => usersById.get(a.userId)).filter(isString) ?? [];
            const taskAssignees = r.task?.assignees
                ?.map((a) => usersById.get(a.userId))
                .filter(isString) ?? [];
            let assignedTo = [];
            if (occurrenceAssignees.length > 0) {
                assignedTo = occurrenceAssignees;
            }
            else if (taskAssignees.length > 0) {
                assignedTo = taskAssignees;
            }
            else if (r.assignedToId) {
                const single = usersById.get(r.assignedToId);
                if (typeof single === "string") {
                    assignedTo = [single];
                }
            }
            csv.write({
                "Task Title": r.task?.title ?? "",
                "Project Name": r.task?.project?.name ?? "",
                "Client Name": r.clientId ? clientsById.get(r.clientId) ?? "" : "",
                Status: r.status,
                Priority: r.priority ?? "",
                "Assigned To": assignedTo.join(", "),
                "Start Date": r.startDate?.toISOString() ?? "",
                "Due Date": r.dueDate?.toISOString() ?? "",
                Remarks: r.remarks ?? "",
            });
        }
        total += rows.length;
        if (total > report_constants_1.CSV_MAX_ROWS) {
            csv.end();
            throw new Error("Report too large. Narrow filters.");
        }
        const last = rows[rows.length - 1];
        if (!last.startDate) {
            throw new Error("Invariant violation: startDate required for cursor");
        }
        cursor = { startDate: last.startDate, id: last.id };
    }
    csv.end();
}
