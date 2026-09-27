// src/services/dailyTaskReportService.ts

import { DateTime } from "luxon";
import { getCorePrisma } from "../di/container";

const REPORT_TIMEZONE = "Asia/Kolkata";

export async function generateDailyTaskReport(
  orgPrisma: any,
  options?: {
    managerId?: string;
  },
) {
  const now = DateTime.now().setZone(REPORT_TIMEZONE);

  const startOfToday = now.startOf("day").toUTC().toJSDate();
  const endOfToday = now.endOf("day").toUTC().toJSDate();
  const startOfMonth = now.startOf("month").toUTC().toJSDate();

  console.log("Generating daily task report:", {
    date: now.toFormat("yyyy-MM-dd"),
    managerId: options?.managerId ?? "ADMIN",
  });

  // ==================================================
  // 1. BASE FILTER FOR TODAY'S TASKS
  // ==================================================

  const where: any = {
    startDate: {
      lte: endOfToday,
    },

    dueDate: {
      gte: startOfToday,
    },

    NOT: {
      status: "CANCELLED",
    },
  };

  // ==================================================
  // 2. MANAGER SCOPE
  // ==================================================

  if (options?.managerId) {
    where.task = {
      project: {
        head: options.managerId,
      },
    };
  }

  // ==================================================
  // 3. GET TODAY'S TASKS
  // ==================================================

  const tasks = await orgPrisma.taskOccurrence.findMany({
    where,

    orderBy: [
      {
        dueDate: "asc",
      },
      {
        id: "asc",
      },
    ],

    select: {
      id: true,
      title: true,
      status: true,
      priority: true,

      startDate: true,
      dueDate: true,

      remarks: true,

      projectId: true,
      clientId: true,

      assignedToId: true,

      // Occurrence-level assignees
      assignees: {
        select: {
          userId: true,
        },
      },

      task: {
        select: {
          id: true,
          title: true,

          projectId: true,
          clientId: true,

          // Task-level assignees
          assignees: {
            select: {
              userId: true,
            },
          },

          project: {
            select: {
              id: true,
              name: true,
              head: true,
            },
          },
        },
      },
    },
  });

  console.log(
    `Daily report found ${tasks.length} tasks`,
    options?.managerId
      ? `for manager ${options.managerId}`
      : "for organization",
  );

  // ==================================================
  // 4. STATUS BREAKDOWN
  // ==================================================

  const statusBreakdown: Record<string, number> = {};

  for (const task of tasks) {
    const status = String(task.status);

    statusBreakdown[status] = (statusBreakdown[status] ?? 0) + 1;
  }

  // ==================================================
  // 5. SUMMARY COUNTS
  // ==================================================

  const completedCount = statusBreakdown["COMPLETED"] ?? 0;

  const inProgressCount =
    (statusBreakdown["IN_PROGRESS"] ?? 0) +
    (statusBreakdown["IN_TESTING"] ?? 0);

  const pendingCount =
    (statusBreakdown["OPEN"] ?? 0) +
    (statusBreakdown["PLANNING"] ?? 0) +
    (statusBreakdown["ON_HOLD"] ?? 0);

  const delayedCount = statusBreakdown["DELAYED"] ?? 0;

  const onTrackCount = statusBreakdown["ON_TRACK"] ?? 0;

  const approvedCount = statusBreakdown["APPROVED"] ?? 0;

  // ==================================================
  // 6. GET ALL OUTSTANDING OVERDUE TASKS
  // ==================================================

  const overdueWhere: any = {
    dueDate: {
      gte: startOfMonth,
      lt: startOfToday,
    },

    NOT: {
      status: {
        in: ["COMPLETED", "CANCELLED", "ON_HOLD"],
      },
    },
  };

  // Manager should only see overdue tasks
  // from projects they manage.
  if (options?.managerId) {
    overdueWhere.task = {
      project: {
        head: options.managerId,
      },
    };
  }

  const overdueTasks = await orgPrisma.taskOccurrence.findMany({
    where: overdueWhere,

    orderBy: {
      dueDate: "asc",
    },

    select: {
      id: true,
      title: true,
      status: true,
      priority: true,

      startDate: true,
      dueDate: true,

      remarks: true,

      projectId: true,
      clientId: true,

      assignedToId: true,

      assignees: {
        select: {
          userId: true,
        },
      },

      task: {
        select: {
          id: true,
          title: true,

          projectId: true,
          clientId: true,

          assignees: {
            select: {
              userId: true,
            },
          },

          project: {
            select: {
              id: true,
              name: true,
              head: true,
            },
          },
        },
      },
    },
  });

  // ==================================================
  // 7. HIGH PRIORITY TASKS
  // ==================================================

  const highPriorityTasks = tasks.filter(
    (task: any) => String(task.priority).toUpperCase() === "HIGH",
  );

  // ==================================================
  // 8. TASKS REQUIRING ATTENTION
  // ==================================================

  const attentionTaskMap = new Map<string, any>();

  // Delayed today's tasks
  for (const task of tasks) {
    if (task.status === "DELAYED") {
      attentionTaskMap.set(task.id, task);
    }
  }

  // High priority today's tasks
  for (const task of highPriorityTasks) {
    attentionTaskMap.set(task.id, task);
  }

  // All overdue tasks
  for (const task of overdueTasks) {
    attentionTaskMap.set(task.id, task);
  }

  const attentionTasks = Array.from(attentionTaskMap.values());

  // ==================================================
  // 9. EMPLOYEE-WISE SUMMARY
  // ==================================================

  /**
   * A task can have assignees at:
   *
   * 1. occurrence level
   * 2. task level
   * 3. legacy assignedToId
   *
   * We combine all three and remove duplicates.
   */

  const employeeStats = new Map<
    string,
    {
      userId: string;
      total: number;
      completed: number;
      pending: number;
      inProgress: number;
      delayed: number;
      overdue: number;
    }
  >();

  const getTaskAssigneeIds = (task: any): string[] => {
    const ids = new Set<string>();

    // Legacy scalar assignment
    if (task.assignedToId) {
      ids.add(String(task.assignedToId));
    }

    // Occurrence-level assignment
    for (const assignee of task.assignees ?? []) {
      if (assignee.userId) {
        ids.add(String(assignee.userId));
      }
    }

    // Task-level assignment
    for (const assignee of task.task?.assignees ?? []) {
      if (assignee.userId) {
        ids.add(String(assignee.userId));
      }
    }

    return Array.from(ids);
  };

  const updateEmployeeStats = (task: any, isOverdue: boolean) => {
    const assigneeIds = getTaskAssigneeIds(task);

    for (const userId of assigneeIds) {
      if (!employeeStats.has(userId)) {
        employeeStats.set(userId, {
          userId,
          total: 0,
          completed: 0,
          pending: 0,
          inProgress: 0,
          delayed: 0,
          overdue: 0,
        });
      }

      const stats = employeeStats.get(userId)!;

      stats.total++;

      if (task.status === "COMPLETED") {
        stats.completed++;
      }

      if (
        task.status === "OPEN" ||
        task.status === "PLANNING" ||
        task.status === "ON_HOLD"
      ) {
        stats.pending++;
      }

      if (
        task.status === "IN_PROGRESS" ||
        task.status === "IN_TESTING" ||
        task.status === "ON_TRACK"
      ) {
        stats.inProgress++;
      }

      if (task.status === "DELAYED") {
        stats.delayed++;
      }

      if (isOverdue) {
        stats.overdue++;
      }
    }
  };

  // Today's tasks
  for (const task of tasks) {
    updateEmployeeStats(task, false);
  }

  // Overdue tasks
  for (const task of overdueTasks) {
    updateEmployeeStats(task, true);
  }

  // ==================================================
  // 10. GET USER DETAILS FROM CORE DB
  // ==================================================

  const corePrisma = getCorePrisma();

  const employeeIds = Array.from(employeeStats.keys());

  let users: any[] = [];

  if (employeeIds.length > 0) {
    users = await corePrisma.user.findMany({
      where: {
        id: {
          in: employeeIds,
        },
      },

      select: {
        id: true,
        name: true,
        email: true,
      },
    });
  }

    const userMap = new Map(users.map((user: any) => [String(user.id), user]));
    
    const getAssigneeNames = (task: any): string[] => {
      const ids = new Set<string>();

      if (task.assignedToId) {
        ids.add(String(task.assignedToId));
      }

      for (const assignee of task.assignees ?? []) {
        if (assignee.userId) {
          ids.add(String(assignee.userId));
        }
      }

      for (const assignee of task.task?.assignees ?? []) {
        if (assignee.userId) {
          ids.add(String(assignee.userId));
        }
      }

      return Array.from(ids).map((id) => {
        const user = userMap.get(id);

        return user?.name ?? "Unknown User";
      });
    };

    const tasksWithNames = tasks.map((task: any) => ({
      ...task,
      assigneeNames: getAssigneeNames(task),
    }));

    const overdueTasksWithNames = overdueTasks.map((task: any) => ({
      ...task,
      assigneeNames: getAssigneeNames(task),
    }));

    const highPriorityTasksWithNames = highPriorityTasks.map((task: any) => ({
      ...task,
      assigneeNames: getAssigneeNames(task),
    }));

  // ==================================================
  // 11. BUILD EMPLOYEE SUMMARY
  // ==================================================

  const employeeSummary = Array.from(employeeStats.values())
    .map((stats) => {
      const user = userMap.get(stats.userId);

      return {
        userId: stats.userId,

        name: user?.name ?? "Unknown User",

        email: user?.email ?? null,

        total: stats.total,

        completed: stats.completed,

        pending: stats.pending,

        inProgress: stats.inProgress,

        delayed: stats.delayed,

        overdue: stats.overdue,
      };
    })
    .sort((a, b) => b.total - a.total);

  // ==================================================
  // 12. PROJECT-WISE SUMMARY
  // ==================================================

  const projectStats = new Map<
    string,
    {
      projectId: string;
      projectName: string;
      total: number;
      completed: number;
      pending: number;
      inProgress: number;
      delayed: number;
      overdue: number;
      highPriority: number;
    }
  >();

  const updateProjectStats = (task: any, isOverdue: boolean) => {
    const project = task.task?.project;

    if (!project?.id) {
      return;
    }

    const projectId = String(project.id);

    if (!projectStats.has(projectId)) {
      projectStats.set(projectId, {
        projectId,
        projectName: project.name ?? "Unnamed Project",

        total: 0,
        completed: 0,
        pending: 0,
        inProgress: 0,
        delayed: 0,
        overdue: 0,
        highPriority: 0,
      });
    }

    const stats = projectStats.get(projectId)!;

    stats.total++;

    if (task.status === "COMPLETED") {
      stats.completed++;
    }

    if (
      task.status === "OPEN" ||
      task.status === "PLANNING" ||
      task.status === "ON_HOLD"
    ) {
      stats.pending++;
    }

    if (
      task.status === "IN_PROGRESS" ||
      task.status === "IN_TESTING" ||
      task.status === "ON_TRACK"
    ) {
      stats.inProgress++;
    }

    if (task.status === "DELAYED") {
      stats.delayed++;
    }

    if (isOverdue) {
      stats.overdue++;
    }

    if (String(task.priority).toUpperCase() === "HIGH") {
      stats.highPriority++;
    }
  };

  // Today's tasks
  for (const task of tasks) {
    updateProjectStats(task, false);
  }

  // Overdue tasks
  for (const task of overdueTasks) {
    updateProjectStats(task, true);
  }

    const projectSummary = Array.from(projectStats.values()).sort(
        (a, b) => b.total - a.total,
    );

  // ==================================================
  // 13. FINAL SUMMARY
  // ==================================================

  const summary = {
    total: tasks.length,

    completed: completedCount,

    inProgress: inProgressCount,

    pending: pendingCount,

    onTrack: onTrackCount,

    delayed: delayedCount,

    approved: approvedCount,

    overdue: overdueTasks.length,

    highPriority: highPriorityTasks.length,

    cancelled: 0,
  };

  // ==================================================
  // 14. RETURN REPORT
  // ==================================================

  return {
    date: now.toFormat("yyyy-MM-dd"),

    startOfToday,
    endOfToday,

    tasks: tasksWithNames,

    summary,

    statusBreakdown,

    attentionTasks,

    overdueTasks: overdueTasksWithNames,

    highPriorityTasks: highPriorityTasksWithNames,

    employeeSummary,

    projectSummary,
  };
}
