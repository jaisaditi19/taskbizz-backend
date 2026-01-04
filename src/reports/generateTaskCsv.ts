import { stringify } from "csv-stringify";
import { BATCH_SIZE, CSV_MAX_ROWS } from "./report.constants";

/* ---------- type helpers ---------- */

function isString(v: unknown): v is string {
  return typeof v === "string";
}

type Row = {
  id: string;
  startDate: Date | null;
  dueDate: Date | null;
  status: string;
  priority: string | null;
  remarks: string | null;
  clientId: string | null;
  assignedToId: string | null;
  assignees: { userId: string }[];
  task: {
    title: string | null;
    project: { name: string | null } | null;
    assignees: { userId: string }[];
  } | null;
};

export async function generateTaskCsv(prisma: any, where: any, res: any) {
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=Tasks_Report.csv");

  /* ---------- preload lookups ---------- */

  const clients = await prisma.client.findMany({
    select: { id: true, name: true },
  });
  const clientsById = new Map<string, string>(
    clients.map((c: any) => [c.id, c.name])
  );

  const users = await prisma.user.findMany({
    select: { id: true, name: true },
  });
  const usersById = new Map<string, string>(
    users.map((u: any) => [u.id, u.name])
  );

  /* ---------- CSV writer ---------- */

  const csv = stringify({
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

  let cursor: { startDate: Date; id: string } | null = null;
  let total = 0;

  while (true) {
    const rows: Row[] = await prisma.taskOccurrence.findMany({
      where,
      take: BATCH_SIZE,
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

    if (rows.length === 0) break;

    for (const r of rows) {
      /* ---------- assignee resolution ---------- */

      const occurrenceAssignees =
        r.assignees?.map((a) => usersById.get(a.userId)).filter(isString) ?? [];

      const taskAssignees =
        r.task?.assignees
          ?.map((a) => usersById.get(a.userId))
          .filter(isString) ?? [];

      let assignedTo: string[] = [];

      if (occurrenceAssignees.length > 0) {
        assignedTo = occurrenceAssignees;
      } else if (taskAssignees.length > 0) {
        assignedTo = taskAssignees;
      } else if (r.assignedToId) {
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
    if (total > CSV_MAX_ROWS) {
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
