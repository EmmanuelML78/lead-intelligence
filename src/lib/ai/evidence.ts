import type { Evidence } from "./schema";
import type { TranscriptMessage } from "./transcript";

/**
 * Checks the evidence a model returns against the transcript it was given.
 *
 * The contract says evidence is "short excerpts copied from the actual
 * conversation text". A model can still return a quote that is not there.
 * Evidence is what a person reads to trust an extracted value, so an
 * excerpt that does not appear in the conversation is not stored.
 *
 * Matching is tolerant of presentation, not of content: case, accents,
 * punctuation and spacing are ignored, an ellipsis inside an excerpt stands
 * for skipped text, and the role label or time the transcript shows before
 * a message may be part of the quote. The words themselves must appear, in
 * order, inside a single message. A number is one word including its
 * separators, so "500.000" is not a quote of "2.500.000".
 *
 * This is a containment check, not comprehension. It cannot tell that a
 * quote changes meaning when cut ("quiero crédito" inside "no quiero
 * crédito"), and it does not equate two spellings of an amount ("8500000"
 * and "8.500.000"): the first is kept, the second is dropped.
 *
 * Only the evidence is filtered. The extracted values are left as the model
 * returned them: clearing a value because its quote could not be matched
 * would change what the scoring receives, which is a business decision, not
 * a validation step. What was dropped is reported instead.
 */

export type DroppedEvidence = { field: string; excerpt: string };

export type EvidenceVerification = {
  evidence: Evidence;
  dropped: DroppedEvidence[];
};

// Stand-ins kept through normalization: a separator inside a number, and ñ.
const DIGIT_SEPARATOR = "\u0001";
const ENYE = "\u0002";
const KEPT = `${DIGIT_SEPARATOR}${ENYE}`;

/**
 * Lower case, no accents, every run of other characters as one space.
 * Two things are deliberately not flattened: a "." or "," between digits
 * stays inside its number, and "ñ" stays distinct from "n".
 */
export function normalizeForEvidence(text: string): string {
  return text
    .toLowerCase()
    .replace(/ñ/g, ENYE)
    .replace(/(?<=\d)[.,](?=\d)/g, DIGIT_SEPARATOR)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(new RegExp(`[^\\p{L}\\p{N}${KEPT}]+`, "gu"), " ")
    .trim();
}

/** The transcript given to the model shows "[HH:MM] ROLE: text"; a quote may start with that prefix. */
function withoutTranscriptLabel(excerpt: string): string {
  return excerpt.replace(/^\s*(?:\[\d{1,2}:\d{2}\]\s*)?(?:CUSTOMER|ADVISOR|UNKNOWN)\s*:\s*/i, "");
}

/** True when the excerpt's words appear in order inside the (already normalized) message. */
function excerptAppearsIn(excerpt: string, normalizedMessage: string): boolean {
  const fragments = withoutTranscriptLabel(excerpt)
    .split(/\.{3,}|…/u)
    .map(normalizeForEvidence)
    .filter((fragment) => fragment.length > 0);
  if (fragments.length === 0) return false;

  const haystack = ` ${normalizedMessage} `;
  let from = 0;
  for (const fragment of fragments) {
    // Whole words only: "125" must not match inside "1250", nor "500.000" inside "2.500.000".
    const at = haystack.indexOf(` ${fragment} `, from);
    if (at === -1) return false;
    from = at + fragment.length + 1;
  }
  return true;
}

export function verifyEvidence(evidence: Evidence, messages: readonly TranscriptMessage[]): EvidenceVerification {
  const normalizedMessages = messages.map((message) => normalizeForEvidence(message.text));
  const verified: Evidence = {};
  const dropped: DroppedEvidence[] = [];

  for (const [field, excerpts] of Object.entries(evidence) as Array<[keyof Evidence, string[] | undefined]>) {
    const kept: string[] = [];
    for (const excerpt of excerpts ?? []) {
      if (normalizedMessages.some((message) => excerptAppearsIn(excerpt, message))) kept.push(excerpt);
      else dropped.push({ field, excerpt });
    }
    verified[field] = kept;
  }

  return { evidence: verified, dropped };
}
