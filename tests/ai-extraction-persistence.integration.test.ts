import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../src/lib/db/client";
import { findCachedExtraction, persistAiExtraction } from "../src/pipeline/persist/ai-extractions";

// Real Postgres writes against the Milestone 3 schema (enums, Conversation
// FK, cache-key index). Skipped when DATABASE_URL is not configured -- see
// tests/persistence.integration.test.ts for the same pattern.
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb ? false : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

test("integration: AiExtraction persists with enums + FK, cache lookup finds it, history is never overwritten", { skip }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const companyId = `EMP-AI-${suffix}`;
  const salesPointId = `PV-AI-${suffix}`;
  const leadId = `LD-AI-${suffix}`;
  const conversationId = `CONV-AI-${suffix}`;

  try {
    await prisma.company.create({ data: { id: companyId } });
    await prisma.salesPoint.create({ data: { id: salesPointId, companyId } });
    await prisma.lead.create({
      data: {
        id: leadId,
        companyId,
        salesPointId,
        channel: "WHATSAPP",
        status: "SIN_GESTION",
        sourceFingerprint: "test-fingerprint",
        rawPayload: {}
      }
    });
    await prisma.conversation.create({ data: { id: conversationId, sourceLeadId: leadId, leadId } });

    const data = {
      motorcycleInterest: "Bajaj Pulsar RS 200",
      motorcycleSku: "SKU-010",
      motorcycleMatchConfidence: 1,
      motorcycleMatchMethod: "exact",
      budget: 15000000,
      downPayment: 3000000,
      paymentMethod: "CREDIT" as const,
      purchaseIntent: "HIGH" as const,
      mainObjection: "NONE" as const,
      requestedAppointment: true,
      requestedQuote: true,
      confidence: 0.9,
      evidence: {
        motorcycleInterest: ["Estoy interesado en la Pulsar RS 200"],
        budget: [],
        downPayment: [],
        paymentMethod: [],
        purchaseIntent: [],
        mainObjection: [],
        requestedAppointment: [],
        requestedQuote: []
      }
    };

    const created = await persistAiExtraction(prisma, {
      leadId,
      conversationId,
      conversationHash: "hash-v1",
      provider: "gemini",
      model: "gemini-2.5-flash",
      promptVersion: "v1",
      extractionVersion: "v1",
      data
    });
    assert.equal(created.paymentMethod, "CREDIT");

    const cached = await findCachedExtraction(prisma, {
      conversationId,
      conversationHash: "hash-v1",
      promptVersion: "v1",
      model: "gemini-2.5-flash",
      extractionVersion: "v1"
    });
    assert.equal(cached?.id, created.id);

    const missOnHashChange = await findCachedExtraction(prisma, {
      conversationId,
      conversationHash: "hash-v2",
      promptVersion: "v1",
      model: "gemini-2.5-flash",
      extractionVersion: "v1"
    });
    assert.equal(missOnHashChange, null);

    const missOnExtractionVersionChange = await findCachedExtraction(prisma, {
      conversationId,
      conversationHash: "hash-v1",
      promptVersion: "v1",
      model: "gemini-2.5-flash",
      extractionVersion: "v2"
    });
    assert.equal(
      missOnExtractionVersionChange,
      null,
      "a bumped extraction contract version must not reuse a cached extraction from the old contract"
    );

    // A changed transcript produces a new row instead of overwriting history.
    await persistAiExtraction(prisma, {
      leadId,
      conversationId,
      conversationHash: "hash-v2",
      provider: "gemini",
      model: "gemini-2.5-flash",
      promptVersion: "v1",
      extractionVersion: "v1",
      data: { ...data, purchaseIntent: "LOW" }
    });
    const allExtractions = await prisma.aiExtraction.findMany({ where: { conversationId } });
    assert.equal(allExtractions.length, 2, "both extractions preserved, history never overwritten");
  } finally {
    await prisma.aiExtraction.deleteMany({ where: { conversationId } });
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.lead.deleteMany({ where: { companyId } });
    await prisma.salesPoint.deleteMany({ where: { id: salesPointId } });
    await prisma.company.deleteMany({ where: { id: companyId } });
  }
});
