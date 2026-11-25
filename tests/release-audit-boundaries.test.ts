import assert from "node:assert/strict";
import test from "node:test";
import { buildReleaseAudit } from "../scripts/ops/release-audit-lib";
import { conversationHash } from "../src/lib/ai/transcript";
import type { RawConversation } from "../src/pipeline/types";

test("audit counts expired rows separately from leads losing all usable candidates", () => {
  const messages = [{ id: "old-message", index: 0, sender: "cliente", sentTime: null, text: "original" }];
  const hash = conversationHash(messages);
  const conversations = [
    { id: "changing", messages },
    { id: "absent-source", messages, transcriptHash: hash }
  ];
  const row = {
    id: "first", leadId: "lead", conversationId: "changing",
    conversationHash: hash, budget: 0, downPayment: null
  };
  const extractions = [row, { ...row, id: "second" }, { ...row, id: "alternate", conversationId: "absent-source" }];
  const source: RawConversation[] = [{
    conversacion_id: "changing", lead_id: "lead", canal: "WHATSAPP", fecha_inicio: "",
    mensajes: [{ emisor: "cliente", hora: "", texto: "changed" }]
  }];
  const before = structuredClone({ conversations, extractions, source });
  const result = buildReleaseAudit(conversations, extractions, source);
  assert.equal(result.hashCurrentExtractionsWouldExpire, 2);
  assert.equal(result.usableExtractionsWouldExpire, 2);
  assert.equal(result.leadsWouldLoseUsableExtraction, 0);
  assert.equal(result.messagesWouldRemove, 1);
  assert.equal(result.messagesWouldAdd, 1);
  assert.equal(buildReleaseAudit(conversations, extractions, []).messagesWouldRemove, 0);
  assert.equal(buildReleaseAudit(conversations, extractions.slice(0, 2), source).leadsWouldLoseUsableExtraction, 1);
  assert.deepEqual({ conversations, extractions, source }, before);
});
