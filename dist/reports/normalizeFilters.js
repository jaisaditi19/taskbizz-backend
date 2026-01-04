"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeEnumFilter = normalizeEnumFilter;
// src/reports/normalizeFilters.ts
function normalizeEnumFilter(values) {
    if (!values || values.length === 0)
        return null;
    const cleaned = values.filter((v) => v && v !== "all" && v !== "ALL");
    return cleaned.length ? cleaned : null;
}
