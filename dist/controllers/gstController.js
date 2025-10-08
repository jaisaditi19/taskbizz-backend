"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLatestBatch = exports.getGstReturnStatus = exports.fetchReturnStatus = exports.getGstinDetails = void 0;
const gstin_1 = require("../utils/gstin");
const container_1 = require("../di/container");
const gstinService_1 = require("../services/gstinService");
async function resolveOrgPrisma(req) {
    const maybe = req.orgPrisma;
    if (maybe)
        return maybe;
    const orgId = req.user?.orgId;
    if (!orgId)
        throw new Error("Org ID required");
    return await (0, container_1.getOrgPrisma)(orgId);
}
const getGstinDetails = async (req, res) => {
    try {
        const gstinRaw = String(req.params.gstin || "")
            .toUpperCase()
            .trim();
        if (!(0, gstin_1.isValidGSTIN)(gstinRaw)) {
            return res.status(400).json({ message: "Invalid GSTIN format" });
        }
        if (!process.env.RAPIDAPI_KEY) {
            return res.status(500).json({ message: "GST lookup key not configured" });
        }
        const data = await (0, gstinService_1.fetchGstinDetailsViaJamku)(gstinRaw);
        const payload = {
            gstin: data.gstin,
            legalName: data.legalName ?? data.tradeName ?? null,
            tradeName: data.tradeName ?? null,
            pan: data.pan ?? (0, gstin_1.panFromGSTIN)(gstinRaw),
            status: data.status ?? null,
            registrationDate: data.registrationDate ?? null,
            address: data.address ?? null,
            pincode: data.pincode ?? null,
            stateName: data.stateName ?? null,
            stateCode: data.stateCode ?? null,
            city: data.city ?? null,
            source: data.source,
        };
        return res.json(payload);
    }
    catch (err) {
        console.error("getGstinDetails error:", err?.response?.data || err);
        return res.status(502).json({ message: "Failed to fetch GSTIN details" });
    }
};
exports.getGstinDetails = getGstinDetails;
const fetchReturnStatus = async (req, res) => {
    try {
        const { gstin, form, period, forms, periods } = req.body ?? {};
        if (!gstin || !(0, gstin_1.isValidGSTIN)(String(gstin))) {
            return res.status(400).json({ message: "Valid gstin required" });
        }
        const prisma = await resolveOrgPrisma(req);
        if (!prisma)
            return res.status(500).json({ message: "Org DB not resolved" });
        // targets to upsert
        const targets = [];
        if (form && period) {
            targets.push({ form, period });
        }
        else if (Array.isArray(forms) &&
            Array.isArray(periods) &&
            periods.length) {
            for (const p of periods)
                for (const f of forms)
                    targets.push({ form: f, period: p });
        }
        else {
            return res
                .status(400)
                .json({ message: "Provide form+period or forms[]+periods[]" });
        }
        // aggregate → FILED rows
        const raw = await (0, gstinService_1.fetchGstinAggregateRawViaJamku)(String(gstin).toUpperCase());
        const normalized = (0, gstinService_1.rowsFromAggregateReturnList)(gstin, raw);
        const filedIndex = new Map();
        for (const r of normalized) {
            filedIndex.set(`${r.period}|${r.form}`, {
                filingDate: r.filingDate ?? null,
            });
        }
        const results = [];
        for (const t of targets) {
            const { status, filingDate } = (0, gstinService_1.deriveStatusFor)(t.period, t.form, filedIndex);
            await prisma.gstReturnStatus.upsert({
                where: { gstin_period_form: { gstin, period: t.period, form: t.form } },
                create: {
                    gstin,
                    period: t.period,
                    form: t.form,
                    status, // FILED | DUE | OVERDUE | NOT_DUE_YET
                    filingDate,
                    provider: "jamku-rapidapi",
                    raw: filedIndex.get(`${t.period}|${t.form}`) ?? { derived: true },
                },
                update: {
                    status,
                    filingDate,
                    provider: "jamku-rapidapi",
                    raw: filedIndex.get(`${t.period}|${t.form}`) ?? { derived: true },
                    fetchedAt: new Date(),
                },
            });
            results.push({ ...t, ok: true, via: "aggregate", status });
        }
        return res.json({ ok: true, results });
    }
    catch (e) {
        console.error("fetchReturnStatus error", e?.response?.data || e);
        return res.status(500).json({ message: e?.message ?? "fetch failed" });
    }
};
exports.fetchReturnStatus = fetchReturnStatus;
/**
 * GET /integrations/gst/returns/:gstin?from=YYYY-MM&to=YYYY-MM
 * Returns cached rows; also fills gaps using derived status.
 */
