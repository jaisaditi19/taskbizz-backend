import { DateTime } from "luxon";

export type ParsedRecurrence =
  | { type: "DAILY" }
  | { type: "WEEKLY" }
  | { type: "MONTHLY" }
  | { type: "QUARTERLY" }
  | { type: "YEARLY" }
  | { type: "CUSTOM"; weekdays: number[] };

export function parseRecurrenceRule(
  rule: string | null,
): ParsedRecurrence | null {
  if (!rule) return null;

  const r = rule.toUpperCase().trim();

  // ✅ CUSTOM stays same
  if (r.startsWith("CUSTOM:")) {
    const weekdays = r
      .replace("CUSTOM:", "")
      .split(",")
      .map(Number)
      .filter((d) => d >= 1 && d <= 7);

    if (!weekdays.length) return null;
    return { type: "CUSTOM", weekdays };
  }
  
  // ✅ RRULE support
  if (r.startsWith("FREQ=")) {
    const freq = r.split(";")[0].replace("FREQ=", "");

    switch (freq) {
      case "DAILY":
      case "WEEKLY":
      case "MONTHLY":
      case "YEARLY":
        return { type: freq };

      case "MONTHLY":
        if (r.includes("INTERVAL=3")) {
          return { type: "QUARTERLY" };
        }
        return { type: "MONTHLY" };
    }
  }

  // ✅ legacy direct values
  switch (r) {
    case "DAILY":
    case "WEEKLY":
    case "MONTHLY":
    case "QUARTERLY":
    case "YEARLY":
      return { type: r };
    default:
      return null;
  }
}

  export interface RecurrenceStrategy {
    getNextStart(
      base: DateTime,
      index: number,
      context?: ParsedRecurrence,
    ): DateTime | null;

    computeDue(start: DateTime, durationMs: number): DateTime;

    preserveHistory: boolean;
  }

  export const DAILY_STRATEGY: RecurrenceStrategy = {
    preserveHistory: true,

    getNextStart: (base, index) => base.plus({ days: index }),

    computeDue: (start) => start, // start == due
  };

  export const WEEKLY_STRATEGY: RecurrenceStrategy = {
    preserveHistory: true,

    getNextStart: (base, index) => base.plus({ weeks: index }),

    computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
  };

  export const MONTHLY_STRATEGY: RecurrenceStrategy = {
    preserveHistory: true,

    getNextStart: (base, index) => base.plus({ months: index }),

    computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
  };

  export const QUARTERLY_STRATEGY: RecurrenceStrategy = {
    preserveHistory: true,

    getNextStart: (base, index) => base.plus({ months: index * 3 }),

    computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
  };

  export const YEARLY_STRATEGY: RecurrenceStrategy = {
    preserveHistory: true,

    getNextStart: (base, index) => base.plus({ years: index }),

    computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
  };

export const CUSTOM_WEEKDAY_STRATEGY: RecurrenceStrategy = {
  preserveHistory: true,

  getNextStart: (base, index, context) => {
    if (context?.type !== "CUSTOM") return null;

    let cursor = base;
    let found = 0;

    while (found <= index) {
      if (context.weekdays.includes(cursor.weekday)) {
        if (found === index) return cursor;
        found++;
      }
      cursor = cursor.plus({ days: 1 });
    }

    return null;
  },

  computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
};

  export function getRecurrenceStrategy(
    parsed: ParsedRecurrence | null,
  ): RecurrenceStrategy | null {
    if (!parsed) return null;

    switch (parsed.type) {
      case "DAILY":
        return DAILY_STRATEGY;
      case "WEEKLY":
        return WEEKLY_STRATEGY;
      case "MONTHLY":
        return MONTHLY_STRATEGY;
      case "QUARTERLY":
        return QUARTERLY_STRATEGY;
      case "YEARLY":
        return YEARLY_STRATEGY;
      case "CUSTOM":
        return CUSTOM_WEEKDAY_STRATEGY;
      default:
        return null;
    }
  }
