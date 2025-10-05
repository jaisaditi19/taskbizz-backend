"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeOffsets = normalizeOffsets;
exports.computeLicenseStatus = computeLicenseStatus;
exports.computeNextReminderAt = computeNextReminderAt;
exports.bootstrapLicenseComputedFields = bootstrapLicenseComputedFields;
exports.buildReminderRunAt = buildReminderRunAt;
// src/services/licenseScheduler.ts
const org_client_1 = require("../../prisma/generated/org-client");
function toStartOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}
/** Sanitize offsets: keep unique negative integers, sorted ASC (e.g., -30,-7,-1) */
function normalizeOffsets(offsets) {
    const set = new Set();
    (offsets ?? []).forEach((n) => {
        const v = Number(n);
        if (Number.isFinite(v) && v < 0)
            set.add(Math.trunc(v));
    });
    return Array.from(set).sort((a, b) => a - b);
}
/** Compute initial status from dates */
function computeLicenseStatus(expiresOn, gracePeriodDays = 15, now = new Date()) {
    const today = toStartOfDay(now).getTime();
    const exp = toStartOfDay(expiresOn).getTime();
    const expiredCutoff = exp + gracePeriodDays * 24 * 60 * 60 * 1000;
    if (today > expiredCutoff)
        return org_client_1.LicenseStatus.EXPIRED;
    // If we’re within any reminder window (e.g., 7 days) consider RENEWAL_DUE
    // UI can refine this later; for now use a simple 7-day threshold.
    if (today >= exp - 7 * 24 * 60 * 60 * 1000)
        return org_client_1.LicenseStatus.RENEWAL_DUE;
    return org_client_1.LicenseStatus.ACTIVE;
}
/**
 * Compute the next reminder timestamp from expiresOn + offsets.
 * Returns null if all offsets are in the past.
 */
function computeNextReminderAt(expiresOn, offsets, now = new Date()) {
    const ex = toStartOfDay(expiresOn).getTime();
    const n = now.getTime();
    for (const off of normalizeOffsets(offsets)) {
        const ts = ex + off * 24 * 60 * 60 * 1000;
        if (ts >= n)
            return new Date(ts);
    }
    return null;
}
/** Convenience: bundle initial computed fields for CREATE */
function bootstrapLicenseComputedFields(params) {
    const offsets = normalizeOffsets(params.remindOffsets?.length ? params.remindOffsets : [-7, -1]);
    const status = computeLicenseStatus(params.expiresOn, params.gracePeriodDays ?? 15, params.now ?? new Date());
    const nextReminderAt = computeNextReminderAt(params.expiresOn, offsets, params.now ?? new Date());
    return { status, nextReminderAt, remindOffsets: offsets };
}
// add to src/services/licenseScheduler.ts
const dayjs_1 = __importDefault(require("dayjs"));
const utc_1 = __importDefault(require("dayjs/plugin/utc"));
const timezone_1 = __importDefault(require("dayjs/plugin/timezone"));
dayjs_1.default.extend(utc_1.default);
dayjs_1.default.extend(timezone_1.default);
const ORG_TZ = "Asia/Kolkata";
function buildReminderRunAt(expiresOnISO, offsetDays, hour = 10, minute = 0) {
    const iso = typeof expiresOnISO === "string" ? expiresOnISO : expiresOnISO.toISOString();
    const localRun = dayjs_1.default.tz(iso, ORG_TZ)
        .startOf("day")
        .add(offsetDays, "day")
        .hour(hour)
        .minute(minute)
        .second(0)
        .millisecond(0);
    return localRun.utc().toDate();
}
