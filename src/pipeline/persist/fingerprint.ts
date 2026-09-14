import { createHash } from "node:crypto";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Canonical JSON representation: object keys are sorted recursively so the
 * fingerprint is stable regardless of source column order. Values are kept
 * as-is (the raw row is a flat string map for every source we ingest).
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Deterministic SHA-256 fingerprint of a source row's canonical
 * representation. Stable across reruns: same raw row in -> same fingerprint
 * out, regardless of column order or which run produced it.
 */
export function sourceFingerprint(raw: unknown): string {
  return sha256(canonicalStringify(raw));
}

/**
 * The source does not provide globally unique message ids. We derive one
 * deterministically from the conversation id, the message's position in the
 * conversation, and its content, so reruns never mint a new id for the same
 * logical message (and never collide across different messages).
 */
export function messageId(input: {
  conversationId: string;
  index: number;
  sender: string;
  sentTime: string | null;
  text: string;
}): string {
  const digest = sha256(
    canonicalStringify({
      conversationId: input.conversationId,
      index: input.index,
      sender: input.sender,
      sentTime: input.sentTime,
      text: input.text
    })
  );
  return `msg_${digest.slice(0, 32)}`;
}

/**
 * Identifies "the same underlying data-quality problem" independent of
 * which PipelineRun found it, so PipelineIssue rows can be deduplicated
 * across reruns of an unchanged dataset.
 */
export function issueFingerprint(input: {
  type: string;
  entityType?: string | null;
  entityId?: string | null;
  field?: string | null;
  rawValue?: string | null;
}): string {
  return sha256(
    canonicalStringify({
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      field: input.field ?? null,
      rawValue: input.rawValue ?? null
    })
  );
}
