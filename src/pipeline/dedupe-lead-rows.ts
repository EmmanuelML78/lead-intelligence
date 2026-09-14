import type { RawLead } from "./types";

export type DeduplicateLeadRowsResult = {
  canonical: RawLead[];
  duplicates: RawLead[];
};

/**
 * The dataset contains duplicate raw lead_id rows (e.g. LD-00011,
 * LD-00251). This keeps the first occurrence of each lead_id as the
 * canonical row to persist; every later occurrence of the same lead_id is
 * returned as a duplicate so the caller can record a DUPLICATE_LEAD_ID
 * issue instead of persisting (or crashing on) a second Lead with that id.
 */
export function deduplicateLeadRows(rows: RawLead[]): DeduplicateLeadRowsResult {
  const seen = new Set<string>();
  const canonical: RawLead[] = [];
  const duplicates: RawLead[] = [];

  for (const row of rows) {
    const id = row.lead_id.trim();
    if (seen.has(id)) {
      duplicates.push(row);
      continue;
    }
    seen.add(id);
    canonical.push(row);
  }

  return { canonical, duplicates };
}