const getGstReturnStatus = async (req, res) => {
    try {
        const gstin = String(req.params.gstin || "")
            .toUpperCase()
            .trim();
        if (!(0, gstin_1.isValidGSTIN)(gstin)) {
            return res.status(400).json({ message: "Invalid GSTIN format" });
        }
        const prisma = await resolveOrgPrisma(req);
        const { from, to } = req.query;
        const where = { gstin };
        if (from && to)
            where.period = { gte: from, lte: to };
        const rows = await prisma.gstReturnStatus.findMany({
            where,
            orderBy: [{ period: "asc" }, { form: "asc" }],
            select: {
                id: true,
                gstin: true,
                period: true,
                form: true,
                status: true,
                filingDate: true,
                provider: true,
                raw: true,
            },
        });
        // Build month range if asked
        const months = [];
        if (from && to) {
            let [y, m] = from.split("-").map(Number);
            const [ty, tm] = to.split("-").map(Number);
            while (y < ty || (y === ty && m <= tm)) {
                months.push(`${y}-${String(m).padStart(2, "0")}`);
                m++;
                if (m > 12) {
                    m = 1;
                    y++;
                }
            }
        }
        // Index existing rows & index FILED for derivation
        const byKey = new Map(rows.map((r) => [`${r.period}|${r.form}`, r]));
        const filedIndex = new Map();
        for (const r of rows) {
            if (r.status === "FILED") {
                filedIndex.set(`${r.period}|${r.form}`, {
                    filingDate: r.filingDate ?? null,
                });
            }
        }
        // Synthesize gaps with derived status
        const formsWanted = ["GSTR1", "GSTR3B"];
        const synthesized = [];
        if (months.length) {
            for (const p of months) {
                for (const f of formsWanted) {
                    const k = `${p}|${f}`;
                    if (!byKey.has(k)) {
                        const { status, filingDate } = (0, gstinService_1.deriveStatusFor)(p, f, filedIndex);
                        synthesized.push({
                            id: undefined,
                            gstin,
                            period: p,
                            form: f,
                            status, // DUE | OVERDUE | NOT_DUE_YET (since not filed)
                            filingDate,
                            provider: "synthetic",
                            raw: null,
                        });
                    }
                }
            }
        }
        const items = [...rows, ...synthesized].sort((a, b) => a.period < b.period
            ? 1
            : a.period > b.period
                ? -1
                : a.form.localeCompare(b.form));
        console.log({ gstin, items });
        return res.json({ gstin, items });
    }
    catch (e) {
        return res
            .status(500)
            .json({ message: e?.message ?? "Failed to read statuses" });
    }
};
exports.getGstReturnStatus = getGstReturnStatus;
// POST /integrations/gst/returns/latest:batch
// body: { gstins: string[] }
const getLatestBatch = async (req, res) => {
    try {
        const raw = (req.body?.gstins ?? []);
        const gstins = raw
            .map((g) => String(g || "").toUpperCase().trim())
            .filter(gstin_1.isValidGSTIN);
        if (!gstins.length) {
            return res.status(400).json({ message: "Provide gstins[]" });
        }
        const prisma = await resolveOrgPrisma(req);
        const rows = await prisma.gstReturnStatus.findMany({
            where: {
                gstin: { in: gstins },
                status: { in: ["FILED", "NIL"] },
            },
            select: { gstin: true, period: true, form: true },
        });
        // Reduce to latest per (gstin, form)
        const latestMap = new Map();
        for (const g of gstins)
            latestMap.set(g, {});
        for (const r of rows) {
            const entry = latestMap.get(r.gstin);
            if (r.form === "GSTR1") {
                if (!entry.GSTR1 || r.period > entry.GSTR1)
                    entry.GSTR1 = r.period;
            }
            else if (r.form === "GSTR3B") {
                if (!entry.GSTR3B || r.period > entry.GSTR3B)
                    entry.GSTR3B = r.period;
            }
        }
        return res.json({ latestByGstin: Object.fromEntries(latestMap) });
    }
    catch (e) {
        console.error("getLatestBatch error", e?.response?.data || e);
        return res.status(500).json({ message: e?.message ?? "Batch failed" });
    }
};
exports.getLatestBatch = getLatestBatch;
