export type IssueTypeCount = {
  type: string;
  count: number;
};

/**
 * Unique issue counts by TYPE.
 *
 * Each PipelineIssue row is one deterministic fingerprint. Count rows,
 * never sum `reobservedRunCount` — that field is how many pipeline
 * executions observed the fingerprint, not how many source rows exist.
 */
export function countIssuesByType(
  issues: readonly { type: string; reobservedRunCount?: number }[]
): IssueTypeCount[] {
  const counts = new Map<string, number>();
  for (const issue of issues) {
    counts.set(issue.type, (counts.get(issue.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export const FEATURED_ISSUE_TYPES = [
  "AMBIGUOUS_DATE",
  "MISSING_CITY",
  "MISSING_MOTORCYCLE_INTEREST",
  "UNRESOLVED_MOTORCYCLE",
  "ORPHAN_CONVERSATION",
  "DUPLICATE_LEAD_ID"
] as const;
