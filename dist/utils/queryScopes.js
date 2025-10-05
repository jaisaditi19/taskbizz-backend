"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scopeOccurrenceWhereForUser = scopeOccurrenceWhereForUser;
exports.scopeTaskWhereForUser = scopeTaskWhereForUser;
// src/utils/queryScopes.ts
const access_1 = require("./access");
/** Build a Prisma where for TaskOccurrence based on user role */
function scopeOccurrenceWhereForUser(user, extraWhere = {}) {
    if ((0, access_1.isAdmin)(user))
        return extraWhere;
    if ((0, access_1.isManager)(user)) {
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
function scopeTaskWhereForUser(user, extraWhere = {}) {
    if ((0, access_1.isAdmin)(user))
        return extraWhere;
    if ((0, access_1.isManager)(user)) {
        return {
            ...extraWhere,
            project: { headId: user.id },
        };
    }
    return extraWhere; // or your EMPLOYEE view rule if you list tasks
}
