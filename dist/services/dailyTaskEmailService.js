"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDailyTaskEmail = generateDailyTaskEmail;
const luxon_1 = require("luxon");
const REPORT_TIMEZONE = "Asia/Kolkata";
function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
function formatDate(date) {
    if (!date)
        return "-";
    return luxon_1.DateTime.fromJSDate(new Date(date))
        .setZone(REPORT_TIMEZONE)
        .toFormat("dd MMM yyyy");
}
function statusLabel(status) {
    return status
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
function statusColor(status) {
    switch (status) {
        case "COMPLETED":
            return "#16A34A";
        case "IN_PROGRESS":
        case "IN_TESTING":
            return "#2563EB";
        case "DELAYED":
            return "#DC2626";
        case "ON_TRACK":
            return "#059669";
        case "APPROVED":
            return "#7C3AED";
        case "ON_HOLD":
            return "#D97706";
        case "PLANNING":
        case "OPEN":
            return "#64748B";
        case "CANCELLED":
            return "#94A3B8";
        default:
            return "#64748B";
    }
}
function statusBackground(status) {
    switch (status) {
        case "COMPLETED":
            return "#F0FDF4";
        case "IN_PROGRESS":
        case "IN_TESTING":
            return "#EFF6FF";
        case "DELAYED":
            return "#FEF2F2";
        case "ON_TRACK":
            return "#ECFDF5";
        case "APPROVED":
            return "#F5F3FF";
        case "ON_HOLD":
            return "#FFF7ED";
        case "PLANNING":
        case "OPEN":
            return "#F8FAFC";
        default:
            return "#F8FAFC";
    }
}
function statCard(value, label, color, background, icon) {
    return `
    <td width="33.33%" valign="top" style="padding:5px;">
      <table
        width="100%"
        cellpadding="0"
        cellspacing="0"
        border="0"
        style="
          background:#FFFFFF;
          border:1px solid #E2E8F0;
          border-radius:12px;
        "
      >
        <tr>
          <td style="
            padding:15px 14px;
            border-left:4px solid ${color};
            border-radius:12px;
          ">
            <table
              width="100%"
              cellpadding="0"
              cellspacing="0"
              border="0"
            >
              <tr>
                <td width="34" valign="top">
                  <div style="
                    width:30px;
                    height:30px;
                    line-height:30px;
                    text-align:center;
                    border-radius:8px;
                    background:${background};
                    color:${color};
                    font-size:14px;
                    font-weight:700;
                  ">
                    ${icon}
                  </div>
                </td>

                <td valign="top" style="padding-left:9px;">
                  <div style="
                    font-size:23px;
                    line-height:27px;
                    font-weight:700;
                    color:${color};
                  ">
                    ${Number(value ?? 0).toLocaleString("en-IN")}
                  </div>

                  <div style="
                    margin-top:3px;
                    font-size:11px;
                    line-height:16px;
                    font-weight:600;
                    color:#64748B;
                  ">
                    ${escapeHtml(label)}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  `;
}
function sectionTitle(title, subtitle) {
    return `
    <div style="
      margin:0 0 11px 0;
      font-size:17px;
      line-height:24px;
      font-weight:700;
      color:#172033;
    ">
      ${escapeHtml(title)}
    </div>
    ${subtitle
        ? `
      <div style="
        margin:-5px 0 12px 0;
        font-size:12px;
        line-height:18px;
        color:#64748B;
      ">
        ${escapeHtml(subtitle)}
      </div>
    `
        : ""}
  `;
}
function generateDailyTaskEmail(report, recipientName) {
    const greeting = recipientName?.trim()
        ? `Hi ${escapeHtml(recipientName)},`
        : "Hi,";
    const reportDate = luxon_1.DateTime.fromISO(report.date)
        .setZone(REPORT_TIMEZONE)
        .toFormat("dd MMM yyyy");
    const summary = report.summary ?? {};
    const total = Number(summary.total ?? 0);
    const completed = Number(summary.completed ?? 0);
    const inProgress = Number(summary.inProgress ?? 0);
    const pending = Number(summary.pending ?? 0);
    const delayed = Number(summary.delayed ?? 0);
    const overdue = Number(summary.overdue ?? 0);
    // ==================================================
    // ATTENTION TASKS
    // ==================================================
    const attentionTasks = report.attentionTasks ?? [];
    const topAttentionTasks = attentionTasks.slice(0, 8);
    const attentionRows = topAttentionTasks
        .map((task, index) => {
        const projectName = task.task?.project?.name ?? task.project?.name ?? "No Project";
        const isOverdue = report.overdueTasks?.some((item) => item.id === task.id) ?? false;
        const reason = isOverdue
            ? "Overdue"
            : task.status === "DELAYED"
                ? "Delayed"
                : "High Priority";
        const reasonColor = reason === "Overdue"
            ? "#DC2626"
            : reason === "Delayed"
                ? "#EA580C"
                : "#B45309";
        const reasonBackground = reason === "Overdue"
            ? "#FEF2F2"
            : reason === "Delayed"
                ? "#FFF7ED"
                : "#FFFBEB";
        const taskStatusColor = statusColor(task.status);
        const taskStatusBackground = statusBackground(task.status);
        return `
        <tr style="background:${index % 2 === 0 ? "#FFFFFF" : "#FAFBFC"};">

          <td style="
            padding:12px 10px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            line-height:18px;
            color:#172033;
          ">
            <strong>${escapeHtml(task.title)}</strong>
          </td>

          <td style="
            padding:12px 10px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            line-height:18px;
            color:#64748B;
          ">
            ${escapeHtml(projectName)}
          </td>

          <td style="
            padding:12px 10px;
            border-bottom:1px solid #EEF2F7;
          ">
            <span style="
              display:inline-block;
              padding:4px 8px;
              border-radius:6px;
              background:${taskStatusBackground};
              color:${taskStatusColor};
              font-size:10px;
              line-height:14px;
              font-weight:700;
              white-space:nowrap;
            ">
              ${escapeHtml(statusLabel(task.status))}
            </span>
          </td>

          <td style="
            padding:12px 10px;
            border-bottom:1px solid #EEF2F7;
          ">
            <span style="
              display:inline-block;
              padding:4px 8px;
              border-radius:6px;
              background:${reasonBackground};
              color:${reasonColor};
              font-size:10px;
              line-height:14px;
              font-weight:700;
              white-space:nowrap;
            ">
              ${escapeHtml(reason)}
            </span>
          </td>

          <td style="
            padding:12px 10px;
            border-bottom:1px solid #EEF2F7;
            font-size:11px;
            line-height:17px;
            color:#475569;
            white-space:nowrap;
          ">
            ${formatDate(task.dueDate)}
          </td>

        </tr>
      `;
    })
        .join("");
    const attentionSection = topAttentionTasks.length > 0
        ? `
        <div style="margin-top:30px;">

          ${sectionTitle("Requires Attention", `${overdue.toLocaleString("en-IN")} overdue task${overdue === 1 ? "" : "s"}${delayed > 0 ? ` and ${delayed} delayed task${delayed === 1 ? "" : "s"}` : ""} need review.`)}

          <table
            width="100%"
            cellpadding="0"
            cellspacing="0"
            border="0"
            style="
              border-collapse:separate;
              border-spacing:0;
              border:1px solid #E2E8F0;
              border-radius:12px;
              overflow:hidden;
            "
          >
            <thead>
              <tr style="background:#F8FAFC;">
                <th align="left" style="
                  padding:11px 10px;
                  font-size:10px;
                  line-height:14px;
                  color:#64748B;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.4px;
                  border-bottom:1px solid #E2E8F0;
                ">Task</th>

                <th align="left" style="
                  padding:11px 10px;
                  font-size:10px;
                  line-height:14px;
                  color:#64748B;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.4px;
                  border-bottom:1px solid #E2E8F0;
                ">Project</th>

                <th align="left" style="
                  padding:11px 10px;
                  font-size:10px;
                  line-height:14px;
                  color:#64748B;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.4px;
                  border-bottom:1px solid #E2E8F0;
                ">Status</th>

                <th align="left" style="
                  padding:11px 10px;
                  font-size:10px;
                  line-height:14px;
                  color:#64748B;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.4px;
                  border-bottom:1px solid #E2E8F0;
                ">Reason</th>

                <th align="left" style="
                  padding:11px 10px;
                  font-size:10px;
                  line-height:14px;
                  color:#64748B;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.4px;
                  border-bottom:1px solid #E2E8F0;
                ">Due</th>
              </tr>
            </thead>

            <tbody>
              ${attentionRows}
            </tbody>
          </table>

          ${attentionTasks.length > 8
            ? `
                <div style="
                  margin-top:9px;
                  font-size:11px;
                  line-height:17px;
                  color:#64748B;
                ">
                  Showing 8 of ${attentionTasks.length} tasks requiring attention.
                  See the attached Excel report for the complete list.
                </div>
              `
            : ""}

        </div>
      `
        : `
        <div style="
          margin-top:30px;
          padding:16px 18px;
          background:#F0FDF4;
          border:1px solid #BBF7D0;
          border-radius:12px;
        ">
          <div style="
            font-size:14px;
            line-height:20px;
            font-weight:700;
            color:#166534;
          ">
            ✓ No tasks currently require attention
          </div>

          <div style="
            margin-top:4px;
            font-size:12px;
            line-height:18px;
            color:#15803D;
          ">
            No overdue or delayed tasks were found.
          </div>
        </div>
      `;
    // ==================================================
    // STATUS BREAKDOWN
    // ==================================================
    const statusEntries = Object.entries(report.statusBreakdown ?? {})
        .map(([status, count]) => ({
        status,
        count: Number(count),
    }))
        .sort((a, b) => b.count - a.count);
    const maxStatusCount = Math.max(1, ...statusEntries.map((item) => item.count));
    const statusRows = statusEntries
        .map(({ status, count }, index) => {
        const color = statusColor(status);
        const width = Math.max(3, Math.round((count / maxStatusCount) * 100));
        return `
        <tr>
          <td style="
            padding:${index === 0 ? "8px" : "9px"} 0;
            font-size:12px;
            line-height:18px;
            color:#334155;
            width:100px;
            white-space:nowrap;
          ">
            ${escapeHtml(statusLabel(status))}
          </td>

          <td style="padding:9px 10px;">
            <div style="
              height:7px;
              background:#EEF2F7;
              border-radius:5px;
              overflow:hidden;
            ">
              <div style="
                width:${width}%;
                height:7px;
                background:${color};
                border-radius:5px;
              "></div>
            </div>
          </td>

          <td align="right" style="
            padding:9px 0;
            font-size:12px;
            line-height:18px;
            font-weight:700;
            color:#172033;
            width:45px;
          ">
            ${count.toLocaleString("en-IN")}
          </td>
        </tr>
      `;
    })
        .join("");
    const statusSection = statusEntries.length > 0
        ? `
        <div style="margin-top:30px;">

          ${sectionTitle("Status Breakdown", "Current task distribution for this report.")}

          <table
            width="100%"
            cellpadding="0"
            cellspacing="0"
            border="0"
            style="
              background:#FFFFFF;
              border:1px solid #E2E8F0;
              border-radius:12px;
              padding:8px 14px;
            "
          >
            ${statusRows}
          </table>

        </div>
      `
        : "";
    // ==================================================
    // EMPLOYEE SUMMARY
    // ==================================================
    const employeeRows = (report.employeeSummary ?? [])
        .slice(0, 10)
        .map((employee, index) => `
        <tr style="background:${index % 2 === 0 ? "#FFFFFF" : "#FAFBFC"};">

          <td style="
            padding:11px 10px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            line-height:18px;
            color:#172033;
          ">
            <strong>${escapeHtml(employee.name)}</strong>
          </td>

          <td align="right" style="
            padding:11px 8px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            color:#334155;
          ">
            ${Number(employee.total ?? 0).toLocaleString("en-IN")}
          </td>

          <td align="right" style="
            padding:11px 8px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            font-weight:600;
            color:#16A34A;
          ">
            ${Number(employee.completed ?? 0).toLocaleString("en-IN")}
          </td>

          <td align="right" style="
            padding:11px 8px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            font-weight:600;
            color:#EA580C;
          ">
            ${Number(employee.delayed ?? 0).toLocaleString("en-IN")}
          </td>

          <td align="right" style="
            padding:11px 10px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            font-weight:700;
            color:#DC2626;
          ">
            ${Number(employee.overdue ?? 0).toLocaleString("en-IN")}
          </td>

        </tr>
      `)
        .join("");
    const employeeSection = employeeRows
        ? `
        <div style="margin-top:30px;">

          ${sectionTitle("Team Summary", "A quick view of task ownership and outstanding work.")}

          <table
            width="100%"
            cellpadding="0"
            cellspacing="0"
            border="0"
            style="
              border-collapse:separate;
              border-spacing:0;
              border:1px solid #E2E8F0;
              border-radius:12px;
              overflow:hidden;
            "
          >
            <thead>
              <tr style="background:#F8FAFC;">

                <th align="left" style="
                  padding:11px 10px;
                  font-size:10px;
                  line-height:14px;
                  color:#64748B;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Employee</th>

                <th align="right" style="
                  padding:11px 8px;
                  font-size:10px;
                  line-height:14px;
                  color:#64748B;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Total</th>

                <th align="right" style="
                  padding:11px 8px;
                  font-size:10px;
                  line-height:14px;
                  color:#16A34A;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Done</th>

                <th align="right" style="
                  padding:11px 8px;
                  font-size:10px;
                  line-height:14px;
                  color:#EA580C;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Delayed</th>

                <th align="right" style="
                  padding:11px 10px;
                  font-size:10px;
                  line-height:14px;
                  color:#DC2626;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Overdue</th>

              </tr>
            </thead>

            <tbody>
              ${employeeRows}
            </tbody>
          </table>

          ${(report.employeeSummary ?? []).length > 10
            ? `
                <div style="
                  margin-top:8px;
                  font-size:11px;
                  line-height:17px;
                  color:#64748B;
                ">
                  Showing the top 10 employees. See the attached Excel report for complete details.
                </div>
              `
            : ""}

        </div>
      `
        : "";
    // ==================================================
    // PROJECT SUMMARY
    // ==================================================
    const projectRows = (report.projectSummary ?? [])
        .slice(0, 10)
        .map((project, index) => `
        <tr style="background:${index % 2 === 0 ? "#FFFFFF" : "#FAFBFC"};">

          <td style="
            padding:11px 10px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            line-height:18px;
            color:#172033;
          ">
            <strong>${escapeHtml(project.projectName)}</strong>
          </td>

          <td align="right" style="
            padding:11px 8px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            color:#334155;
          ">
            ${Number(project.total ?? 0).toLocaleString("en-IN")}
          </td>

          <td align="right" style="
            padding:11px 8px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            font-weight:600;
            color:#16A34A;
          ">
            ${Number(project.completed ?? 0).toLocaleString("en-IN")}
          </td>

          <td align="right" style="
            padding:11px 8px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            font-weight:600;
            color:#EA580C;
          ">
            ${Number(project.delayed ?? 0).toLocaleString("en-IN")}
          </td>

          <td align="right" style="
            padding:11px 10px;
            border-bottom:1px solid #EEF2F7;
            font-size:12px;
            font-weight:700;
            color:#DC2626;
          ">
            ${Number(project.overdue ?? 0).toLocaleString("en-IN")}
          </td>

        </tr>
      `)
        .join("");
    const projectSection = projectRows
        ? `
        <div style="margin-top:30px;">

          ${sectionTitle("Project Summary", "Task distribution across active projects.")}

          <table
            width="100%"
            cellpadding="0"
            cellspacing="0"
            border="0"
            style="
              border-collapse:separate;
              border-spacing:0;
              border:1px solid #E2E8F0;
              border-radius:12px;
              overflow:hidden;
            "
          >
            <thead>
              <tr style="background:#F8FAFC;">

                <th align="left" style="
                  padding:11px 10px;
                  font-size:10px;
                  line-height:14px;
                  color:#64748B;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Project</th>

                <th align="right" style="
                  padding:11px 8px;
                  font-size:10px;
                  line-height:14px;
                  color:#64748B;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Total</th>

                <th align="right" style="
                  padding:11px 8px;
                  font-size:10px;
                  line-height:14px;
                  color:#16A34A;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Done</th>

                <th align="right" style="
                  padding:11px 8px;
                  font-size:10px;
                  line-height:14px;
                  color:#EA580C;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Delayed</th>

                <th align="right" style="
                  padding:11px 10px;
                  font-size:10px;
                  line-height:14px;
                  color:#DC2626;
                  font-weight:700;
                  text-transform:uppercase;
                  letter-spacing:.35px;
                  border-bottom:1px solid #E2E8F0;
                ">Overdue</th>

              </tr>
            </thead>

            <tbody>
              ${projectRows}
            </tbody>
          </table>

          ${(report.projectSummary ?? []).length > 10
            ? `
                <div style="
                  margin-top:8px;
                  font-size:11px;
                  line-height:17px;
                  color:#64748B;
                ">
                  Showing the top 10 projects. See the attached Excel report for complete details.
                </div>
              `
            : ""}

        </div>
      `
        : "";
    // ==================================================
    // EXCEL CALLOUT
    // ==================================================
    const excelCallout = `
    <div style="
      margin-top:30px;
      padding:18px;
      background:#F8FAFC;
      border:1px solid #E2E8F0;
      border-radius:12px;
    ">
      <table
        width="100%"
        cellpadding="0"
        cellspacing="0"
        border="0"
      >
        <tr>

          <td width="42" valign="top">
            <div style="
              width:34px;
              height:34px;
              line-height:34px;
              text-align:center;
              border-radius:9px;
              background:#EFF6FF;
              color:#2563EB;
              font-size:15px;
              font-weight:700;
            ">
              ↓
            </div>
          </td>

          <td style="padding-left:12px;">

            <div style="
              font-size:14px;
              line-height:20px;
              font-weight:700;
              color:#172033;
            ">
              Detailed report attached
            </div>

            <div style="
              margin-top:4px;
              font-size:12px;
              line-height:19px;
              color:#64748B;
            ">
              The Excel report contains detailed task, overdue,
              employee, project, and high-priority information.
            </div>

          </td>

        </tr>
      </table>
    </div>
  `;
    // ==================================================
    // HTML
    // ==================================================
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />
  <title>TaskBizz Daily Summary</title>
</head>

<body style="
  margin:0;
  padding:0;
  background:#F5F7FA;
  font-family:Arial, Helvetica, sans-serif;
  color:#172033;
">

<table
  width="100%"
  cellpadding="0"
  cellspacing="0"
  border="0"
  style="background:#F5F7FA;"
>
  <tr>
    <td align="center" style="padding:28px 12px;">

      <table
        width="640"
        cellpadding="0"
        cellspacing="0"
        border="0"
        style="
          width:100%;
          max-width:640px;
          background:#FFFFFF;
          border:1px solid #E2E8F0;
          border-radius:14px;
          overflow:hidden;
        "
      >

        <!-- HEADER -->

        <tr>
          <td
            align="center"
            style="
              padding:25px 24px 22px;
              background:#FFFFFF;
              border-bottom:1px solid #E2E8F0;
            "
          >

            <div style="
              font-size:21px;
              line-height:28px;
              font-weight:700;
              color:#172033;
            ">
              TaskBizz
            </div>

            <div style="
              margin-top:6px;
              font-size:15px;
              line-height:21px;
              font-weight:700;
              letter-spacing:.2px;
              color:#2563EB;
            ">
              DAILY TASK SUMMARY
            </div>

            <div style="
              margin-top:5px;
              font-size:12px;
              line-height:18px;
              color:#64748B;
            ">
              ${escapeHtml(reportDate)}
            </div>

          </td>
        </tr>

        <!-- CONTENT -->

        <tr>
          <td style="padding:28px;">

            <!-- GREETING -->

            <div style="
              font-size:16px;
              line-height:24px;
              font-weight:600;
              color:#172033;
            ">
              ${greeting}
            </div>

            <div style="
              margin-top:7px;
              font-size:13px;
              line-height:21px;
              color:#64748B;
            ">
              Here is your TaskBizz daily summary for
              <strong style="color:#172033;">
                ${escapeHtml(reportDate)}
              </strong>.
            </div>

            <!-- OVERVIEW -->

            <div style="margin-top:27px;">

              ${sectionTitle("Today's Overview", "A quick snapshot of today's task activity.")}

              <table
                width="100%"
                cellpadding="0"
                cellspacing="0"
                border="0"
                style="border-collapse:collapse;"
              >
                <tr>
                  ${statCard(total, "Total Tasks", "#2563EB", "#EFF6FF", "✓")}

                  ${statCard(completed, "Completed", "#16A34A", "#F0FDF4", "✓")}

                  ${statCard(inProgress, "In Progress", "#7C3AED", "#F5F3FF", "→")}
                </tr>

                <tr>
                  ${statCard(pending, "Pending", "#64748B", "#F8FAFC", "○")}

                  ${statCard(delayed, "Delayed", "#EA580C", "#FFF7ED", "!")}

                  ${statCard(overdue, "Overdue", "#DC2626", "#FEF2F2", "!")}
                </tr>
              </table>

            </div>

            <!-- ATTENTION -->

            ${attentionSection}

            <!-- STATUS BREAKDOWN -->

            ${statusSection}

            <!-- TEAM SUMMARY -->

            ${employeeSection}

            <!-- PROJECT SUMMARY -->

            ${projectSection}

            <!-- EXCEL CALLOUT -->

            ${excelCallout}

          </td>
        </tr>

        <!-- FOOTER -->

        <tr>
          <td
            align="center"
            style="
              padding:18px 24px;
              background:#F8FAFC;
              border-top:1px solid #E2E8F0;
            "
          >

            <div style="
              font-size:11px;
              line-height:17px;
              color:#64748B;
            ">
              Please do not reply to this email. This inbox is not monitored.
            </div>

            <div style="
              margin-top:5px;
              font-size:11px;
              line-height:17px;
              color:#64748B;
            ">
              Powered by
              <strong style="color:#172033;">TaskBizz</strong>
              - manage Business in smarter way
            </div>

          </td>
        </tr>

      </table>

    </td>
  </tr>
</table>

</body>
</html>
`;
}
