/**
 * Which AI extraction is current for a lead.
 *
 * Extractions are history: one row per analysis, never deleted. An extraction
 * describes the transcript it was made from, identified by its
 * `conversationHash`. It is current only while its conversation still holds
 * that transcript, i.e. while the hash equals the conversation's
 * `transcriptHash`.
 *
 * This is deliberately not "the newest extraction": when a transcript changes
 * and later returns to an earlier state, the extraction of that earlier state
 * is reused (cache hit) and is current again although it is older; and a
 * transcript nobody has analysed yet has no current extraction at all, rather
 * than borrowing one made from text that no longer exists.
 */
import { aiExtractionResultSchema } from "./schema";

const moneySchema = aiExtractionResultSchema.pick({ budget: true, downPayment: true });

/** Historical rows are immutable. Incompatible amounts are excluded, never repaired or re-extracted. */
export function moneyCompatibilityIssues(row: { budget: unknown; downPayment: unknown }): string[] {
  const parsed = moneySchema.safeParse(row);
  return parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

export type ExtractionCandidate = {
  budget: number | null;
  downPayment: number | null;
  conversationHash: string;
  conversation: { transcriptHash: string | null };
};

/**
 * Returns the first candidate that matches its conversation's current
 * transcript. Pass candidates newest first: among several extractions of the
 * same transcript (another prompt version or model) the newest one wins.
 */
export function selectCurrentExtraction<T extends ExtractionCandidate>(candidates: readonly T[]): T | null {
  return (
    candidates.find(
      (candidate) =>
        candidate.conversation.transcriptHash !== null &&
        candidate.conversationHash === candidate.conversation.transcriptHash &&
        moneyCompatibilityIssues(candidate).length === 0
    ) ?? null
  );
}

/** Prisma `select` fragment every reader adds so `selectCurrentExtraction` can decide. */
export const extractionCurrencySelect = {
  budget: true,
  downPayment: true,
  conversationHash: true,
  conversation: { select: { transcriptHash: true } }
} as const;
