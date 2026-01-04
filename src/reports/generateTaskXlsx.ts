// src/reports/generateTaskXlsx.ts
import XLSX from "xlsx";
import { getOrgPrisma, getCorePrisma } from "../di/container";
import { Request, Response } from "express";

export async function generateTaskXlsx(
  req: Request & { user?: any },
  where: any,
  res: Response
) {
  const orgId = req.user?.orgId;
  if (!orgId) {
    throw new Error("Org ID missing in generateTaskXlsx");
  }

  const prisma = await getOrgPrisma(orgId); // ✅ ALWAYS DEFINED
  const corePrisma = await getCorePrisma();

  const clients = await prisma.client.findMany({
    select: { id: true, name: true },
  });
  const clientsById = new Map(clients.map((c) => [c.id, c.name]));

  const users = await corePrisma.user.findMany({
    select: { id: true, name: true },
  });
  const usersById = new Map(users.map((u) => [u.id, u.name]));

  const rows = await prisma.taskOccurrence.findMany({
    where,
    orderBy: [{ startDate: "asc" }, { id: "asc" }],
    select: {
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

  let assignedToNames: string[] = [];

  const data = rows.map((r: any) => {
    const occurrenceAssignees =
      r.assignees?.map((a: any) => usersById.get(a.userId)).filter(Boolean) ??
      [];

    const taskAssignees =
      r.task?.assignees
        ?.map((a: any) => usersById.get(a.userId))
        .filter(Boolean) ?? [];

    let assignedToNames: string[] = [];

    if (occurrenceAssignees.length > 0) {
      assignedToNames = occurrenceAssignees;
    } else if (taskAssignees.length > 0) {
      assignedToNames = taskAssignees;
    } else if (r.assignedToId) {
      const single = usersById.get(r.assignedToId);
      if (single) assignedToNames = [single];
    }

    return {
      "Task Title": r.task?.title ?? "",
      "Project Name": r.task?.project?.name ?? "",
      "Client Name": r.clientId ? clientsById.get(r.clientId) ?? "" : "",
      Status: r.status,
      Priority: r.priority,
      "Assigned To": assignedToNames.join(", "),
      "Start Date": r.startDate?.toISOString() ?? "",
      "Due Date": r.dueDate?.toISOString() ?? "",
      Remarks: r.remarks ?? "",
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(data);
  ws["!freeze"] = { ySplit: 1 };
  ws["!autofilter"] = { ref: ws["!ref"]! };

  XLSX.utils.book_append_sheet(wb, ws, "Tasks");

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=Tasks_Report.xlsx"
  );

  res.send(buffer);
}
