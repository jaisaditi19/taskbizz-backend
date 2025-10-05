"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandEntryOccurrences = expandEntryOccurrences;
function expandEntryOccurrences(entry, from, to) {
    if (!entry.freq) {
        if (from && entry.start < from)
            return [];
        if (to && entry.start >= to)
            return [];
        return [entry.start];
    }
    const out = [];
    const step = Math.max(entry.interval ?? 1, 1);
    const until = entry.until ?? null;
    const max = entry.count ?? Number.POSITIVE_INFINITY;
    let cur = new Date(entry.start);
    let produced = 0;
    while (true) {
        if (produced >= max)
            break;
        if (to && cur >= to)
            break;
        if (until && cur > until)
            break;
        if (!from || cur >= from)
            out.push(new Date(cur));
        produced++;
        switch (entry.freq) {
            case "DAILY":
                cur.setDate(cur.getDate() + step);
                break;
            case "WEEKLY":
                cur.setDate(cur.getDate() + 7 * step);
                break;
            case "MONTHLY": {
                const d = cur.getDate();
                cur.setMonth(cur.getMonth() + step);
                cur.setDate(Math.min(d, new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate()));
                break;
            }
            case "YEARLY":
                cur.setFullYear(cur.getFullYear() + step);
                break;
        }
    }
    return out;
}
