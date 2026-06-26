"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDocumentsTree = getDocumentsTree;
const container_1 = require("../di/container");
const spacesUtils_1 = require("../utils/spacesUtils");
async function resolveOrgPrisma(req) {
    const maybe = req.orgPrisma;
    if (maybe)
        return maybe;
    const orgId = req.user?.orgId;
    if (!orgId) {
        throw new Error("Org ID required");
    }
    return await (0, container_1.getOrgPrisma)(orgId);
}
async function getDocumentsTree(req, res) {
    try {
        const orgPrisma = await resolveOrgPrisma(req);
        // -----------------------------
        // FETCH CLIENTS & PROJECTS
        // -----------------------------
        const clients = await orgPrisma.client.findMany();
        const projects = await orgPrisma.project.findMany();
        const clientMap = new Map(clients.map((c) => [
            c.id,
            {
                id: c.id,
                name: c.name,
            },
        ]));
        const projectMap = new Map(projects.map((p) => [
            p.id,
            {
                id: p.id,
                name: p.name,
            },
        ]));
        // -----------------------------
        // TASK ATTACHMENTS
        // -----------------------------
        const taskAttachments = await orgPrisma.taskAttachment.findMany({
            include: {
                task: true,
            },
            orderBy: {
                createdAt: "desc",
            },
        });
        // -----------------------------
        // OCCURRENCE ATTACHMENTS
        // -----------------------------
        const occurrenceAttachments = await orgPrisma.taskOccurrenceAttachment.findMany({
            include: {
                occurrence: {
                    include: {
                        task: true,
                    },
                },
            },
            orderBy: {
                createdAt: "desc",
            },
        });
        const documents = [];
        // -----------------------------
        // FORMAT TASK ATTACHMENTS
        // -----------------------------
        for (const att of taskAttachments) {
            documents.push({
                id: att.id,
                name: att.key.split("/").pop() || "Unnamed Document",
                key: att.key,
                url: await (0, spacesUtils_1.getCachedFileUrlFromSpaces)(att.key, req.user.orgId),
                clientId: att.task?.clientId,
                clientName: clientMap.get(att.task?.clientId)?.name || "Unknown Client",
                projectId: att.task?.projectId,
                projectName: projectMap.get(att.task?.projectId)?.name || "Unknown Project",
                uploadedAt: att.createdAt,
            });
        }
        // -----------------------------
        // FORMAT OCCURRENCE ATTACHMENTS
        // -----------------------------
        for (const att of occurrenceAttachments) {
            documents.push({
                id: att.id,
                name: att.key.split("/").pop() || "Unnamed Document",
                key: att.key,
                url: await (0, spacesUtils_1.getCachedFileUrlFromSpaces)(att.key, req.user.orgId),
                clientId: att.occurrence?.task?.clientId,
                clientName: clientMap.get(att.occurrence?.task?.clientId)?.name ||
                    "Unknown Client",
                projectId: att.occurrence?.task?.projectId,
                projectName: projectMap.get(att.occurrence?.task?.projectId)?.name ||
                    "Unknown Project",
                uploadedAt: att.createdAt,
            });
        }
        // -----------------------------
        // GROUPING
        // -----------------------------
        const grouped = {};
        for (const doc of documents) {
            const clientId = doc.clientId || "unknown-client";
            const projectId = doc.projectId || "unknown-project";
            if (!grouped[clientId]) {
                grouped[clientId] = {
                    clientId,
                    clientName: doc.clientName,
                    projects: {},
                };
            }
            if (!grouped[clientId].projects[projectId]) {
                grouped[clientId].projects[projectId] = {
                    projectId,
                    projectName: doc.projectName,
                    documents: [],
                };
            }
            grouped[clientId].projects[projectId].documents.push(doc);
        }
        // -----------------------------
        // FINAL ARRAY FORMAT
        // -----------------------------
        const result = Object.values(grouped).map((client) => ({
            ...client,
            projects: Object.values(client.projects),
        }));
        return res.json(result);
    }
    catch (err) {
        console.error("getDocumentsTree error:", err);
        return res.status(500).json({
            message: "Failed to fetch documents",
        });
    }
}
