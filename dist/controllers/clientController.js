"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bulkDeleteClients = exports.bulkUpdateClientCommunication = exports.bulkUpload = exports.deleteClient = exports.updateClient = exports.getClients = exports.createClient = void 0;
const container_1 = require("../di/container");
async function resolveOrgPrisma(req) {
    const maybe = req.orgPrisma;
    if (maybe)
        return maybe;
    const orgId = req.user?.orgId;
    if (!orgId)
        throw new Error("Org ID required");
    return await (0, container_1.getOrgPrisma)(orgId);
}
/**
 * Create client
 */
const createClient = async (req, res) => {
    try {
        const { name, mobile, email, gstNumber, panNumber, address, city, state, pincode, clientCommunication, } = req.body;
        const orgPrisma = await resolveOrgPrisma(req);
        const client = await orgPrisma.client.create({
            data: {
                name,
                mobile,
                email,
                gstNumber,
                panNumber,
                address: address ?? null,
                city: city ?? null,
                state: state ?? null,
                pincode: pincode ?? null,
                clientCommunication,
                status: "ACTIVE",
            },
        });
        res.status(201).json(client);
    }
    catch (error) {
        console.error("createClient error:", error);
        res.status(500).json({ error: "Failed to create client" });
    }
};
exports.createClient = createClient;
/**
 * GET /client
 * Query params:
 *  - page (1-based)
 *  - pageSize
 *  - q (search term)
 *  - status (optional)
 *
 * Returns: { data, total, page, pageSize }
 */
const getClients = async (req, res) => {
    try {
        const orgId = req.user?.orgId;
        if (!orgId)
            return res.status(400).json({ message: "Org ID required" });
        const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
        const pageSize = Math.min(200, Math.max(1, parseInt(String(req.query.pageSize ?? "25"), 10)));
        const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
        const status = typeof req.query.status === "string" && req.query.status.trim() !== ""
            ? req.query.status.trim()
            : undefined;
        const prisma = await resolveOrgPrisma(req);
        const where = {};
        if (q) {
            where.OR = [
                { name: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
                { gstNumber: { contains: q, mode: "insensitive" } },
                { panNumber: { contains: q, mode: "insensitive" } },
                { mobile: { contains: q } },
            ];
        }
        if (status) {
            where.status = status;
        }
        const total = await prisma.client.count({ where });
        const clients = await prisma.client.findMany({
            where,
            orderBy: { name: "asc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
        });
        res.json({
            data: clients,
            total,
            page,
            pageSize,
        });
    }
    catch (error) {
        console.error("getClients error:", error);
        res.status(500).json({ error: "Failed to fetch clients" });
    }
};
exports.getClients = getClients;
/**
 * Update client
 */
const updateClient = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, mobile, email, gstNumber, panNumber, address, city, state, pincode, clientCommunication, status, } = req.body;
        const orgPrisma = await resolveOrgPrisma(req);
        const updatedClient = await orgPrisma.client.update({
            where: { id },
            data: {
                name,
                mobile,
                email,
                gstNumber,
                panNumber,
                address: address ?? null,
                city: city ?? null,
                state: state ?? null,
                pincode: pincode ?? null,
                clientCommunication,
                status,
            },
        });
        res.json(updatedClient);
    }
    catch (error) {
        console.error("updateClient error:", error);
        res.status(500).json({ error: "Failed to update client" });
    }
};
exports.updateClient = updateClient;
/**
 * Soft delete client (mark INACTIVE)
 */
const deleteClient = async (req, res) => {
    try {
        const { id } = req.params;
        const orgPrisma = await resolveOrgPrisma(req);
        const deletedClient = await orgPrisma.client.delete({
            where: { id },
        });
        res.json({ message: "Client permanently deleted", client: deletedClient });
    }
    catch (error) {
        console.error("deleteClient error:", error);
        if (error.code === "P2025") {
            // Prisma "Record not found" error
            return res.status(404).json({ error: "Client not found" });
        }
        res.status(500).json({ error: "Failed to delete client" });
    }
};
exports.deleteClient = deleteClient;
/**
 * Bulk upload clients
 * Accepts body: { clients: [ ... ] }
 */
