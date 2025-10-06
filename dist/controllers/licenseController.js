"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bulkSetResponsible = exports.bulkImportLicenses = exports.bulkDeleteLicenses = exports.bulkRenewLicenses = exports.deleteLicense = exports.deleteAttachments = exports.deleteAttachment = exports.addAttachments = exports.renewLicense = exports.updateLicense = exports.createLicense = exports.getLicense = exports.listLicenses = void 0;
const container_1 = require("../di/container");
const licenseScheduler_1 = require("../services/licenseScheduler");
const spacesUtils_1 = require("../utils/spacesUtils");
/* ---------------- Permissions (simple) ---------------- */
function canRead(_req) {
    return true;
}
function canCreate(req) {
    return ["ADMIN", "MANAGER"].includes(req.user?.role);
}
function canUpdate(req) {
    return ["ADMIN", "MANAGER"].includes(req.user?.role);
}
/* ---------------- Org Prisma resolver ---------------- */
async function resolveOrgPrisma(req) {
    const maybe = req.orgPrisma;
    if (maybe)
        return maybe;
    const orgId = req.user?.orgId;
    if (!orgId)
        throw new Error("Org ID required");
    return await (0, container_1.getOrgPrisma)(orgId);
}
/* ---------------- Body picker (normalized) ---------------- */
function pickLicenseBody(body) {
    const out = {
        title: String(body.title || "").trim(),
        licenseNumber: body.licenseNumber === undefined || body.licenseNumber === null
            ? null
            : String(body.licenseNumber).trim(),
        clientId: body.clientId === undefined || body.clientId === null
            ? null
            : String(body.clientId).trim() || null,
        issuedOn: body.issuedOn ? new Date(body.issuedOn) : null,
        expiresOn: new Date(body.expiresOn),
        url: body.url === undefined || body.url === null
            ? null
            : String(body.url).trim() || null,
        remindOffsets: Array.isArray(body.remindOffsets)
            ? normalizeOffsets(body.remindOffsets)
            : undefined,
        responsibleId: body.responsibleId === undefined
            ? undefined
            : (body.responsibleId === null
                ? null
                : String(body.responsibleId).trim() || null),
    };
    if (!out.title)
        throw new Error("Title is required");
    if (!out.expiresOn || isNaN(out.expiresOn.getTime()))
        throw new Error("Valid expiresOn is required");
    if (out.issuedOn && isNaN(out.issuedOn.getTime()))
        out.issuedOn = null;
    return out;
}
/* ---------------- Reminders (re)builder ---------------- */
async function rebuildReminders(opts) {
    const { tx, licenseId, expiresOn, remindOffsets = [-7, -1], orgReminderHour = 9, orgReminderMinute = 0, } = opts;
    // Cancel any still-pending
    await tx.scheduledReminder.updateMany({
        where: { licenseId, status: "PENDING" },
        data: { status: "CANCELLED" },
    });
    // (Re)create
    const uniq = Array.from(new Set(remindOffsets)).sort((a, b) => a - b);
    for (const off of uniq) {
        if (!Number.isFinite(off))
            continue;
        const runAt = (0, licenseScheduler_1.buildReminderRunAt)(expiresOn, off, orgReminderHour, orgReminderMinute);
        await tx.scheduledReminder.upsert({
            where: { licenseId_offsetDays: { licenseId, offsetDays: off } },
            update: { runAt, status: "PENDING" },
            create: {
                licenseId,
                offsetDays: off,
                runAt,
                orgLocalDay: new Date(expiresOn),
                status: "PENDING",
            },
        });
    }
}
function normalizeOffsets(arr) {
    if (!Array.isArray(arr))
        return undefined;
    const uniq = Array.from(new Set(arr
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n))
        .map((n) => (n === 0 ? 0 : -Math.abs(n))) // API uses negatives; keep 0 if you support day-of
    )).sort((a, b) => a - b);
    return uniq;
}
// --- helpers ---
function isYYYYMMDD(v) {
    return !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function startOfLocalDayISO(d) {
    return new Date(`${d}T00:00:00`);
}
function endOfLocalDayISO(d) {
    return new Date(`${d}T23:59:59.999`);
}
/* ---------------- LIST: q, dueInDays, pagination ---------------- */
const listLicenses = async (req, res) => {
    try {
        if (!canRead(req))
            return res.status(403).json({ message: "Forbidden" });
        const corePrisma = (0, container_1.getCorePrisma)();
        const orgPrisma = await resolveOrgPrisma(req);
        const { q, dueInDays, page = "1", pageSize = "20", responsibleId, clientId, expiryStart, expiryEnd, } = req.query;
        const p = Math.max(1, parseInt(String(page), 10) || 1);
        const ps = Math.min(100, Math.max(1, parseInt(String(pageSize), 10) || 20));
        const where = {};
        // Text search
        if (q && q.trim()) {
            where.OR = [
                { title: { contains: q, mode: "insensitive" } },
                { licenseNumber: { contains: q, mode: "insensitive" } },
            ];
        }
        // Responsible / Client
        if (responsibleId && responsibleId !== "all")
            where.responsibleId = responsibleId;
        if (clientId && clientId !== "all")
            where.clientId = clientId;
        // ----- Expiry filters (inclusive) -----
        // Accept either explicit range (expiryStart/expiryEnd) or a rolling upper window (dueInDays).
        // If a range is provided, it takes precedence over dueInDays.
        let hasExplicitRange = false;
        let expiresOnWhere = undefined;
        if (isYYYYMMDD(expiryStart) || isYYYYMMDD(expiryEnd)) {
            hasExplicitRange = true;
            const startDate = isYYYYMMDD(expiryStart) ? startOfLocalDayISO(expiryStart) : undefined;
            const endDate = isYYYYMMDD(expiryEnd) ? endOfLocalDayISO(expiryEnd) : undefined;
            if (startDate || endDate) {
                expiresOnWhere = {};
                if (startDate && !isNaN(+startDate))
                    expiresOnWhere.gte = startDate;
                if (endDate && !isNaN(+endDate))
                    expiresOnWhere.lte = endDate;
            }
        }
        if (!hasExplicitRange && dueInDays) {
            const days = Math.max(0, parseInt(String(dueInDays), 10) || 0);
            const upper = new Date();
            upper.setDate(upper.getDate() + days);
            expiresOnWhere = { ...(expiresOnWhere ?? {}), lte: upper };
        }
        if (expiresOnWhere) {
            where.expiresOn = expiresOnWhere;
        }
        const [total, pageRows] = await orgPrisma.$transaction([
            orgPrisma.license.count({ where }),
            orgPrisma.license.findMany({
                where,
                orderBy: [{ expiresOn: "asc" }],
                skip: (p - 1) * ps,
                take: ps,
                select: {
                    id: true,
                    title: true,
                    licenseNumber: true,
                    clientId: true,
                    issuedOn: true,
                    expiresOn: true,
                    url: true,
                    remindOffsets: true,
                    attachments: { select: { id: true } },
                    responsibleId: true,
                },
            }),
        ]);
        // client name stitching
        const clientIds = Array.from(new Set(pageRows.map((r) => r.clientId).filter(Boolean)));
        let clientMap = new Map();
        if (clientIds.length) {
            const clients = await orgPrisma.client.findMany({
                where: { id: { in: clientIds } },
                select: { id: true, name: true },
            });
            clientMap = new Map(clients.map((c) => [c.id, c]));
        }
        // responsible stitching from core
        const responsibleIds = Array.from(new Set(pageRows.map((r) => r.responsibleId).filter(Boolean)));
        let responsibleMap = new Map();
        if (responsibleIds.length) {
            const users = await corePrisma.user.findMany({
                where: { id: { in: responsibleIds } },
                select: { id: true, name: true, email: true },
            });
            responsibleMap = new Map(users.map((u) => [u.id, u]));
        }
        const data = pageRows.map((r) => ({
            ...r,
            client: r.clientId ? clientMap.get(r.clientId) ?? null : null,
            attachmentsCount: r.attachments?.length ?? 0,
            responsible: r.responsibleId
                ? responsibleMap.get(r.responsibleId) ?? null
                : null,
        }));
        res.json({ data, total, page: p, pageSize: ps });
    }
    catch (err) {
        res.status(500).json({
            message: "Failed to list licenses",
            err: String(err?.message ?? err),
        });
    }
};
exports.listLicenses = listLicenses;
/* ---------------- GET: include attachments + stitched client + presigned URLs ---------------- */
const getLicense = async (req, res) => {
    try {
        if (!canRead(req))
            return res.status(403).json({ message: "Forbidden" });
        const corePrisma = (0, container_1.getCorePrisma)();
        const orgPrisma = await resolveOrgPrisma(req);
        const orgId = req.user?.orgId;
        const lic = await orgPrisma.license.findUnique({
            where: { id: req.params.id },
            select: {
                id: true,
                title: true,
                licenseNumber: true,
                clientId: true,
                issuedOn: true,
                expiresOn: true,
                url: true,
                remindOffsets: true,
                responsibleId: true,
                attachments: {
                    select: {
                        id: true,
                        fileName: true,
                        fileSize: true,
                        mimeType: true,
                        spacesKey: true,
                        uploadedAt: true,
                    },
                    orderBy: { uploadedAt: "desc" },
                },
            },
        });
        if (!lic)
            return res.status(404).json({ message: "Not found" });
        // stitch client name
        let client = null;
        if (lic.clientId) {
            client = await orgPrisma.client
                .findUnique({
                where: { id: lic.clientId },
                select: { id: true, name: true },
            })
                .catch(() => null);
        }
        // add presigned URL (cached) to each attachment
        const attachments = await Promise.all((lic.attachments ?? []).map(async (a) => ({
            ...a,
            url: a.spacesKey
                ? await (0, spacesUtils_1.getCachedFileUrlFromSpaces)(a.spacesKey, orgId, 3600)
                : null,
        })));
        let responsible = null;
        if (lic.responsibleId) {
            responsible = await corePrisma.user
                .findUnique({
                where: { id: lic.responsibleId },
                select: { id: true, name: true, email: true },
            })
                .catch(() => null);
        }
        res.json({ ...lic, client, attachments, responsible });
    }
    catch (err) {
        res.status(500).json({
            message: "Failed to get license",
            err: String(err?.message ?? err),
        });
    }
};
exports.getLicense = getLicense;
/* ---------------- CREATE: store license + build ScheduledReminder rows ---------------- */
const createLicense = async (req, res) => {
    try {
        if (!canCreate(req))
            return res.status(403).json({ message: "Forbidden" });
        const orgPrisma = await resolveOrgPrisma(req);
        const actorId = req.user?.id ?? "system";
        const body = pickLicenseBody(req.body);
        const license = await orgPrisma.$transaction(async (tx) => {
            const finalOffsets = body.remindOffsets ?? [-7, -1];
            const created = await tx.license.create({
                data: {
                    title: body.title,
                    licenseNumber: body.licenseNumber ?? null,
                    clientId: body.clientId ?? null,
                    issuedOn: body.issuedOn,
                    expiresOn: body.expiresOn,
                    url: body.url ?? null,
                    remindOffsets: finalOffsets,
                    responsibleId: body.responsibleId === undefined ? null : body.responsibleId,
                    createdById: actorId,
                },
            });
            await rebuildReminders({
                tx,
                licenseId: created.id,
                expiresOn: created.expiresOn,
                remindOffsets: finalOffsets,
            });
            return created;
        });
        res.status(201).json(license);
    }
    catch (err) {
        res.status(500).json({
            message: "Failed to create license",
            err: String(err?.message ?? err),
        });
    }
};
exports.createLicense = createLicense;
/* ---------------- UPDATE: update license + refresh ScheduledReminder rows ---------------- */
const updateLicense = async (req, res) => {
    try {
        if (!canUpdate(req))
            return res.status(403).json({ message: "Forbidden" });
        const orgPrisma = await resolveOrgPrisma(req);
        const id = req.params.id;
        const { title, licenseNumber, clientId, issuedOn, expiresOn, url, remindOffsets, responsibleId, } = req.body;
        const data = {};
        if (title !== undefined)
            data.title = String(title).trim();
        if (licenseNumber !== undefined)
            data.licenseNumber = licenseNumber?.trim() || null;
        if (clientId !== undefined)
            data.clientId = clientId ? String(clientId).trim() : null;
        if (issuedOn !== undefined)
            data.issuedOn = issuedOn ? new Date(issuedOn) : null;
        if (expiresOn !== undefined)
            data.expiresOn = new Date(expiresOn);
        if (url !== undefined)
            data.url = url?.trim() || null;
        if (remindOffsets !== undefined)
            data.remindOffsets = normalizeOffsets(remindOffsets);
        if (responsibleId !== undefined)
            data.responsibleId = responsibleId ? String(responsibleId).trim() : null;
        if (!Object.keys(data).length) {
            return res.json({ message: "No changes" });
        }
        const updated = await orgPrisma.$transaction(async (tx) => {
            const existing = await tx.license.findUnique({ where: { id } });
            if (!existing)
                throw new Error("License not found");
            // if reminders or expiry changed, rebuild
            const willTouchReminders = data.expiresOn !== undefined || data.remindOffsets !== undefined;
            const lic = await tx.license.update({ where: { id }, data });
            if (willTouchReminders) {
                await rebuildReminders({
                    tx,
                    licenseId: id,
                    expiresOn: lic.expiresOn,
                    remindOffsets: lic.remindOffsets ??
                        existing.remindOffsets ?? [-7, -1],
                });
            }
            return lic;
        });
        res.json(updated);
    }
    catch (err) {
        res
            .status(500)
            .json({
            message: "Failed to update license",
            err: String(err?.message ?? err),
        });
    }
};
exports.updateLicense = updateLicense;
/* ---------------- RENEW: update expiry/number/issued/url + reminders ----------------
   Body: {
     newExpiresOn: string (ISO)  // required
     newLicenseNumber?: string
     newIssuedOn?: string
     url?: string
     remindOffsets?: number[]
   }
----------------------------------------------------------------------- */
const renewLicense = async (req, res) => {
    try {
        if (!canUpdate(req))
            return res.status(403).json({ message: "Forbidden" });
        const orgPrisma = await resolveOrgPrisma(req);
        const id = req.params.id;
        const newExpiresOn = new Date(req.body?.newExpiresOn);
        if (!newExpiresOn || isNaN(newExpiresOn.getTime()))
            return res.status(400).json({ message: "newExpiresOn is required" });
        const newLicenseNumber = req.body?.newLicenseNumber == null
            ? undefined
            : String(req.body.newLicenseNumber).trim();
        const newIssuedOn = req.body?.newIssuedOn == null
            ? undefined
            : new Date(req.body.newIssuedOn);
        const url = req.body?.url == null ? undefined : String(req.body.url).trim() || null;
        const remindOffsets = Array.isArray(req.body?.remindOffsets)
            ? req.body.remindOffsets
                .map((n) => Number(n))
                .filter((n) => Number.isFinite(n))
            : undefined;
        const updated = await orgPrisma.$transaction(async (tx) => {
            const existing = await tx.license.findUnique({ where: { id } });
            if (!existing)
                throw new Error("License not found");
            const finalOffsets = normalizeOffsets(remindOffsets) ?? existing.remindOffsets ?? [-7, -1];
            const lic = await tx.license.update({
                where: { id },
                data: {
                    expiresOn: newExpiresOn,
                    ...(newLicenseNumber !== undefined
                        ? { licenseNumber: newLicenseNumber || null }
                        : {}),
                    ...(newIssuedOn !== undefined
                        ? { issuedOn: isNaN(newIssuedOn.getTime()) ? null : newIssuedOn }
                        : {}),
                    ...(url !== undefined ? { url } : {}),
                    remindOffsets: finalOffsets
                },
            });
            await rebuildReminders({
                tx,
                licenseId: id,
                expiresOn: lic.expiresOn,
                remindOffsets: finalOffsets
            });
            return lic;
        });
        res.json(updated);
    }
    catch (err) {
        res.status(500).json({
            message: "Failed to renew license",
            err: String(err?.message ?? err),
        });
    }
};
exports.renewLicense = renewLicense;
/* ---------------- ATTACHMENTS: upload & delete (Spaces) ----------------
   Router must use:
     - multer.memoryStorage()
     - upload.single("file")
---------------------------------------------------------------- */
// src/controllers/licenseController.ts
const addAttachments = async (req, res) => {
    try {
        // if (!canUpdate(req)) return res.status(403).json({ message: "Forbidden" });
        const orgPrisma = await resolveOrgPrisma(req);
        const orgId = req.user?.orgId;
        const licenseId = req.params.id;
        const inputFiles = req.files ??
            (req.file ? [req.file] : []);
        if (!inputFiles?.length) {
            return res.status(400).json({ message: "file(s) are required" });
        }
        const lic = await orgPrisma.license.findUnique({
            where: { id: licenseId },
            select: { id: true },
        });
        if (!lic)
            return res.status(404).json({ message: "License not found" });
        const created = await orgPrisma.$transaction(async (tx) => {
            const rows = [];
            for (const file of inputFiles) {
                // ✅ upload directly under licenses/{orgId}/...
                const key = await (0, spacesUtils_1.uploadLicenseToSpaces)(file, orgId);
                const att = await tx.licenseAttachment.create({
                    data: {
                        licenseId,
                        fileName: file.originalname,
                        fileSize: file.size,
                        mimeType: file.mimetype,
                        spacesKey: key, // ✅ store the exact key
                        cachedUrl: null,
                    },
                });
                rows.push(att);
            }
            return rows;
        });
        const withUrls = await Promise.all(created.map(async (a) => ({
            ...a,
            url: a.spacesKey
                ? await (0, spacesUtils_1.getCachedFileUrlFromSpaces)(a.spacesKey, orgId, 3600)
                : null,
        })));
        res.status(201).json({ attachments: withUrls });
    }
    catch (err) {
        res.status(500).json({
            message: "Failed to upload attachments",
            err: String(err?.message ?? err),
        });
    }
};
exports.addAttachments = addAttachments;
const deleteAttachment = async (req, res) => {
    try {
        if (!canUpdate(req))
            return res.status(403).json({ message: "Forbidden" });
        const orgPrisma = await resolveOrgPrisma(req);
        const { id: licenseId, attId } = req.params;
        const att = await orgPrisma.licenseAttachment.findUnique({
            where: { id: attId },
            select: { id: true, licenseId: true, spacesKey: true },
        });
        if (!att || att.licenseId !== licenseId)
            return res.status(404).json({ message: "Attachment not found" });
        await orgPrisma.$transaction(async (tx) => {
            await tx.licenseAttachment.delete({ where: { id: attId } });
        });
        // Best-effort storage delete
        try {
            if (att.spacesKey)
                await (0, spacesUtils_1.deleteFileFromSpaces)(att.spacesKey);
        }
        catch { }
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({
            message: "Failed to delete attachment",
            err: String(err?.message ?? err),
        });
    }
};
exports.deleteAttachment = deleteAttachment;
const deleteAttachments = async (req, res) => {
    try {
        if (!canUpdate(req))
            return res.status(403).json({ message: "Forbidden" });
        const orgPrisma = await resolveOrgPrisma(req);
        const { id: licenseId } = req.params;
        const { ids } = (req.body ?? {});
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: "ids[] required" });
        }
        // fetch to validate ownership + grab keys
        const atts = await orgPrisma.licenseAttachment.findMany({
            where: { id: { in: ids } },
            select: { id: true, licenseId: true, spacesKey: true },
        });
        const wrong = atts.find((a) => a.licenseId !== licenseId);
        if (wrong)
            return res.status(404).json({ message: "Attachment not found" });
        await orgPrisma.$transaction(async (tx) => {
            await tx.licenseAttachment.deleteMany({ where: { id: { in: ids } } });
        });
        // best-effort delete in Spaces
        await Promise.allSettled(atts.map(async (a) => a.spacesKey && (0, spacesUtils_1.deleteFileFromSpaces)(a.spacesKey)));
        res.json({ ok: true, deleted: atts.map((a) => a.id) });
    }
    catch (err) {
        res.status(500).json({
            message: "Failed to delete attachments",
            err: String(err?.message ?? err),
        });
    }
};
exports.deleteAttachments = deleteAttachments;
const deleteLicense = async (req, res) => {
    try {
        const { id } = req.params;
        if (!["ADMIN", "MANAGER"].includes(req.user?.role)) {
            return res.status(403).json({ message: "Forbidden" });
        }
        const orgPrisma = await (0, container_1.getOrgPrisma)(req.user.orgId);
        // First fetch attachments so we can delete from Spaces
        const attachments = await orgPrisma.licenseAttachment.findMany({
            where: { licenseId: id },
            select: { spacesKey: true },
        });
        // Delete license (cascade handles reminders, histories, assignees)
        await orgPrisma.license.delete({
            where: { id },
        });
        // Delete files from Spaces (fire & forget, but await to be safe)
        if (attachments.length) {
            await Promise.all(attachments.map((att) => (0, spacesUtils_1.deleteFileFromSpaces)(att.spacesKey)));
        }
        res.json({ message: "License deleted successfully" });
    }
    catch (err) {
        console.error("Delete license error:", err);
        res.status(500).json({
            message: "Failed to delete license",
            err: String(err?.message ?? err),
        });
    }
};
exports.deleteLicense = deleteLicense;
// --- helper: simple chunker ---
function chunk(arr, size = 50) {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}
/* ---------------- BULK RENEW ----------------
   POST /licenses/bulk/renew
   Body:
     {
       ids: string[],                 // required
       newExpiresOn: string,          // ISO, required
       newLicenseNumber?: string|null,
       newIssuedOn?: string|null,     // ISO
       url?: string|null,
       remindOffsets?: number[]       // optional (negative days)
     }
------------------------------------------------ */
const bulkRenewLicenses = async (req, res) => {
    try {
        const orgPrisma = await (0, container_1.getOrgPrisma)(req.user.orgId);
        const { ids, newExpiresOn, // ISO | undefined | null (null means clear if allowed)
        newIssuedOn, // ISO | undefined | null
        newLicenseNumber, // string | undefined | null
        remindOffsets, // number[] | undefined
         } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: "ids[] required" });
        }
        // Build the 'data' payload by including only provided keys.
        const data = {};
        if (newExpiresOn !== undefined)
            data.expiresOn = newExpiresOn ? new Date(newExpiresOn) : null;
        if (newIssuedOn !== undefined)
            data.validFrom = newIssuedOn ? new Date(newIssuedOn) : null;
        if (newLicenseNumber !== undefined)
            data.licenseNumber = newLicenseNumber; // allow null to clear if schema permits
        if (Array.isArray(remindOffsets))
            data.remindOffsets = remindOffsets; // omit entirely if undefined
        // Nothing to update? bail
        if (Object.keys(data).length === 0) {
            return res.json({ updated: 0 });
        }
        const result = await orgPrisma.license.updateMany({
            where: { id: { in: ids } },
            data,
        });
        return res.json({ updated: result.count });
    }
    catch (err) {
        console.error("bulkRenewLicenses failed", err);
        return res
            .status(500)
            .json({
            message: "Failed to bulk renew",
            err: err?.message ?? String(err),
        });
    }
};
exports.bulkRenewLicenses = bulkRenewLicenses;
/* ---------------- BULK DELETE ----------------
   POST /licenses/bulk/delete
   Body: { ids: string[] }   // required
   Notes:
   - Deletes license rows.
   - Best-effort deletes Spaces files.
------------------------------------------------ */
const bulkDeleteLicenses = async (req, res) => {
    try {
        if (!canUpdate(req))
            return res.status(403).json({ message: "Forbidden" });
        const orgPrisma = await resolveOrgPrisma(req);
        const { ids } = (req.body ?? {});
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: "ids[] required" });
        }
        // Collect attachments first (for Spaces cleanup)
        const allAttachments = await orgPrisma.licenseAttachment.findMany({
            where: { licenseId: { in: ids } },
            select: { spacesKey: true },
        });
        // DB deletes in chunks to avoid parameter limits
        for (const idsChunk of chunk(ids, 100)) {
            // If you have FK cascade on licenseAttachment/scheduledReminder, a single deleteMany is enough.
            // Being defensive here: clean child rows first.
            await orgPrisma.$transaction(async (tx) => {
                await tx.scheduledReminder.deleteMany({
                    where: { licenseId: { in: idsChunk } },
                });
                await tx.licenseAttachment.deleteMany({
                    where: { licenseId: { in: idsChunk } },
                });
                await tx.license.deleteMany({
                    where: { id: { in: idsChunk } },
                });
            });
        }
        // Best-effort delete actual files from Spaces (parallel, not transactional)
        await Promise.allSettled(allAttachments
            .map((a) => a.spacesKey)
            .filter(Boolean)
            .map((key) => (0, spacesUtils_1.deleteFileFromSpaces)(key)));
        res.json({ ok: true, deleted: ids });
    }
    catch (err) {
        res.status(500).json({
            message: "Bulk delete failed",
            err: String(err?.message ?? err),
        });
    }
};
exports.bulkDeleteLicenses = bulkDeleteLicenses;
// ---------------- BULK IMPORT ----------------
// POST /licenses/bulk/import
// Body: { items: Array<{
//   title: string
//   licenseNumber?: string|null
//   clientId?: string|null
//   issuedOn?: string|null  // ISO (YYYY-MM-DD ok)
//   expiresOn: string       // ISO (YYYY-MM-DD ok) (required)
//   url?: string|null
//   remindOffsets?: number[] // negative days; if positive provided, we normalize
// }> }
const bulkImportLicenses = async (req, res) => {
    try {
        if (!canCreate(req))
            return res.status(403).json({ message: "Forbidden" });
        const orgPrisma = await resolveOrgPrisma(req);
        const rawItems = Array.isArray(req.body?.items) ? req.body.items : null;
        if (!rawItems || rawItems.length === 0) {
            return res.status(400).json({ message: "items[] required" });
        }
        // normalize to internal creator body using your existing picker + normalizer
        const normalizeRow = (row) => {
            // allow positive-day input; normalize to negatives (and whitelist)
            const offs = Array.isArray(row.remindOffsets) ? row.remindOffsets : undefined;
            const normalizedOffsets = Array.isArray(offs)
                ? normalizeOffsets(offs) // uses toApiOffsets/fromApiOffsets internally
                : undefined;
            // reuse your existing single-row validator/normalizer
            const body = pickLicenseBody({
                title: row.title,
                licenseNumber: row.licenseNumber ?? null,
                clientId: row.clientId ?? null,
                issuedOn: row.issuedOn ?? null,
                expiresOn: row.expiresOn,
                url: row.url ?? null,
                remindOffsets: normalizedOffsets,
                responsibleId: row.responsibleId === undefined
                    ? undefined
                    : (row.responsibleId === null
                        ? null
                        : String(row.responsibleId).trim() || null),
            });
            return body;
        };
        const results = [];
        // chunk to keep transactions & parameter counts reasonable
        const chunk = (arr, n = 50) => {
            const out = [];
            for (let i = 0; i < arr.length; i += n)
                out.push(arr.slice(i, i + n));
            return out;
        };
        let createdTotal = 0;
        for (const part of chunk(rawItems, 50)) {
            await orgPrisma.$transaction(async (tx) => {
                for (let i = 0; i < part.length; i++) {
                    const idx = rawItems.indexOf(part[i]); // original index for reporting
                    try {
                        const body = normalizeRow(part[i]);
                        const created = await tx.license.create({
                            data: {
                                title: body.title,
                                licenseNumber: body.licenseNumber ?? null,
                                clientId: body.clientId ?? null,
                                issuedOn: body.issuedOn,
                                expiresOn: body.expiresOn,
                                url: body.url ?? null,
                                remindOffsets: body.remindOffsets ?? [-7, -1],
                                responsibleId: body.responsibleId === undefined ? null : body.responsibleId,
                                createdById: req.user?.id ?? "system",
                            },
                            select: { id: true, expiresOn: true, remindOffsets: true },
                        });
                        await rebuildReminders({
                            tx,
                            licenseId: created.id,
                            expiresOn: created.expiresOn,
                            remindOffsets: created.remindOffsets ?? [-7, -1],
                        });
                        results.push({ index: idx, ok: true, id: created.id });
                        createdTotal++;
                    }
                    catch (e) {
                        results.push({
                            index: idx,
                            ok: false,
                            error: String(e?.message ?? e),
                        });
                    }
                }
            });
        }
        const failed = results.filter((r) => !r.ok);
        return res.json({
            ok: failed.length === 0,
            created: createdTotal,
            failed,
        });
    }
    catch (err) {
        return res
            .status(500)
            .json({ message: "Bulk import failed", err: String(err?.message ?? err) });
    }
};
exports.bulkImportLicenses = bulkImportLicenses;
/* ---------------- BULK SET RESPONSIBLE ----------------
   POST /licenses/bulk/responsible
   Body: {
     ids: string[],             // required
     responsibleId: string|null // required: string to set, null to clear
   }
-------------------------------------------------------- */
const bulkSetResponsible = async (req, res) => {
    try {
        if (!canUpdate(req))
            return res.status(403).json({ message: "Forbidden" });
        const orgPrisma = await resolveOrgPrisma(req);
        const { ids, responsibleId } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ message: "ids[] required" });
        }
        if (responsibleId === undefined) {
            return res.status(400).json({ message: "responsibleId required (string|null)" });
        }
        const data = { responsibleId: responsibleId ?? null };
        const result = await orgPrisma.license.updateMany({
            where: { id: { in: ids } },
            data,
        });
        return res.json({ updated: result.count });
    }
    catch (err) {
        return res
            .status(500)
            .json({ message: "Failed to bulk set responsible", err: String(err?.message ?? err) });
    }
};
exports.bulkSetResponsible = bulkSetResponsible;
