/**
 * Deterministic customer identity, scoped by company via the caller
 * (companyId + dedupeKey together form the unique constraint on Customer).
 * We deliberately never fuzzy-match on name similarity:
 *
 *   1. normalized phone present -> "phone:<normalizedPhone>"
 *   2. else normalized email    -> "email:<normalizedEmail>"
 *   3. else                     -> "lead:<leadId>" (no cross-lead merge)
 */
export function computeCustomerDedupeKey(input: {
  normalizedPhone: string | null;
  normalizedEmail: string | null;
  leadId: string;
}): string {
  if (input.normalizedPhone) return `phone:${input.normalizedPhone}`;
  if (input.normalizedEmail) return `email:${input.normalizedEmail}`;
  return `lead:${input.leadId}`;
}
