import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { selectCurrentExtraction } from "../src/lib/ai/current-extraction";
import { conversationHash } from "../src/lib/ai/transcript";
import { presentAiExtraction } from "../src/lib/dashboard/present";
import { getLeadDetail } from "../src/lib/dashboard/queries";

const messages = [{ id: "m", index: 0, sender: "cliente", sentTime: null, text: "Busco Pulsar" }];
const hash = conversationHash(messages);
const row = {
  id: "extraction", conversationId: "second", conversationHash: hash,
  conversation: { transcriptHash: hash }, motorcycleInterest: "Pulsar",
  budget: null, downPayment: null, paymentMethod: "UNKNOWN", purchaseIntent: "HIGH",
  mainObjection: "UNKNOWN", requestedAppointment: false, requestedQuote: false,
  evidence: { motorcycleInterest: ["Busco Pulsar", "invented quote"] }
};

test("historical money: incompatible candidates are excluded without changing history", () => {
  for (const field of ["budget", "downPayment"] as const) {
    for (const value of [-1, 0.5, 2_147_483_648, "500", NaN, Infinity]) {
      const invalid = { ...row, [field]: value };
      const original = structuredClone(invalid);
      assert.equal(selectCurrentExtraction([invalid] as never), null, `${field}=${value}`);
      assert.deepEqual(invalid, original);
      assert.equal(selectCurrentExtraction([invalid, row] as never), row);
    }
  }
  for (const budget of [null, 0, 2_147_483_647]) {
    const valid = { ...row, budget };
    assert.equal(selectCurrentExtraction([valid]), valid);
    assert.equal(selectCurrentExtraction([{ ...valid, conversationHash: "stale" }]), null);
  }
});

test("historical evidence is unverified without an independently matching transcript", () => {
  const before = structuredClone(row);
  const unverified = presentAiExtraction(row);
  assert.deepEqual(unverified?.evidence, {});
  assert.equal(unverified?.evidenceStatus, "UNVERIFIED");
  const mismatched = presentAiExtraction({ ...row, conversationHash: "bootstrap-only" }, messages);
  assert.deepEqual(mismatched?.evidence, {});
  assert.equal(mismatched?.evidenceStatus, "UNVERIFIED");
  const checked = presentAiExtraction(row, messages);
  assert.deepEqual(checked?.evidence.motorcycleInterest, ["Busco Pulsar"]);
  assert.equal(checked?.evidenceStatus, "CHECKED");
  assert.equal(checked?.droppedEvidenceCount, 1);
  assert.deepEqual(row, before, "read-time verification never rewrites historical evidence");
});

test("malformed historical evidence stays hidden without changing history", () => {
  for (const evidence of [null, [], { budget: [42] }]) {
    const candidate = { ...row, evidence };
    const before = structuredClone(candidate);
    const view = presentAiExtraction(candidate, messages);
    assert.equal(view?.evidenceStatus, "UNVERIFIED");
    assert.deepEqual(view?.evidence, {});
    assert.deepEqual(candidate, before);
  }
});

function fakeDb(extractions = [row], conversations = [
  { id: "first", messages: [{ ...messages[0]!, text: "Old conversation" }] },
  { id: "second", messages }
]) {
  return {
    assignment: { count: async () => 0, findFirst: async () => null },
    lead: { findFirst: async () => ({
      id: "lead", companyId: "company", company: { id: "company", name: "Company" },
      salesPointId: "point", channel: "WHATSAPP", status: "SIN_GESTION",
      registeredAt: null, registeredAtAmbiguous: false, firstContactAt: null,
      customerNameRaw: "Customer", normalizedName: null, motorcycleTextRaw: null,
      motorcycleSku: null, customer: null, motorcycle: null,
      currentScores: [], assignments: [], aiExtractions: extractions, conversations
    }) }
  } as unknown as PrismaClient;
}

test("lead detail pairs the selected extraction with its own conversation", async () => {
  const detail = await getLeadDetail(fakeDb(), "company", "lead");
  assert.equal(detail?.aiExtraction?.purchaseIntent, "HIGH");
  assert.equal(detail?.conversation[0]?.text, "Busco Pulsar");
  assert.deepEqual(detail?.aiExtraction?.evidence.motorcycleInterest, ["Busco Pulsar"]);
  const noExtraction = await getLeadDetail(fakeDb([]), "company", "lead");
  assert.equal(noExtraction?.aiExtraction, null);
  assert.equal(noExtraction?.conversation[0]?.text, "Old conversation");
  const unavailable = await getLeadDetail(fakeDb([row], []), "company", "lead");
  assert.equal(unavailable?.aiExtraction, null, "never pair an extraction with an unavailable conversation");
});
