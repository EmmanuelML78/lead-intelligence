import { PRIORITY_SCORE_VERSION } from "../scoring/hybrid";

export const ASSIGNMENT_SCORE_VERSION = PRIORITY_SCORE_VERSION;

/**
 * Open operational statuses that still need an advisor today.
 *
 * `DESCARTADO` is the lost/cancelled terminal status in the source.
 * There is no separate closed/completed status on operational leads
 * (`historico_cierres.csv` is offline training history, not a live status).
 * `UNKNOWN` is an unmapped/invalid status and is never assigned.
 */
export const ASSIGNABLE_LEAD_STATUSES = [
  "SIN_GESTION",
  "CONTACTADO",
  "NO_CONTESTA",
  "COTIZACION_ENVIADA",
  "EN_PROCESO"
] as const;

export type AssignableLeadStatus = (typeof ASSIGNABLE_LEAD_STATUSES)[number];

const ASSIGNABLE_STATUS_SET: ReadonlySet<string> = new Set(ASSIGNABLE_LEAD_STATUSES);

export function isAssignableStatus(status: string): status is AssignableLeadStatus {
  return ASSIGNABLE_STATUS_SET.has(status);
}

export type ScoreRow = {
  id: string;
  scoreVersion: string;
  totalScore: number;
  createdAt: Date;
};

/**
 * The explicit record of which history row is a lead's current score for a
 * score version (a `LeadCurrentScore` row with its `leadScore`).
 */
export type CurrentScorePointer<T> = {
  scoreVersion: string;
  leadScore: T;
};

/**
 * Current score = the row the scoring stage recorded as current for the
 * requested score version. It is never inferred from `createdAt`: a lead
 * whose data returns to an earlier state reuses an older history row, and
 * that older row is the current one.
 *
 * Pointers of other score versions are ignored. The store allows one pointer
 * per lead and version, so more than one match means the caller mixed leads.
 */
export function selectCurrentScore<T>(
  pointers: readonly CurrentScorePointer<T>[],
  scoreVersion: string = ASSIGNMENT_SCORE_VERSION
): T | null {
  const matches = pointers.filter((pointer) => pointer.scoreVersion === scoreVersion);
  if (matches.length > 1) {
    throw new Error(`Expected at most one current ${scoreVersion} score, received ${matches.length}.`);
  }
  return matches[0]?.leadScore ?? null;
}

export type PriorityLead = {
  leadId: string;
  registeredAt: Date | null;
  registeredAtAmbiguous: boolean;
  currentScore: Pick<ScoreRow, "totalScore"> | null;
};

export function trustedRegistrationMs(lead: {
  registeredAt: Date | null;
  registeredAtAmbiguous: boolean;
}): number | null {
  if (lead.registeredAtAmbiguous || !lead.registeredAt) return null;
  const ms = lead.registeredAt.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** A missing or non-finite score is not a usable score. */
function usableScore(lead: PriorityLead): number | null {
  const value = lead.currentScore?.totalScore;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Locale-independent string order (UTF-16 code units). */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Total, deterministic queue order. Each key is a complete ordering of its
 * own values and the last key is unique, so the comparison is transitive and
 * antisymmetric and any permutation of the same leads sorts identically.
 *
 * 1. Current totalScore DESC (bands never override the number). Leads
 *    without a usable score (none, or a non-finite value) rank last.
 * 2. Trusted registration time ASC: the lead that has waited longest first.
 *    A registration time is unknown when it is missing, ambiguous or
 *    invalid. Unknown times rank after every trusted time and are equal to
 *    each other; their stored value is never compared.
 * 3. leadId ASC by code unit, as the final tie-break.
 */
export function compareAssignableLeads(a: PriorityLead, b: PriorityLead): number {
  const aScore = usableScore(a);
  const bScore = usableScore(b);
  if (aScore !== bScore) {
    if (aScore === null) return 1;
    if (bScore === null) return -1;
    return aScore > bScore ? -1 : 1;
  }

  const aTime = trustedRegistrationMs(a);
  const bTime = trustedRegistrationMs(b);
  if (aTime !== bTime) {
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return aTime < bTime ? -1 : 1;
  }

  return compareIds(a.leadId, b.leadId);
}