const bulkUpload = async (req, res) => {
    try {
        const { clients } = req.body;
        const orgPrisma = await resolveOrgPrisma(req);
        if (!Array.isArray(clients) || clients.length === 0) {
            return res.status(400).json({ message: "clients array is required" });
        }
        const mappedClients = clients.map((c) => ({
            name: c.name,
            mobile: c.mobile || null,
            email: c.email || null,
            gstNumber: c.gstNumber || null,
            panNumber: c.panNumber || null,
            address: c.address ?? null,
            city: c.city ?? null,
            state: c.state ?? null,
            pincode: c.pincode ?? null,
            clientCommunication: c.clientCommunication ?? null,
            status: c.status ?? "ACTIVE",
        }));
        await orgPrisma.client.createMany({
            data: mappedClients,
            skipDuplicates: true,
        });
        res.json({ message: "Clients imported successfully" });
    }
    catch (err) {
        console.error("bulkUpload error:", err);
        res.status(500).json({ message: "Error importing clients", error: err });
    }
};
exports.bulkUpload = bulkUpload;
/**
 * Bulk update clientCommunication
 * Body: { ids: string[], clientCommunication: boolean | null }
 */
const bulkUpdateClientCommunication = async (req, res) => {
    try {
        const { ids, clientCommunication } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: "ids[] is required" });
        }
        if (typeof clientCommunication !== "boolean" && clientCommunication !== null) {
            return res
                .status(400)
                .json({ message: "clientCommunication must be boolean or null" });
        }
        const orgPrisma = await resolveOrgPrisma(req);
        const result = await orgPrisma.client.updateMany({
            where: { id: { in: ids } },
            data: { clientCommunication },
        });
        return res.json({
            message: "clientCommunication updated",
            count: result.count,
        });
    }
    catch (error) {
        console.error("bulkUpdateClientCommunication error:", error);
        res.status(500).json({ error: "Failed to bulk update clientCommunication" });
    }
};
exports.bulkUpdateClientCommunication = bulkUpdateClientCommunication;
/**
 * Bulk delete clients
 * Body: { ids: string[], mode?: "hard" | "soft" }
 * - hard: permanent delete (default)
 * - soft: mark INACTIVE
 */
const bulkDeleteClients = async (req, res) => {
    try {
        const { ids, mode = "hard" } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: "ids[] is required" });
        }
        const orgPrisma = await resolveOrgPrisma(req);
        if (mode === "soft") {
            const result = await orgPrisma.client.updateMany({
                where: { id: { in: ids } },
                data: { status: "INACTIVE" },
            });
            return res.json({
                message: "Clients marked INACTIVE",
                count: result.count,
            });
        }
        // HARD delete: try per-id to avoid one failure rolling back all
        const settled = await Promise.allSettled(ids.map((id) => orgPrisma.client.delete({ where: { id } })));
        const succeeded = [];
        const failed = [];
        settled.forEach((r, i) => {
            const id = ids[i];
            if (r.status === "fulfilled") {
                succeeded.push(id);
            }
            else {
                const err = r.reason || {};
                failed.push({
                    id,
                    code: err?.code,
                    message: err?.message ||
                        "Failed to delete (possibly due to related records / FK constraints)",
                });
            }
        });
        return res.json({
            message: "Bulk delete attempted",
            deletedCount: succeeded.length,
            failedCount: failed.length,
            failed,
        });
    }
    catch (error) {
        console.error("bulkDeleteClients error:", error);
        res.status(500).json({ error: "Failed to bulk delete clients" });
    }
};
exports.bulkDeleteClients = bulkDeleteClients;
