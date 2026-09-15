import { createHash } from "node:crypto";

export type TranscriptMessage = {
  index: number;
  sender: string;
  sentTime: string | null;
  text: string;
};

export type TranscriptRole = "CUSTOMER" | "ADVISOR" | "UNKNOWN";

/**
 * The source only ever emits "cliente" / "asesor" (see
 * data/raw/conversaciones.json), but we fall back to UNKNOWN instead of
 * guessing for anything else so a stray sender value never gets silently
 * mislabeled as the customer or the advisor.
 */
export function resolveTranscriptRole(sender: string): TranscriptRole {
  const normalized = sender.trim().toLowerCase();
  if (normalized === "cliente") return "CUSTOMER";
  if (normalized === "asesor") return "ADVISOR";
  return "UNKNOWN";
}

/**
 * Builds the deterministic, human-readable transcript the LLM prompt and
 * the conversation hash are both derived from. Messages are rendered in
 * persisted `index` order, one per line, role-labeled so the model (and a
 * human reviewer) can tell customer statements from advisor proposals at a
 * glance. Database ids are intentionally never included -- only order,
 * sender role, message time (when present), and text.
 */
export function buildCanonicalTranscript(messages: TranscriptMessage[]): string {
  const ordered = [...messages].sort((a, b) => a.index - b.index);
  return ordered
    .map((message) => {
      const role = resolveTranscriptRole(message.sender);
      const text = message.text.trim();
      const prefix = message.sentTime ? `[${message.sentTime}] ${role}` : role;
      return `${prefix}: ${text}`;
    })
    .join("\n");
}

/**
 * Deterministic SHA-256 of the canonical transcript. Same message
 * content/order in -> same hash out; any change to message text, order, or
 * count changes the hash. This is the cache/idempotency key described in
 * docs/architecture.md (Milestone 3) -- see
 * src/pipeline/persist/ai-extractions.ts.
 */
export function conversationHash(messages: TranscriptMessage[]): string {
  const transcript = buildCanonicalTranscript(messages);
  return createHash("sha256").update(transcript).digest("hex");
}
