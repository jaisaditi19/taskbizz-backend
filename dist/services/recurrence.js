"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CUSTOM_WEEKDAY_STRATEGY = exports.YEARLY_STRATEGY = exports.QUARTERLY_STRATEGY = exports.MONTHLY_STRATEGY = exports.WEEKLY_STRATEGY = exports.DAILY_STRATEGY = void 0;
exports.parseRecurrenceRule = parseRecurrenceRule;
exports.getRecurrenceStrategy = getRecurrenceStrategy;
function parseRecurrenceRule(rule) {
    if (!rule)
        return null;
    const r = rule.toUpperCase().trim();
    // ✅ CUSTOM stays same
    if (r.startsWith("CUSTOM:")) {
        const weekdays = r
            .replace("CUSTOM:", "")
            .split(",")
            .map(Number)
            .filter((d) => d >= 1 && d <= 7);
        if (!weekdays.length)
            return null;
        return { type: "CUSTOM", weekdays };
    }
    9415;
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
exports.DAILY_STRATEGY = {
    preserveHistory: true,
    getNextStart: (base, index) => base.plus({ days: index }),
    computeDue: (start) => start, // start == due
};
exports.WEEKLY_STRATEGY = {
    preserveHistory: true,
    getNextStart: (base, index) => base.plus({ weeks: index }),
    computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
};
exports.MONTHLY_STRATEGY = {
    preserveHistory: true,
    getNextStart: (base, index) => base.plus({ months: index }),
    computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
};
exports.QUARTERLY_STRATEGY = {
    preserveHistory: true,
    getNextStart: (base, index) => base.plus({ months: index * 3 }),
    computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
};
exports.YEARLY_STRATEGY = {
    preserveHistory: true,
    getNextStart: (base, index) => base.plus({ years: index }),
    computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
};
exports.CUSTOM_WEEKDAY_STRATEGY = {
    preserveHistory: true,
    getNextStart: (base, index, context) => {
        if (context?.type !== "CUSTOM")
            return null;
        let cursor = base;
        let found = 0;
        while (found <= index) {
            if (context.weekdays.includes(cursor.weekday)) {
                if (found === index)
                    return cursor;
                found++;
            }
            cursor = cursor.plus({ days: 1 });
        }
        return null;
    },
    computeDue: (start, durationMs) => start.plus({ milliseconds: durationMs }),
};
function getRecurrenceStrategy(parsed) {
    if (!parsed)
        return null;
    switch (parsed.type) {
        case "DAILY":
            return exports.DAILY_STRATEGY;
        case "WEEKLY":
            return exports.WEEKLY_STRATEGY;
        case "MONTHLY":
            return exports.MONTHLY_STRATEGY;
        case "QUARTERLY":
            return exports.QUARTERLY_STRATEGY;
        case "YEARLY":
            return exports.YEARLY_STRATEGY;
        case "CUSTOM":
            return exports.CUSTOM_WEEKDAY_STRATEGY;
        default:
            return null;
    }
}
