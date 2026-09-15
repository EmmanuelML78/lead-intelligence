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
 * Current valid score = latest `hybrid-v1` row for the lead.
 * Rows from other score versions are ignored even if newer by createdAt.
 * Among `hybrid-v1` rows (including pre-5.1 store-scoped fingerprints),
 * `createdAt DESC` then `id DESC` picks the latest valid identity.
 */
export function selectCurrentScore<T extends ScoreRow>(
  scores: readonly T[],
  scoreVersion: string = ASSIGNMENT_SCORE_VERSION
): T | null {
  const current = scores.filter((score) => score.scoreVersion === scoreVersion);
  if (current.length === 0) return null;
  return [...current].sort((a, b) => {
    const created = b.createdAt.getTime() - a.createdAt.getTime();
    if (created !== 0) return created;
    return b.id.localeCompare(a.id);
  })[0] ?? null;
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

/**
 * Deterministic queue order:
 * 1. current hybrid-v1 totalScore DESC (bands never override the number)
 * 2. trusted registration time ASC when BOTH sides have a safe date
 * 3. leadId ASC
 *
 * Ambiguous or missing registration times are skipped rather than ordered.
 */
export function compareAssignableLeads(a: PriorityLead, b: PriorityLead): number {
  const aScore = a.currentScore?.totalScore ?? Number.NEGATIVE_INFINITY;
  const bScore = b.currentScore?.totalScore ?? Number.NEGATIVE_INFINITY;
  if (aScore !== bScore) {
    return bScore - aScore;
  }
  const aTime = trustedRegistrationMs(a);
  const bTime = trustedRegistrationMs(b);
  if (aTime !== null && bTime !== null && aTime !== bTime) {
    return aTime - bTime;
  }
  return a.leadId.localeCompare(b.leadId);
}
