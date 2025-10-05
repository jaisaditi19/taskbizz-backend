// src/services/licenseScheduler.ts
import { LicenseStatus } from "../../prisma/generated/org-client";

function toStartOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Sanitize offsets: keep unique negative integers, sorted ASC (e.g., -30,-7,-1) */
export function normalizeOffsets(offsets?: number[]): number[] {
  const set = new Set<number>();
  (offsets ?? []).forEach((n) => {
    const v = Number(n);
    if (Number.isFinite(v) && v < 0) set.add(Math.trunc(v));
  });
  return Array.from(set).sort((a, b) => a - b);
}

/** Compute initial status from dates */
export function computeLicenseStatus(
  expiresOn: Date,
  gracePeriodDays = 15,
  now = new Date()
): LicenseStatus {
  const today = toStartOfDay(now).getTime();
  const exp = toStartOfDay(expiresOn).getTime();
  const expiredCutoff = exp + gracePeriodDays * 24 * 60 * 60 * 1000;

  if (today > expiredCutoff) return LicenseStatus.EXPIRED;

  // If we’re within any reminder window (e.g., 7 days) consider RENEWAL_DUE
  // UI can refine this later; for now use a simple 7-day threshold.
  if (today >= exp - 7 * 24 * 60 * 60 * 1000) return LicenseStatus.RENEWAL_DUE;

  return LicenseStatus.ACTIVE;
}

/**
 * Compute the next reminder timestamp from expiresOn + offsets.
 * Returns null if all offsets are in the past.
 */
export function computeNextReminderAt(
  expiresOn: Date,
  offsets: number[],
  now = new Date()
): Date | null {
  const ex = toStartOfDay(expiresOn).getTime();
  const n = now.getTime();

  for (const off of normalizeOffsets(offsets)) {
    const ts = ex + off * 24 * 60 * 60 * 1000;
    if (ts >= n) return new Date(ts);
  }
  return null;
}

/** Convenience: bundle initial computed fields for CREATE */
export function bootstrapLicenseComputedFields(params: {
  expiresOn: Date;
  remindOffsets?: number[];
  gracePeriodDays?: number;
  now?: Date;
}) {
  const offsets = normalizeOffsets(
    params.remindOffsets?.length ? params.remindOffsets : [-7, -1]
  );
  const status = computeLicenseStatus(
    params.expiresOn,
    params.gracePeriodDays ?? 15,
    params.now ?? new Date()
  );
  const nextReminderAt = computeNextReminderAt(
    params.expiresOn,
    offsets,
    params.now ?? new Date()
  );
  return { status, nextReminderAt, remindOffsets: offsets };
}

// add to src/services/licenseScheduler.ts
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import tz from "dayjs/plugin/timezone";
dayjs.extend(utc);
dayjs.extend(tz);

const ORG_TZ = "Asia/Kolkata";
export function buildReminderRunAt(
  expiresOnISO: string | Date,
  offsetDays: number,
  hour = 10,
  minute = 0
) {
  const iso = typeof expiresOnISO === "string" ? expiresOnISO : expiresOnISO.toISOString();
  const localRun = dayjs.tz(iso, ORG_TZ)
    .startOf("day")
    .add(offsetDays, "day")
    .hour(hour)
    .minute(minute)
    .second(0)
    .millisecond(0);
  return localRun.utc().toDate();
}
