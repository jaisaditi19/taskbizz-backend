"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchGstinDetailsViaJamku = fetchGstinDetailsViaJamku;
exports.rowsFromAggregateReturnList = rowsFromAggregateReturnList;
exports.fetchGstinAggregateRawViaJamku = fetchGstinAggregateRawViaJamku;
exports.computeDueDateIST = computeDueDateIST;
exports.deriveStatusFor = deriveStatusFor;
const axios_1 = __importDefault(require("axios"));
async function fetchGstinDetailsViaJamku(gstin) {
    const url = `https://gst-return-status.p.rapidapi.com/free/gstin/${encodeURIComponent(gstin)}`;
    const resp = await axios_1.default.get(url, {
        headers: {
            "x-rapidapi-key": process.env.RAPIDAPI_KEY,
            "x-rapidapi-host": "gst-return-status.p.rapidapi.com",
        },
        timeout: 8000,
    });
    const d = resp?.data?.data ?? {};
    return {
        gstin,
        legalName: d.lgnm ?? d.legalName ?? null,
        tradeName: d.tradeName ?? null,
        pan: d.pan ?? null,
        status: d.sts ?? null,
        registrationDate: d.rgdt ?? null,
        address: d.adr ?? null,
        pincode: d.pincode ?? null,
        stateName: d.stateName ?? null,
        stateCode: d.stateCode ?? null,
        city: d.city ?? null,
        source: "jamku-rapidapi",
    };
}
function parseDDMMYYYY(d) {
    if (!d)
        return null;
    const [dd, mm, yyyy] = d.split("/");
    if (!dd || !mm || !yyyy)
        return null;
    const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T00:00:00.000Z`;
    const dt = new Date(iso);
    return Number.isNaN(dt.getTime()) ? null : dt;
}
const MONTH_TO_NUM = {
    APRIL: 4,
    MAY: 5,
    JUNE: 6,
    JULY: 7,
    AUGUST: 8,
    SEPTEMBER: 9,
    OCTOBER: 10,
    NOVEMBER: 11,
    DECEMBER: 12,
    JANUARY: 1,
    FEBRUARY: 2,
    MARCH: 3,
};
// FY Apr–Mar → "YYYY-MM"
function periodFromFYAndMonth(fy, taxp) {
    const [y1Str, y2Str] = (fy || "").split("-");
    const y1 = Number(y1Str), y2 = Number(y2Str);
    const mnum = MONTH_TO_NUM[(taxp || "").toUpperCase()];
    if (!y1 || !y2 || !mnum)
        return null;
    const year = mnum >= 4 ? y1 : y2; // Apr..Dec -> first year; Jan..Mar -> second year
    const mm = String(mnum).padStart(2, "0");
    return `${year}-${mm}`;
}
/**
 * Convert the aggregate `returns[]` into normalized monthly FILED rows.
 * (Annual forms are ignored; keep if you want.)
 */
function rowsFromAggregateReturnList(gstin, payload) {
    const out = [];
    const list = Array.isArray(payload?.returns) ? payload.returns : [];
    for (const r of list) {
        const form = String(r?.rtntype ?? "").toUpperCase(); // "GSTR1" | "GSTR3B" | "GSTR9"...
        const fy = String(r?.fy ?? "");
        const taxp = String(r?.taxp ?? "");
        const period = taxp === "Annual" ? null : periodFromFYAndMonth(fy, taxp);
        const filingDate = parseDDMMYYYY(r?.dof ?? null);
        if ((form === "GSTR1" || form === "GSTR3B") && period) {
            out.push({
                period,
                form,
                status: "FILED",
                filingDate,
                arn: r?.arn ?? null,
            });
        }
    }
    // dedupe by (period, form) keep latest filingDate
    const map = new Map();
    for (const row of out) {
        const k = `${row.period}|${row.form}`;
        const prev = map.get(k);
        if (!prev)
            map.set(k, row);
        else {
            const pa = prev.filingDate?.getTime() ?? 0;
            const pb = row.filingDate?.getTime() ?? 0;
            if (pb >= pa)
                map.set(k, row);
        }
    }
    return Array.from(map.values());
}
async function fetchGstinAggregateRawViaJamku(gstin) {
    const url = `https://gst-return-status.p.rapidapi.com/free/gstin/${encodeURIComponent(gstin)}`;
    const resp = await axios_1.default.get(url, {
        headers: {
            "x-rapidapi-key": process.env.RAPIDAPI_KEY,
            "x-rapidapi-host": "gst-return-status.p.rapidapi.com",
        },
        timeout: 8000,
    });
    return resp?.data?.data ?? {};
}
/* ===========================
   Status derivation helpers
   =========================== */
function splitPeriod(period) {
    const [ys, ms] = period.split("-");
    return { y: Number(ys), m: Number(ms) };
}
function monthlyDueDay(form) {
    // Simplified common due dates (adjust if you have freq/state-specific logic):
    // GSTR-1: 11th of next month, GSTR-3B: 20th of next month
    return form === "GSTR1" ? 11 : 20;
}
function nextMonth(y, m) {
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    return { y: ny, m: nm };
}
function makeISTDate(y, m, d) {
    // Build a local date at midnight; keep it simple
    return new Date(y, m - 1, d, 0, 0, 0);
}
function computeDueDateIST(period, form) {
    const { y, m } = splitPeriod(period);
    const { y: dy, m: dm } = nextMonth(y, m);
    return makeISTDate(dy, dm, monthlyDueDay(form));
}
/**
 * If filing exists → FILED
 * else if now < period start → NOT_DUE_YET
 * else if now <= due date → DUE
 * else → OVERDUE
 */
function deriveStatusFor(period, form, filedIndex, now = new Date()) {
    const key = `${period}|${form}`;
    if (filedIndex.has(key)) {
        return {
            status: "FILED",
            filingDate: filedIndex.get(key).filingDate ?? null,
        };
    }
    const due = computeDueDateIST(period, form);
    const { y, m } = splitPeriod(period);
    const periodStart = makeISTDate(y, m, 1);
    if (now < periodStart)
        return { status: "NOT_DUE_YET", filingDate: null };
    if (now <= due)
        return { status: "DUE", filingDate: null };
    return { status: "OVERDUE", filingDate: null };
}
