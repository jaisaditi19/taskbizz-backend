"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteCalendarEntry = exports.updateCalendarEntry = exports.getCalendarEntry = exports.getCalendarEntries = exports.createCalendarEntry = void 0;
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
function parseISO(d) {
    if (!d)
        return null;
    const dt = new Date(String(d));
    return isNaN(dt.getTime()) ? null : dt;
}
const TYPES = new Set(["REMINDER", "APPOINTMENT"]);
const FREQS = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const createCalendarEntry = async (req, res) => {
    try {
        const orgPrisma = await resolveOrgPrisma(req);
        const user = req.user;
        const { type, title, description, start, end, allDay = true, freq, interval, until, count, } = req.body;
        if (!type || !title || !start) {
            return res.status(400).json({ error: "type, title, start are required" });
        }
        if (!TYPES.has(type)) {
            return res.status(400).json({ error: "Invalid type" });
        }
        const startDt = parseISO(start);
        const endDt = parseISO(end ?? null);
        const untilDt = parseISO(until ?? null);
        if (!startDt)
            return res.status(400).json({ error: "Invalid start datetime" });
        if (end !== undefined && end !== null && !endDt) {
            return res.status(400).json({ error: "Invalid end datetime" });
        }
        if (endDt && endDt < startDt) {
            return res.status(400).json({ error: "end must be ≥ start" });
        }
        if (freq != null && !FREQS.has(freq)) {
            return res.status(400).json({ error: "Invalid freq" });
        }
        if (freq == null && (interval != null || until != null || count != null)) {
            return res
                .status(400)
                .json({ error: "interval/until/count require freq" });
        }
        const entry = await orgPrisma.calendarEntry.create({
            data: {
                createdById: user.id,
                type,
                title,
                description: description ?? null,
                start: startDt,
                end: endDt ?? null,
                allDay: Boolean(allDay),
                freq: freq ?? null,
                interval: interval ?? null,
                until: untilDt ?? null,
                count: count ?? null,
            },
        });
        res.status(201).json(entry);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to create calendar entry" });
    }
};
exports.createCalendarEntry = createCalendarEntry;
const getCalendarEntries = async (req, res) => {
    try {
        const orgPrisma = await resolveOrgPrisma(req);
        const user = req.user;
        const startParam = parseISO(String(req.query.start ?? "") || null);
        const endParam = parseISO(String(req.query.end ?? "") || null);
        const where = {};
        if (startParam)
            where.start = { gte: startParam };
        if (endParam)
            where.start = { ...(where.start ?? {}), lt: endParam };
        // Only owner can see their entries unless ADMIN
        if (user.role !== "ADMIN") {
            where.createdById = user.id;
        }
        const entries = await orgPrisma.calendarEntry.findMany({
            where,
            orderBy: { start: "asc" },
        });
        res.json(entries);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch calendar entries" });
    }
};
exports.getCalendarEntries = getCalendarEntries;
const getCalendarEntry = async (req, res) => {
    try {
        const orgPrisma = await resolveOrgPrisma(req);
        const user = req.user;
        const { id } = req.params;
        const entry = await orgPrisma.calendarEntry.findUnique({ where: { id } });
        if (!entry)
            return res.status(404).json({ error: "Not found" });
        if (user.role !== "ADMIN" && entry.createdById !== user.id) {
            return res.status(403).json({ error: "Forbidden" });
        }
        res.json(entry);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch calendar entry" });
    }
};
exports.getCalendarEntry = getCalendarEntry;
const updateCalendarEntry = async (req, res) => {
    try {
        const orgPrisma = await resolveOrgPrisma(req);
        const user = req.user;
        const { id } = req.params;
        const existing = await orgPrisma.calendarEntry.findUnique({
            where: { id },
        });
        if (!existing)
            return res.status(404).json({ error: "Not found" });
        if (user.role !== "ADMIN" && existing.createdById !== user.id) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const { title, description, start, end, allDay, freq, interval, until, count, } = req.body;
        if (freq !== undefined && freq !== null && !FREQS.has(freq)) {
            return res.status(400).json({ error: "Invalid freq" });
        }
        if ((interval != null || until != null || count != null) &&
            !freq &&
            existing.freq == null) {
            // Only allow interval/until/count if freq present either in payload or existing
            return res
                .status(400)
                .json({ error: "interval/until/count require freq" });
        }
        const startDt = start === undefined ? undefined : parseISO(start);
        const endDt = end === undefined ? undefined : end === null ? null : parseISO(end);
        const untilDt = until === undefined ? undefined : until === null ? null : parseISO(until);
        if (startDt === null)
            return res.status(400).json({ error: "Invalid start" });
        if (endDt === null)
            return res.status(400).json({ error: "Invalid end" });
        if (untilDt === null)
            return res.status(400).json({ error: "Invalid until" });
        if (startDt && endDt instanceof Date && endDt < startDt) {
            return res.status(400).json({ error: "end must be ≥ start" });
        }
        const updated = await orgPrisma.calendarEntry.update({
            where: { id },
            data: {
                title: title ?? undefined,
                description: description === undefined ? undefined : description,
                start: startDt ?? undefined,
                end: endDt === undefined ? undefined : endDt,
                allDay: allDay ?? undefined,
                freq: freq === undefined ? undefined : freq ?? null,
                interval: interval === undefined ? undefined : interval ?? null,
                until: untilDt === undefined ? undefined : untilDt,
                count: count === undefined ? undefined : count ?? null,
            },
        });
        res.json(updated);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to update calendar entry" });
    }
};
exports.updateCalendarEntry = updateCalendarEntry;
const deleteCalendarEntry = async (req, res) => {
    try {
        const orgPrisma = await resolveOrgPrisma(req);
        const user = req.user;
        const { id } = req.params;
        const existing = await orgPrisma.calendarEntry.findUnique({
            where: { id },
        });
        if (!existing)
            return res.status(404).json({ error: "Not found" });
        if (user.role !== "ADMIN" && existing.createdById !== user.id) {
            return res.status(403).json({ error: "Forbidden" });
        }
        await orgPrisma.calendarEntry.delete({ where: { id } });
        res.json({ message: "Entry deleted" });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to delete calendar entry" });
    }
};
exports.deleteCalendarEntry = deleteCalendarEntry;
