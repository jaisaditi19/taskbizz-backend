// src/utils/rrule.ts
//
// Lightweight RRULE engine for task recurrence.
//
// Storage: unchanged — still lives in Task.recurrenceRule (a plain string
// column). No schema migration required.
//
// Backward compatible with the legacy simple tokens (DAILY / WEEKLY /
// MONTHLY / QUARTERLY / YEARLY) already sitting in production data, while
// also accepting a richer RFC5545-flavoured subset:
//
//   FREQ=<DAILY|WEEKLY|MONTHLY|YEARLY>
//   INTERVAL=<n>            (default 1)
//   COUNT=<n>                (total occurrences in the whole series)
//   UNTIL=<yyyyMMdd|ISO>     (inclusive end date, alternative to COUNT)
//   BYDAY=<MO,TU,WE,...>     (WEEKLY only — one or more weekdays)
//
// Examples:
//   "DAILY"                                     -> every day, forever
//   "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"         -> every other week, Mon+Wed
//   "FREQ=MONTHLY;INTERVAL=3"                    -> quarterly (legacy alias: "QUARTERLY")
//   "FREQ=YEARLY;COUNT=5"                        -> once a year, 5 times total
//   "FREQ=DAILY;UNTIL=20261231"                  -> every day through Dec 31 2026

import { DateTime } from "luxon";

export type RecurrenceFreq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface RecurrenceRule {
  freq: RecurrenceFreq;
  interval: number;
  byDay?: number[]; // Luxon weekday numbers: 1=Mon ... 7=Sun. WEEKLY only.
  count?: number; // total occurrences across the whole series (not per-window)
  until?: DateTime; // inclusive end-of-day, UTC
}

const DAY_TOKEN_TO_LUXON: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};
const LUXON_TO_DAY_TOKEN: Record<number, string> = Object.fromEntries(
  Object.entries(DAY_TOKEN_TO_LUXON).map(([k, v]) => [v, k])
);

const LEGACY_TOKENS: Record<string, RecurrenceRule> = {
  DAILY: { freq: "DAILY", interval: 1 },
  WEEKLY: { freq: "WEEKLY", interval: 1 },
  MONTHLY: { freq: "MONTHLY", interval: 1 },
  QUARTERLY: { freq: "MONTHLY", interval: 3 },
  YEARLY: { freq: "YEARLY", interval: 1 },
};

/**
 * Parses a recurrenceRule string (legacy token or RRULE-lite) into a
 * structured rule. Returns null for non-recurring / unrecognized input —
 * callers should treat null exactly as "not recurring", same as before.
 */
export function parseRecurrenceRule(raw: string | null | undefined): RecurrenceRule | null {
  if (!raw) return null;
  const r = String(raw).trim().toUpperCase();
  if (!r) return null;

  if (LEGACY_TOKENS[r]) return { ...LEGACY_TOKENS[r] };

  if (!r.includes("FREQ=")) return null;

  const map = new Map<string, string>();
  for (const part of r.split(";").map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    map.set(part.slice(0, eq), part.slice(eq + 1));
  }

  const freqRaw = map.get("FREQ");
  if (!freqRaw || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freqRaw)) {
    return null;
  }

  const interval = map.has("INTERVAL")
    ? Math.max(1, parseInt(map.get("INTERVAL")!, 10) || 1)
    : 1;

  let byDay: number[] | undefined;
  if (map.has("BYDAY")) {
    byDay = map
      .get("BYDAY")!
      .split(",")
      .map((t) => DAY_TOKEN_TO_LUXON[t.trim()])
      .filter((n): n is number => !!n);
    if (!byDay.length) byDay = undefined;
  }

  let count: number | undefined;
  if (map.has("COUNT")) {
    const c = parseInt(map.get("COUNT")!, 10);
    if (Number.isFinite(c) && c > 0) count = c;
  }

  let until: DateTime | undefined;
  if (map.has("UNTIL")) {
    const untilRaw = map.get("UNTIL")!;
    const dt =
      untilRaw.length === 8
        ? DateTime.fromFormat(untilRaw, "yyyyMMdd", { zone: "utc" })
        : DateTime.fromISO(untilRaw, { zone: "utc" });
    if (dt.isValid) until = dt.endOf("day");
  }

  return { freq: freqRaw as RecurrenceFreq, interval, byDay, count, until };
}

/** Inverse of parseRecurrenceRule — useful if you ever build rules
 *  programmatically (e.g. from a UI recurrence-picker) instead of
 *  hand-writing the string. */
export function serializeRecurrenceRule(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`, `INTERVAL=${rule.interval}`];
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${rule.until.toUTC().toFormat("yyyyMMdd")}`);
  if (rule.byDay?.length) {
    parts.push(`BYDAY=${rule.byDay.map((d) => LUXON_TO_DAY_TOKEN[d]).join(",")}`);
  }
  return parts.join(";");
}

export interface EnumeratedOccurrence {
  date: DateTime; // in the zone passed to seriesStart
  index: number; // 0-based position in the overall (unbounded) series
}

