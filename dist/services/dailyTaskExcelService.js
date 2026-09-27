"use strict";
// src/services/dailyTaskExcelService.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDailyTaskExcel = generateDailyTaskExcel;
const exceljs_1 = __importDefault(require("exceljs"));
async function generateDailyTaskExcel(report) {
    const workbook = new exceljs_1.default.Workbook();
    workbook.creator = "TaskBizz";
    workbook.lastModifiedBy = "TaskBizz";
    workbook.created = new Date();
    workbook.modified = new Date();
    // ==================================================
    // COMMON STYLES
    // ==================================================
    const headerStyle = {
        font: {
            bold: true,
            color: {
                argb: "FFFFFF",
            },
        },
        fill: {
            type: "pattern",
            pattern: "solid",
            fgColor: {
                argb: "1F2937",
            },
        },
        alignment: {
            vertical: "middle",
            horizontal: "center",
        },
    };
    const titleStyle = {
        font: {
            bold: true,
            size: 16,
        },
    };
    // ==================================================
    // AUTO WIDTH
    // ==================================================
    const autoWidth = (worksheet) => {
        worksheet.columns.forEach((column) => {
            if (!column)
                return;
            let maxLength = 10;
            const columnNumber = column.number;
            if (!columnNumber)
                return;
            for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber++) {
                const cell = worksheet.getCell(rowNumber, columnNumber);
                const value = cell.value;
                if (value !== null && value !== undefined) {
                    maxLength = Math.max(maxLength, String(value).length);
                }
            }
            column.width = Math.min(maxLength + 2, 40);
        });
    };
    // ==================================================
    // DATE FORMAT
    // ==================================================
    const formatDateCell = (cell) => {
        if (cell.value instanceof Date) {
            cell.numFmt = "dd-mmm-yyyy hh:mm AM/PM";
        }
    };
    // ==================================================
    // ASSIGNEE NAMES
    // ==================================================
    const getAssigneeNames = (task) => {
        if (Array.isArray(task.assigneeNames) && task.assigneeNames.length > 0) {
            return task.assigneeNames.join(", ");
        }
        return "";
    };
    // ==================================================
    // 1. SUMMARY SHEET
    // ==================================================
    const summarySheet = workbook.addWorksheet("Summary");
    summarySheet.mergeCells("A1:B1");
    summarySheet.getCell("A1").value = "TaskBizz Daily Task Summary";
    summarySheet.getCell("A1").style = titleStyle;
    summarySheet.getCell("A2").value = "Report Date";
    summarySheet.getCell("B2").value = report.date;
    summarySheet.getRow(4).values = ["Metric", "Count"];
    summarySheet.getRow(4).eachCell((cell) => {
        cell.style = headerStyle;
    });
    const summaryRows = [
        ["Total Tasks", report.summary.total],
        ["Completed", report.summary.completed],
        ["In Progress", report.summary.inProgress],
        ["Pending", report.summary.pending],
        ["On Track", report.summary.onTrack],
        ["Delayed", report.summary.delayed],
        ["Approved", report.summary.approved],
        ["Overdue", report.summary.overdue],
        ["High Priority", report.summary.highPriority],
    ];
    summaryRows.forEach((row) => {
        summarySheet.addRow(row);
    });
    autoWidth(summarySheet);
    // ==================================================
    // 2. TODAY'S TASKS
    // ==================================================
    const todaySheet = workbook.addWorksheet("Today's Tasks");
    todaySheet.addRow([
        "Task ID",
        "Title",
        "Status",
        "Priority",
        "Start Date",
        "Due Date",
        "Project",
        "Project ID",
        "Assigned To",
        "Remarks",
    ]);
    todaySheet.getRow(1).eachCell((cell) => {
        cell.style = headerStyle;
    });
    for (const task of report.tasks) {
        const projectName = task.task?.project?.name ?? "No Project";
        const assignees = getAssigneeNames(task);
        todaySheet.addRow([
            task.id,
            task.title,
            task.status,
            task.priority ?? "",
            task.startDate ? new Date(task.startDate) : "",
            task.dueDate ? new Date(task.dueDate) : "",
            projectName,
            task.projectId ?? "",
            assignees,
            task.remarks ?? "",
        ]);
    }
    // Format dates
    todaySheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1)
            return;
        formatDateCell(row.getCell(5));
        formatDateCell(row.getCell(6));
    });
    autoWidth(todaySheet);
    // ==================================================
    // 3. OVERDUE TASKS
    // ==================================================
    const overdueSheet = workbook.addWorksheet("Overdue Tasks");
    overdueSheet.addRow([
        "Task ID",
        "Title",
        "Status",
        "Priority",
        "Due Date",
        "Project",
        "Project ID",
        "Assigned To",
        "Days Overdue",
        "Remarks",
    ]);
    overdueSheet.getRow(1).eachCell((cell) => {
        cell.style = headerStyle;
    });
    for (const task of report.overdueTasks) {
        const projectName = task.task?.project?.name ?? "No Project";
        const dueDate = task.dueDate ? new Date(task.dueDate) : null;
        const daysOverdue = dueDate
            ? Math.max(1, Math.floor((Date.now() - dueDate.getTime()) / (1000 * 60 * 60 * 24)))
            : "";
        const assignees = getAssigneeNames(task);
        overdueSheet.addRow([
            task.id,
            task.title,
            task.status,
            task.priority ?? "",
            dueDate ?? "",
            projectName,
            task.projectId ?? "",
            assignees,
            daysOverdue,
            task.remarks ?? "",
        ]);
    }
    // Format overdue date
    overdueSheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1)
            return;
        formatDateCell(row.getCell(5));
    });
    autoWidth(overdueSheet);
    // ==================================================
    // 4. EMPLOYEE SUMMARY
    // ==================================================
    const employeeSheet = workbook.addWorksheet("Employee Summary");
    employeeSheet.addRow([
        "Employee",
        "Email",
        "Total",
        "Completed",
        "In Progress",
        "Pending",
        "Delayed",
        "Overdue",
    ]);
    employeeSheet.getRow(1).eachCell((cell) => {
        cell.style = headerStyle;
    });
    for (const employee of report.employeeSummary) {
        employeeSheet.addRow([
            employee.name,
            employee.email ?? "",
            employee.total,
            employee.completed,
            employee.inProgress,
            employee.pending,
            employee.delayed,
            employee.overdue,
        ]);
    }
    autoWidth(employeeSheet);
    // ==================================================
    // 5. PROJECT SUMMARY
    // ==================================================
    const projectSheet = workbook.addWorksheet("Project Summary");
    projectSheet.addRow([
        "Project",
        "Total",
        "Completed",
        "In Progress",
        "Pending",
        "Delayed",
        "Overdue",
        "High Priority",
    ]);
    projectSheet.getRow(1).eachCell((cell) => {
        cell.style = headerStyle;
    });
    for (const project of report.projectSummary) {
        projectSheet.addRow([
            project.projectName,
            project.total,
            project.completed,
            project.inProgress,
            project.pending,
            project.delayed,
            project.overdue,
            project.highPriority,
        ]);
    }
    autoWidth(projectSheet);
    // ==================================================
    // 6. HIGH PRIORITY
    // ==================================================
    const highPrioritySheet = workbook.addWorksheet("High Priority");
    highPrioritySheet.addRow([
        "Task ID",
        "Title",
        "Status",
        "Priority",
        "Start Date",
        "Due Date",
        "Project",
        "Assigned To",
        "Remarks",
    ]);
    highPrioritySheet.getRow(1).eachCell((cell) => {
        cell.style = headerStyle;
    });
    for (const task of report.highPriorityTasks) {
        const projectName = task.task?.project?.name ?? "No Project";
        const assignees = getAssigneeNames(task);
        highPrioritySheet.addRow([
            task.id,
            task.title,
            task.status,
            task.priority ?? "",
            task.startDate ? new Date(task.startDate) : "",
            task.dueDate ? new Date(task.dueDate) : "",
            projectName,
            assignees,
            task.remarks ?? "",
        ]);
    }
    // Format dates
    highPrioritySheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1)
            return;
        formatDateCell(row.getCell(5));
        formatDateCell(row.getCell(6));
    });
    autoWidth(highPrioritySheet);
    // ==================================================
    // 7. FREEZE HEADER ROWS
    // ==================================================
    for (const sheet of workbook.worksheets) {
        sheet.views = [
            {
                state: "frozen",
                ySplit: 1,
            },
        ];
    }
    // ==================================================
    // 8. RETURN XLSX BUFFER
    // ==================================================
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
}
