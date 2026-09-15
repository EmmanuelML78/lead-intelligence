export const ASSIGNMENT_REASON_CODES = [
  "ASSIGNED",
  "NO_ACTIVE_ADVISOR",
  "CAPACITY_EXHAUSTED",
  "NO_ELIGIBLE_ADVISOR"
] as const;

export type AssignmentReasonCode = (typeof ASSIGNMENT_REASON_CODES)[number];
export type UnassignedReasonCode = Exclude<AssignmentReasonCode, "ASSIGNED">;
