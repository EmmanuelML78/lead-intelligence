import assert from "node:assert/strict";
import test from "node:test";
import { buildReleaseAudit, normalizeSourceMessages } from "../scripts/ops/release-audit-lib";
import { rehearsalEnvironment } from "../scripts/ops/rehearsal-guard";
import { conversationHash } from "../src/lib/ai/transcript";
import { messageId } from "../src/pipeline/persist/fingerprint";
import type { RawConversation } from "../src/pipeline/types";

const raw: RawConversation = {
  conversacion_id: "conv", lead_id: "lead", canal: "WHATSAPP", fecha_inicio: "",
  mensajes: [{ emisor: " cliente ", hora: "10:00", texto: "new text" }]
};

test("release audit predicts removals and expiry, preserves all inputs and ignores absent-source conversations", () => {
  const source = normalizeSourceMessages(raw);
  const old = [{ id: "stale-id", index: 0, sender: "cliente", sentTime: "10:00", text: "old text" }];
  const oldHash = conversationHash(old);
  const conversations = [
    { id: "conv", transcriptHash: undefined, messages: old },
    { id: "not-in-source", transcriptHash: oldHash, messages: old }
  ];
  const extractions = [
    { id: "invalid", leadId: "lead", conversationId: "conv", conversationHash: oldHash, budget: -1, downPayment: null },
    { id: "valid", leadId: "lead", conversationId: "conv", conversationHash: oldHash, budget: 0, downPayment: null },
    { id: "untouched", leadId: "other", conversationId: "not-in-source", conversationHash: oldHash, budget: null, downPayment: null }
  ];
  const before = structuredClone({ conversations, extractions, raw });
  const result = buildReleaseAudit(conversations, extractions, [raw]);
  assert.equal(result.messagesWouldRemove, 1);
  assert.equal(result.messagesWouldAdd, 1);
  assert.equal(result.hashCurrentExtractionsWouldExpire, 2);
  assert.equal(result.usableExtractionsWouldExpire, 1);
  assert.equal(result.leadsWouldLoseUsableExtraction, 1);
  assert.equal(result.incompatibleExtractions.length, 1);
  assert.match(result.incompatibleExtractions[0]!.issues[0]!, /budget/);
  assert.equal(result.transcriptsNotMatchingRecordedHash, 0, "bootstrap equals old transcript here");
  assert.deepEqual({ conversations, extractions, raw }, before);
  const settled = [{ id: "conv", transcriptHash: conversationHash(source), messages: source.map((m) => ({ ...m, id: messageId({ conversationId: "conv", ...m }) })) }];
  const repeated = buildReleaseAudit(settled, extractions.slice(0, 2), [raw]);
  assert.equal(repeated.messagesWouldRemove, 0);
  assert.equal(repeated.messagesWouldAdd, 0);
  assert.equal(repeated.hashCurrentExtractionsWouldExpire, 0);
  const nullHash = buildReleaseAudit([{ ...conversations[0]!, transcriptHash: null }], extractions.slice(0, 2), [raw]);
  assert.equal(nullHash.hashCurrentExtractionsWouldExpire, 0, "a stored NULL after migration is not a bootstrap hash");
});

test("release audit rejects duplicate source IDs instead of predicting a different pipeline result", () => {
  assert.throws(() => buildReleaseAudit([], [], [raw, raw]), /duplicate/i);
});

test("rehearsal guard requires a distinct direct target and forces provider, scoring and assignment off", () => {
  const url = "postgresql://test:secret@rehearsal.example/db";
  assert.throws(() => rehearsalEnvironment(url, "rehearsal", undefined), /production-host/);
  assert.throws(() => rehearsalEnvironment(url, "rehearsal", "rehearsal.example"), /production/i);
  assert.throws(() => rehearsalEnvironment(url, "wrong", "production.example"), /Refusing/);
  assert.throws(() => rehearsalEnvironment(url.replace("rehearsal.example", "rehearsal-pooler.example"), "rehearsal-pooler", "production.example"), /direct/);
  const env = rehearsalEnvironment(url, "rehearsal", "production.example");
  assert.deepEqual(env, { AI_API_KEY: "", AI_MAX_CONVERSATIONS: "0", PIPELINE_SKIP_ASSIGNMENT: "1", PIPELINE_SKIP_SCORING: "1" });
});