export interface EnumerateOptions {
  rule: RecurrenceRule;
  seriesStart: DateTime; // wall-clock anchor, in the target zone
  windowStart: DateTime; // inclusive
  windowEnd: DateTime; // inclusive
  /** Optional optimization: skip ahead close to this date instead of
   *  walking every period from seriesStart. Ignored when rule.count is
   *  set, since COUNT requires the true index from the series start. */
  resumeFrom?: DateTime;
  /** Safety valve against runaway/indefinite loops. */
  hardIterationCap?: number;
}

/**
 * Returns every occurrence date that falls within [windowStart, windowEnd],
 * respecting FREQ/INTERVAL/BYDAY/COUNT/UNTIL. Pure function — no I/O.
 */
export function enumerateOccurrences(opts: EnumerateOptions): EnumeratedOccurrence[] {
  const { rule, seriesStart, windowStart, windowEnd } = opts;
  const cap = opts.hardIterationCap ?? 20000;

  if (rule.freq === "WEEKLY" && rule.byDay?.length) {
    return enumerateWeeklyByDay(rule, seriesStart, windowStart, windowEnd, cap);
  }

  const results: EnumeratedOccurrence[] = [];
  let index = 0;

  if (opts.resumeFrom && !rule.count) {
    const skip = estimateStepsBefore(rule, seriesStart, opts.resumeFrom);
    if (skip > 0) index = skip;
  }

  let iterations = 0;
  let cursor = advance(rule, seriesStart, index);

  while (iterations < cap) {
    iterations++;

    if (rule.until && cursor > rule.until) break;
    if (rule.count !== undefined && index >= rule.count) break;
    if (cursor > windowEnd) break;

    if (cursor >= windowStart) {
      results.push({ date: cursor, index });
    }

    index++;
    cursor = advance(rule, seriesStart, index);
  }

  if (iterations >= cap) {
    console.warn(
      `[rrule] enumerateOccurrences hit the hard iteration cap (${cap}) for rule=${serializeRecurrenceRule(
        rule
      )}. Results may be incomplete — this usually means an indefinite ` +
        `DAILY/WEEKLY series with no UNTIL/COUNT combined with an unexpectedly wide window.`
    );
  }

  return results;
}

function advance(rule: RecurrenceRule, seriesStart: DateTime, index: number): DateTime {
  switch (rule.freq) {
    case "DAILY":
      return seriesStart.plus({ days: index * rule.interval });
    case "WEEKLY":
      return seriesStart.plus({ weeks: index * rule.interval });
    case "MONTHLY":
      return seriesStart.plus({ months: index * rule.interval });
    case "YEARLY":
      return seriesStart.plus({ years: index * rule.interval });
  }
}

/** Approximate + correct: months/years aren't fixed-length, so we estimate
 *  with an average period length, then nudge to the exact boundary. Cheap
 *  even for series spanning years. */
function estimateStepsBefore(rule: RecurrenceRule, seriesStart: DateTime, target: DateTime): number {
  const avgPeriodMs: Record<RecurrenceFreq, number> = {
    DAILY: 86_400_000,
    WEEKLY: 7 * 86_400_000,
    MONTHLY: 30.4368 * 86_400_000,
    YEARLY: 365.2425 * 86_400_000,
  };

  const diffMs = target.toMillis() - seriesStart.toMillis();
  if (diffMs <= 0) return 0;

  const periodMs = avgPeriodMs[rule.freq] * rule.interval;
  let est = Math.max(0, Math.floor(diffMs / periodMs) - 2); // step back for safety margin

  let cursor = advance(rule, seriesStart, est);
  while (cursor > target && est > 0) {
    est--;
    cursor = advance(rule, seriesStart, est);
  }
  while (advance(rule, seriesStart, est + 1) <= target) {
    est++;
  }
  return Math.max(0, est);
}

function enumerateWeeklyByDay(
  rule: RecurrenceRule,
  seriesStart: DateTime,
  windowStart: DateTime,
  windowEnd: DateTime,
  cap: number
): EnumeratedOccurrence[] {
  const results: EnumeratedOccurrence[] = [];
  const anchorWeekStart = seriesStart.startOf("week"); // Luxon weeks start Monday
  const days = [...rule.byDay!].sort((a, b) => a - b);

  let weekBlock = 0;
  let globalIndex = 0;
  let iterations = 0;
  let stop = false;

  while (!stop && iterations < cap) {
    iterations++;
    const weekStart = anchorWeekStart.plus({ weeks: weekBlock * rule.interval });
    if (weekStart > windowEnd) break;

    for (const wd of days) {
      const occ = weekStart.plus({ days: wd - 1 });
      if (occ < seriesStart) continue;

      if (rule.until && occ > rule.until) {
        stop = true;
        break;
      }
      if (rule.count !== undefined && globalIndex >= rule.count) {
        stop = true;
        break;
      }

      if (occ >= windowStart && occ <= windowEnd) {
        results.push({ date: occ, index: globalIndex });
      }
      globalIndex++;
    }

    weekBlock++;
  }

  if (iterations >= cap) {
    console.warn(
      `[rrule] enumerateWeeklyByDay hit the hard iteration cap (${cap}) for rule=${serializeRecurrenceRule(
        rule
      )}.`
    );
  }

  return results;
}
