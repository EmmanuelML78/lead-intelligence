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
 * punctuation and spacing are ignored, and an ellipsis inside an excerpt
 * stands for skipped text. The words themselves must appear, in order,
 * inside a single message.
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

/** Lower case, no accents, every run of non-alphanumeric characters as one space. */
export function normalizeForEvidence(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when the excerpt's words appear in order inside the (already normalized) message. */
function excerptAppearsIn(excerpt: string, normalizedMessage: string): boolean {
  const fragments = excerpt
    .split(/\.{3,}|…/u)
    .map(normalizeForEvidence)
    .filter((fragment) => fragment.length > 0);
  if (fragments.length === 0) return false;

  const haystack = ` ${normalizedMessage} `;
  let from = 0;
  for (const fragment of fragments) {
    // Whole words only: "125" must not match inside "1250".
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
