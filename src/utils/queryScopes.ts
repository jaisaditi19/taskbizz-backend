// src/utils/queryScopes.ts
import { isAdmin, isManager } from "./access";

/** Build a Prisma where for TaskOccurrence based on user role */
export function scopeOccurrenceWhereForUser(user: any, extraWhere: any = {}) {
  if (isAdmin(user)) return extraWhere;
  if (isManager(user)) {
    return {
      ...extraWhere,
      task: { project: { head: user.id } },
    };
  }
  // EMPLOYEE fallback (example – keep your current behavior)
  return {
    ...extraWhere,
    // assignees: { some: { userId: user.id } }
  };
}

/** Build a Prisma where for Task (master tasks) based on user role */
export function scopeTaskWhereForUser(user: any, extraWhere: any = {}) {
  if (isAdmin(user)) return extraWhere;
  if (isManager(user)) {
    return {
      ...extraWhere,
      project: { headId: user.id },
    };
  }
  return extraWhere; // or your EMPLOYEE view rule if you list tasks
}
