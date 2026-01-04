"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTaskReport = generateTaskReport;
// src/reports/generateTaskReport.ts
const buildTaskWhere_1 = require("./buildTaskWhere");
const countTasks_1 = require("./countTasks");
const generateTaskXlsx_1 = require("./generateTaskXlsx");
const generateTaskCsv_1 = require("./generateTaskCsv");
const report_constants_1 = require("./report.constants");
const container_1 = require("../di/container");
async function resolveOrgPrisma(req) {
    const maybe = req.orgPrisma;
    if (maybe)
        return maybe;
    const orgId = (req.user)?.orgId;
    if (!orgId)
        throw new Error("Org ID required");
    return await (0, container_1.getOrgPrisma)(orgId);
}
async function generateTaskReport(req, res) {
    const prisma = await resolveOrgPrisma(req);
    const user = req.user;
    const filters = req.body || {};
    const where = (0, buildTaskWhere_1.buildTaskWhere)(filters, user);
    const count = await (0, countTasks_1.countTasks)(prisma, where);
    if (count <= report_constants_1.XLSX_ROW_LIMIT) {
        return (0, generateTaskXlsx_1.generateTaskXlsx)(req, where, res);
    }
    return (0, generateTaskCsv_1.generateTaskCsv)(prisma, where, res);
}
