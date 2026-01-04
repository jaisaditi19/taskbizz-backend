"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.countTasks = countTasks;
// src/reports/countTasks.ts
async function countTasks(prisma, where) {
    return prisma.taskOccurrence.count({
        where,
    });
}
