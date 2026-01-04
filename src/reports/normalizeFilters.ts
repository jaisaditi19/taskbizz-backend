// src/reports/normalizeFilters.ts
export function normalizeEnumFilter(values?: string[] | null): string[] | null {
  if (!values || values.length === 0) return null;

  const cleaned = values.filter((v) => v && v !== "all" && v !== "ALL");

  return cleaned.length ? cleaned : null;
}
