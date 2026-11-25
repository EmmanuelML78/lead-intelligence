import { moneyCompatibilityIssues, selectCurrentExtraction } from "../../src/lib/ai/current-extraction";
import { conversationHash, type TranscriptMessage } from "../../src/lib/ai/transcript";
import { normalizeSourceMessages } from "../../src/pipeline/conversation-source";
import { messageId } from "../../src/pipeline/persist/fingerprint";
import type { RawConversation } from "../../src/pipeline/types";
export { normalizeSourceMessages };

export type AuditConversation = {
  id: string;
  transcriptHash?: string | null;
  messages: Array<TranscriptMessage & { id: string }>;
};
export type AuditExtraction = {
  id: string; leadId: string; conversationId: string; conversationHash: string;
  budget: number | null; downPayment: number | null;
};

/** Extractions must be newest first (createdAt desc, id desc), exactly as readers select them. */
export function buildReleaseAudit(conversations: AuditConversation[], extractions: AuditExtraction[], source: RawConversation[]) {
  const sources = new Map(source.map((raw) => [raw.conversacion_id, normalizeSourceMessages(raw)]));
  if (sources.size !== source.length) throw new Error("Duplicate conversation IDs in source; stop rehearsal.");
  const before = new Map<string, string | null>();
  const after = new Map<string, string | null>();
  let messagesWouldRemove = 0;
  let messagesWouldAdd = 0;
  let transcriptsNotMatchingRecordedHash = 0;
  for (const conversation of conversations) {
    // Before migration, emulate its newest-extraction bootstrap, not a hash
    // of potentially unreconciled stored Message rows.
    const hash = conversation.transcriptHash === undefined
      ? extractions.find((e) => e.conversationId === conversation.id)?.conversationHash ?? null
      : conversation.transcriptHash;
    before.set(conversation.id, hash);
    if (hash !== null && hash !== conversationHash(conversation.messages)) transcriptsNotMatchingRecordedHash += 1;
    after.set(conversation.id, hash);
  }
  for (const [id, messages] of sources) {
    after.set(id, conversationHash(messages));
    const wanted = new Set(messages.map((message) => messageId({ conversationId: id, ...message })));
    const stored = new Set(conversations.find((c) => c.id === id)?.messages.map((m) => m.id) ?? []);
    messagesWouldRemove += [...stored].filter((id) => !wanted.has(id)).length;
    messagesWouldAdd += [...wanted].filter((id) => !stored.has(id)).length;
  }
  const candidates = (hashes: Map<string, string | null>) => extractions.map((row) => ({
    ...row, conversation: { transcriptHash: hashes.get(row.conversationId) ?? null }
  }));
  const old = candidates(before);
  const next = candidates(after);
  const usable = (rows: typeof old) => new Set(rows.filter((row) => selectCurrentExtraction([row]) !== null).map((row) => row.id));
  const usableBefore = usable(old);
  const usableAfter = usable(next);
  const leadsBefore = new Set(old.filter((e) => usableBefore.has(e.id)).map((e) => e.leadId));
  const leadsAfter = new Set(next.filter((e) => usableAfter.has(e.id)).map((e) => e.leadId));
  return {
    extractionCount: extractions.length,
    incompatibleExtractions: extractions.flatMap((row) => {
      const issues = moneyCompatibilityIssues(row);
      return issues.length ? [{ id: row.id, issues }] : [];
    }),
    transcriptsNotMatchingRecordedHash,
    messagesWouldRemove,
    messagesWouldAdd,
    hashCurrentExtractionsWouldExpire: extractions.filter((e) => before.get(e.conversationId) === e.conversationHash && after.get(e.conversationId) !== e.conversationHash).length,
    usableExtractionsWouldExpire: [...usableBefore].filter((id) => !usableAfter.has(id)).length,
    leadsWouldLoseUsableExtraction: [...leadsBefore].filter((id) => !leadsAfter.has(id)).length
  };
}
