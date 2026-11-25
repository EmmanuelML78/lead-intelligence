import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { AiExtractionProvider, AiExtractionProviderOutput } from "../src/lib/ai/provider";
import { aiExtractionResultSchema } from "../src/lib/ai/schema";
import { conversationHash } from "../src/lib/ai/transcript";
import { getLeadDetail } from "../src/lib/dashboard/queries";
import { prisma } from "../src/lib/db/client";
import { runAiExtractionStage } from "../src/pipeline/ai-stage";
import { persistAiExtraction } from "../src/pipeline/persist/ai-extractions";
import { persistConversation, type NormalizedMessage } from "../src/pipeline/persist/conversations";
import { runScoringStage } from "../src/pipeline/scoring-stage";

// The persisted messages of a conversation are the current snapshot of the
// source transcript, nothing more and nothing less. Earlier transcripts are
// kept as history so earlier AI extractions stay traceable.
// Skipped when DATABASE_URL is not configured.
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

type Fixture = { company: string; salesPoint: string; lead: string; conversation: string };

async function createFixture(prefix: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    company: `EMP-${prefix}-${suffix}`,
    salesPoint: `PV-${prefix}-${suffix}`,
    lead: `LD-${prefix}-${suffix}`,
    conversation: `CONV-${prefix}-${suffix}`
  };
  await prisma.company.create({ data: { id: fixture.company } });
  await prisma.salesPoint.create({ data: { id: fixture.salesPoint, companyId: fixture.company } });
  await prisma.lead.create({
    data: {
      id: fixture.lead,
      companyId: fixture.company,
      salesPointId: fixture.salesPoint,
      registeredAt: new Date("2026-09-10T12:00:00.000Z"),
      channel: "WHATSAPP",
      status: "SIN_GESTION",
      sourceFingerprint: `fp-${fixture.lead}`,
      rawPayload: {}
    }
  });
  return fixture;
}

async function removeFixture(fixture: Fixture) {
  await prisma.leadScore.deleteMany({ where: { leadId: fixture.lead } });
  await prisma.conversation.deleteMany({ where: { id: fixture.conversation } });
  await prisma.lead.deleteMany({ where: { id: fixture.lead } });
  await prisma.salesPoint.deleteMany({ where: { id: fixture.salesPoint } });
  await prisma.company.deleteMany({ where: { id: fixture.company } });
}

function msg(sender: string, sentTime: string | null, text: string): Omit<NormalizedMessage, "index"> {
  return { sender, sentTime, text };
}

function indexed(messages: Array<Omit<NormalizedMessage, "index">>): NormalizedMessage[] {
  return messages.map((message, index) => ({ ...message, index }));
}

async function persist(fixture: Fixture, messages: Array<Omit<NormalizedMessage, "index">>) {
  return persistConversation(prisma, {
    id: fixture.conversation,
    sourceLeadId: fixture.lead,
    leadId: fixture.lead,
    channel: "whatsapp",
    startedAt: new Date("2026-09-10T12:00:00.000Z"),
    messages: indexed(messages)
  });
}

/** What is stored, in order, reduced to what a reader sees. */
async function storedTranscript(fixture: Fixture) {
  const rows = await prisma.message.findMany({
    where: { conversationId: fixture.conversation },
    orderBy: [{ index: "asc" }, { id: "asc" }],
    select: { index: true, sender: true, sentTime: true, text: true }
  });
  return rows;
}

const HELLO = msg("cliente", "10:00", "Hola, me interesa la GN 125");
const REPLY = msg("asesor", "10:01", "Claro, ¿de contado o financiada?");
const CASH = msg("cliente", "10:05", "De contado, tengo 8 millones");

test(
  "integration: a modified message replaces the old one instead of leaving both",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-MOD");
    try {
      await persist(fixture, [HELLO, REPLY]);
      const edited = msg("asesor", "10:01", "Claro, ¿de contado o a crédito?");
      const { result, issues } = await persist(fixture, [HELLO, edited]);

      assert.equal(result.error, undefined);
      assert.deepEqual(issues, []);
      assert.deepEqual(await storedTranscript(fixture), indexed([HELLO, edited]));
      assert.equal(result.messagesPersisted, 2);
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: a message removed from the source is removed from the stored transcript",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-DEL");
    try {
      await persist(fixture, [HELLO, REPLY, CASH]);
      await persist(fixture, [HELLO, CASH]);
      assert.deepEqual(await storedTranscript(fixture), indexed([HELLO, CASH]));
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: an added message is appended without duplicating the existing ones",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-ADD");
    try {
      await persist(fixture, [HELLO, REPLY]);
      const before = await prisma.message.findMany({ where: { conversationId: fixture.conversation }, orderBy: { index: "asc" } });
      await persist(fixture, [HELLO, REPLY, CASH]);
      assert.deepEqual(await storedTranscript(fixture), indexed([HELLO, REPLY, CASH]));
      const after = await prisma.message.findMany({ where: { conversationId: fixture.conversation }, orderBy: { index: "asc" } });
      assert.deepEqual(after.slice(0, 2), before, "unchanged messages keep their rows");
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: reordered messages are stored in the new order, each exactly once",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-ORD");
    try {
      await persist(fixture, [HELLO, REPLY, CASH]);
      await persist(fixture, [CASH, HELLO, REPLY]);
      assert.deepEqual(await storedTranscript(fixture), indexed([CASH, HELLO, REPLY]));
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: repeated identical messages inside one conversation are all kept",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-DUP");
    try {
      const ok = msg("cliente", null, "ok");
      await persist(fixture, [ok, ok, ok]);
      await persist(fixture, [ok, ok, ok]);
      assert.deepEqual(await storedTranscript(fixture), indexed([ok, ok, ok]));
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: a conversation that becomes empty has no stored messages, and one that starts empty is valid",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-EMPTY");
    try {
      const empty = await persist(fixture, []);
      assert.equal(empty.result.error, undefined);
      assert.equal(empty.result.messagesPersisted, 0);
      assert.deepEqual(await storedTranscript(fixture), []);

      await persist(fixture, [HELLO, REPLY]);
      const emptied = await persist(fixture, []);
      assert.equal(emptied.result.messagesPersisted, 0);
      assert.deepEqual(await storedTranscript(fixture), []);
      assert.equal(await prisma.conversation.count({ where: { id: fixture.conversation } }), 1, "the conversation itself remains");
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: persisting the same transcript again changes nothing",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-IDEM");
    try {
      const first = await persist(fixture, [HELLO, REPLY, CASH]);
      const rowsBefore = await prisma.message.findMany({ where: { conversationId: fixture.conversation }, orderBy: { index: "asc" } });
      const conversationBefore = await prisma.conversation.findUniqueOrThrow({ where: { id: fixture.conversation } });
      const snapshotsBefore = await prisma.conversationSnapshot.findMany({ where: { conversationId: fixture.conversation } });

      const second = await persist(fixture, [HELLO, REPLY, CASH]);

      assert.deepEqual(await prisma.message.findMany({ where: { conversationId: fixture.conversation }, orderBy: { index: "asc" } }), rowsBefore);
      assert.deepEqual(await prisma.conversation.findUniqueOrThrow({ where: { id: fixture.conversation } }), conversationBefore);
      assert.deepEqual(await prisma.conversationSnapshot.findMany({ where: { conversationId: fixture.conversation } }), snapshotsBefore);
      assert.equal(snapshotsBefore.length, 1);

      assert.deepEqual(
        { added: first.result.messagesAdded, removed: first.result.messagesRemoved, changed: first.result.transcriptChanged },
        { added: 3, removed: 0, changed: false },
        "the first ingestion is not a change"
      );
      assert.deepEqual(
        { added: second.result.messagesAdded, removed: second.result.messagesRemoved, changed: second.result.transcriptChanged },
        { added: 0, removed: 0, changed: false }
      );
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: the conversation records its current transcript and keeps every earlier one as history",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-HIST");
    try {
      const transcriptA = indexed([HELLO, REPLY]);
      const transcriptB = indexed([HELLO, REPLY, CASH]);

      await persist(fixture, [HELLO, REPLY]);
      const changed = await persist(fixture, [HELLO, REPLY, CASH]);
      assert.deepEqual(
        { added: changed.result.messagesAdded, removed: changed.result.messagesRemoved, changed: changed.result.transcriptChanged },
        { added: 1, removed: 0, changed: true }
      );

      const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: fixture.conversation } });
      assert.equal(conversation.transcriptHash, conversationHash(transcriptB), "the current transcript is B");

      const snapshots = await prisma.conversationSnapshot.findMany({
        where: { conversationId: fixture.conversation },
        orderBy: { createdAt: "asc" }
      });
      assert.deepEqual(snapshots.map((row) => row.transcriptHash), [conversationHash(transcriptA), conversationHash(transcriptB)]);
      assert.deepEqual(snapshots[0]?.messages, transcriptA, "the earlier transcript can still be read in full");
      assert.equal(snapshots[0]?.messageCount, 2);

      // Going back to A reuses its history entry instead of adding a third.
      await persist(fixture, [HELLO, REPLY]);
      assert.equal(await prisma.conversationSnapshot.count({ where: { conversationId: fixture.conversation } }), 2);
      const back = await prisma.conversation.findUniqueOrThrow({ where: { id: fixture.conversation } });
      assert.equal(back.transcriptHash, conversationHash(transcriptA));
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: a failure while persisting leaves the previous transcript exactly as it was",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-ATOM");
    try {
      await persist(fixture, [HELLO, REPLY]);
      const before = await prisma.message.findMany({ where: { conversationId: fixture.conversation }, orderBy: { index: "asc" } });
      const conversationBefore = await prisma.conversation.findUniqueOrThrow({ where: { id: fixture.conversation } });

      // PostgreSQL rejects a NUL character in text, so inserting the second
      // message fails inside the transaction, after REPLY was already
      // removed and the conversation updated. All of it must be undone.
      const broken = msg("cliente", null, "no se puede guardar\u0000esto");
      const { result, issues } = await persist(fixture, [CASH, broken]);

      assert.ok(result.error, "the failure is reported");
      assert.equal(issues.at(-1)?.type, "CONVERSATION_PERSIST_ERROR");
      assert.deepEqual(await prisma.message.findMany({ where: { conversationId: fixture.conversation }, orderBy: { index: "asc" } }), before);
      assert.deepEqual(await prisma.conversation.findUniqueOrThrow({ where: { id: fixture.conversation } }), conversationBefore);
      assert.equal(await prisma.conversationSnapshot.count({ where: { conversationId: fixture.conversation } }), 1);
    } finally {
      await removeFixture(fixture);
    }
  }
);

// --- AI extractions follow the current transcript ---------------------------

function extraction(purchaseIntent: "HIGH" | "LOW") {
  return {
    motorcycleInterest: null,
    budget: null,
    downPayment: null,
    paymentMethod: "UNKNOWN" as const,
    purchaseIntent,
    mainObjection: "UNKNOWN" as const,
    requestedAppointment: false,
    requestedQuote: false,
    confidence: 0.9,
    evidence: {
      motorcycleInterest: [],
      budget: [],
      downPayment: [],
      paymentMethod: [],
      purchaseIntent: [],
      mainObjection: [],
      requestedAppointment: [],
      requestedQuote: []
    },
    motorcycleSku: null,
    motorcycleMatchConfidence: null,
    motorcycleMatchMethod: null
  };
}

async function storeExtraction(fixture: Fixture, messages: NormalizedMessage[], purchaseIntent: "HIGH" | "LOW") {
  return persistAiExtraction(prisma, {
    leadId: fixture.lead,
    conversationId: fixture.conversation,
    conversationHash: conversationHash(messages),
    provider: "fake",
    model: "fake-model",
    promptVersion: "v1",
    extractionVersion: "v1",
    data: extraction(purchaseIntent)
  });
}

async function scoredIntent(fixture: Fixture) {
  const { scores } = await runScoringStage(prisma, {
    companyId: fixture.company,
    decisionAt: new Date("2026-09-14T20:00:00.000Z")
  });
  const score = scores.find((row) => row.leadId === fixture.lead);
  assert.ok(score);
  return { usedAi: score.explanation.intent.usedAiExtraction, purchaseIntent: score.explanation.intent.purchaseIntent };
}

test("integration: historical money is preserved but excluded from scoring and detail", { skip, timeout: 60_000 }, async () => {
  const fixture = await createFixture("HISTORY-MONEY");
  try {
    await persist(fixture, [HELLO]);
    const stored = await storeExtraction(fixture, indexed([HELLO]), "HIGH");
    await prisma.aiExtraction.update({ where: { id: stored.id }, data: { budget: -1 } });
    const before = await prisma.aiExtraction.findUniqueOrThrow({ where: { id: stored.id } });
    assert.equal((await scoredIntent(fixture)).usedAi, false);
    assert.equal((await getLeadDetail(prisma, fixture.company, fixture.lead))?.aiExtraction, null);
    assert.deepEqual(await prisma.aiExtraction.findUniqueOrThrow({ where: { id: stored.id } }), before);
  } finally { await removeFixture(fixture); }
});

test("integration: two conversations show the selected extraction's transcript and locally checked evidence", { skip, timeout: 60_000 }, async () => {
  const fixture = await createFixture("HISTORY-PAIR");
  const second = { ...fixture, conversation: `${fixture.conversation}-second` };
  try {
    await persist(fixture, [HELLO]);
    await persist(second, [CASH]);
    // Equal timestamps exercise the deterministic ID tie-breaker for fallback.
    await prisma.conversation.updateMany({ where: { leadId: fixture.lead }, data: { startedAt: new Date("2026-09-01T00:00:00Z") } });
    const stored = await storeExtraction(second, indexed([CASH]), "HIGH");
    await prisma.aiExtraction.update({ where: { id: stored.id }, data: { evidence: { paymentMethod: [CASH.text, "fabricated"] } } });
    const before = await prisma.aiExtraction.findUniqueOrThrow({ where: { id: stored.id } });
    const detail = await getLeadDetail(prisma, fixture.company, fixture.lead);
    assert.equal(detail?.conversation[0]?.text, CASH.text);
    assert.equal(detail?.aiExtraction?.evidenceStatus, "CHECKED");
    assert.deepEqual(detail?.aiExtraction?.evidence.paymentMethod, [CASH.text]);
    assert.equal(detail?.aiExtraction?.droppedEvidenceCount, 1);
    assert.deepEqual(await prisma.aiExtraction.findUniqueOrThrow({ where: { id: stored.id } }), before);
    await prisma.conversation.update({ where: { id: second.conversation }, data: { transcriptHash: "not-current" } });
    const fallback = await getLeadDetail(prisma, fixture.company, fixture.lead);
    assert.equal(fallback?.aiExtraction, null);
    assert.equal(fallback?.conversation[0]?.text, HELLO.text);
  } finally {
    await prisma.conversation.deleteMany({ where: { id: second.conversation } });
    await removeFixture(fixture);
  }
});

test(
  "integration: scoring and the lead detail use the extraction of the current transcript, not the newest one",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-AI");
    try {
      const transcriptA = indexed([HELLO, REPLY]);
      const transcriptB = indexed([HELLO, REPLY, CASH]);

      await persist(fixture, [HELLO, REPLY]);
      const extractionA = await storeExtraction(fixture, transcriptA, "LOW");
      await persist(fixture, [HELLO, REPLY, CASH]);
      const extractionB = await storeExtraction(fixture, transcriptB, "HIGH");
      assert.ok(extractionA.createdAt.getTime() <= extractionB.createdAt.getTime(), "B is the newest extraction");

      assert.deepEqual(await scoredIntent(fixture), { usedAi: true, purchaseIntent: "HIGH" });
      assert.equal((await getLeadDetail(prisma, fixture.company, fixture.lead))?.aiExtraction?.purchaseIntent, "HIGH");

      // The source goes back to transcript A: its extraction is current again.
      await persist(fixture, [HELLO, REPLY]);
      assert.deepEqual(await scoredIntent(fixture), { usedAi: true, purchaseIntent: "LOW" });
      assert.equal((await getLeadDetail(prisma, fixture.company, fixture.lead))?.aiExtraction?.purchaseIntent, "LOW");

      // A transcript nobody has analysed yet has no extraction: stale ones are not reused.
      await persist(fixture, [HELLO]);
      assert.equal((await scoredIntent(fixture)).usedAi, false);
      assert.equal((await getLeadDetail(prisma, fixture.company, fixture.lead))?.aiExtraction, null);

      // Both earlier extractions are still there, each tied to the transcript it was made from.
      const kept = await prisma.aiExtraction.findMany({ where: { conversationId: fixture.conversation }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(kept.map((row) => row.id), [extractionA.id, extractionB.id]);
      for (const row of kept) {
        const snapshot = await prisma.conversationSnapshot.findUnique({
          where: { conversationId_transcriptHash: { conversationId: fixture.conversation, transcriptHash: row.conversationHash } }
        });
        assert.ok(snapshot, "the transcript behind every extraction is kept");
      }
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: the contract, not the database, is what protects amounts: the store truncates and overflows",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-COP");
    const MAX_COP_AMOUNT = 2_147_483_647;
    try {
      await persist(fixture, [HELLO]);
      const stored = await persistAiExtraction(prisma, {
        leadId: fixture.lead,
        conversationId: fixture.conversation,
        conversationHash: conversationHash(indexed([HELLO])),
        provider: "fake",
        model: "fake-model",
        promptVersion: "v1",
        extractionVersion: "v1",
        data: { ...extraction("HIGH"), budget: MAX_COP_AMOUNT, downPayment: 0 }
      });
      const read = await prisma.aiExtraction.findUniqueOrThrow({ where: { id: stored.id } });
      assert.equal(read.budget, MAX_COP_AMOUNT);
      assert.equal(read.downPayment, 0);

      const storeDirectly = (budget: number, hash: string) =>
        persistAiExtraction(prisma, {
          leadId: fixture.lead,
          conversationId: fixture.conversation,
          conversationHash: hash,
          provider: "fake",
          model: "fake-model",
          promptVersion: "v1",
          extractionVersion: "v1",
          data: { ...extraction("HIGH"), budget }
        });

      // One peso beyond the limit cannot be written at all.
      await assert.rejects(() => storeDirectly(MAX_COP_AMOUNT + 1, "overflow"));

      // A fractional amount is written without any error, as a different
      // number. Nothing below the contract would notice, so the contract is
      // where it has to be refused.
      const truncated = await storeDirectly(8_500_000.5, "fractional");
      assert.equal(
        (await prisma.aiExtraction.findUniqueOrThrow({ where: { id: truncated.id } })).budget,
        8_500_000,
        "the storage layer silently drops the fraction"
      );
      const refused = aiExtractionResultSchema.safeParse({ ...extraction("HIGH"), budget: 8_500_000.5 });
      assert.equal(refused.success, false, "so the contract rejects it before it gets there");
      assert.equal(aiExtractionResultSchema.safeParse({ ...extraction("HIGH"), budget: MAX_COP_AMOUNT + 1 }).success, false);
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: the AI cache misses when the transcript changes and hits again when it returns",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-CACHE");
    let calls = 0;
    const provider: AiExtractionProvider = {
      name: "fake",
      model: "fake-model",
      async extract(): Promise<AiExtractionProviderOutput> {
        calls += 1;
        return { raw: { ...extraction("HIGH"), evidence: {} } };
      }
    };
    const run = async (messages: Array<Omit<NormalizedMessage, "index">>) => {
      await persist(fixture, messages);
      return runAiExtractionStage(
        prisma,
        [{ conversationId: fixture.conversation, leadId: fixture.lead, messages: indexed(messages) }],
        [],
        { env: {}, provider }
      );
    };
    try {
      assert.equal((await run([HELLO, REPLY])).report.modelCalls, 1);
      assert.equal((await run([HELLO, REPLY])).report.cacheHits, 1);
      assert.equal(calls, 1);

      assert.equal((await run([HELLO, REPLY, CASH])).report.modelCalls, 1, "a changed transcript is analysed again");
      assert.equal(calls, 2);

      const back = await run([HELLO, REPLY]);
      assert.equal(back.report.cacheHits, 1, "returning to a known transcript reuses its extraction");
      assert.equal(calls, 2);
      assert.equal(await prisma.aiExtraction.count({ where: { conversationId: fixture.conversation } }), 2);
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: a conversation without messages is not sent to the model",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-NOAI");
    let calls = 0;
    const provider: AiExtractionProvider = {
      name: "fake",
      model: "fake-model",
      async extract(): Promise<AiExtractionProviderOutput> {
        calls += 1;
        return { raw: { ...extraction("HIGH"), evidence: {} } };
      }
    };
    try {
      await persist(fixture, []);
      const blank = indexed([msg("cliente", null, "   ")]);
      for (const messages of [[], blank]) {
        const { report, issues } = await runAiExtractionStage(
          prisma,
          [{ conversationId: fixture.conversation, leadId: fixture.lead, messages }],
          [],
          { env: {}, provider }
        );
        assert.equal(report.modelCalls, 0);
        assert.equal(report.skippedEmptyTranscript, 1);
        assert.deepEqual(issues, []);
      }
      assert.equal(calls, 0);
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: messages that differ only in what a model would not see share one transcript but are stored exactly",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("REC-CANON");
    try {
      await persist(fixture, [msg("cliente", "10:00", "Hola"), msg("asesor", "10:01", "Buenas")]);
      const hashBefore = (await prisma.conversation.findUniqueOrThrow({ where: { id: fixture.conversation } })).transcriptHash;

      // Same words for a reader; different bytes in the source.
      const variant = [msg("Cliente", "10:00", "Hola  "), msg("ASESOR", "10:01", " Buenas")];
      const { result } = await persist(fixture, variant);

      assert.deepEqual(await storedTranscript(fixture), indexed(variant), "the stored rows mirror the source exactly");
      assert.deepEqual(
        { added: result.messagesAdded, removed: result.messagesRemoved, changed: result.transcriptChanged },
        { added: 2, removed: 2, changed: true },
        "the rows did change, and that is reported"
      );
      const after = await prisma.conversation.findUniqueOrThrow({ where: { id: fixture.conversation } });
      assert.equal(after.transcriptHash, hashBefore, "it is the same transcript for a model");
      assert.equal(await prisma.conversationSnapshot.count({ where: { conversationId: fixture.conversation } }), 1);
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: a long conversation is reconciled without sending its whole id list to the database",
  { skip, timeout: 120_000 },
  async () => {
    const fixture = await createFixture("REC-LONG");
    try {
      const many = Array.from({ length: 5_000 }, (_, index) => msg(index % 2 === 0 ? "cliente" : "asesor", null, `mensaje ${index}`));
      const first = await persist(fixture, many);
      assert.equal(first.result.error, undefined);
      assert.equal(first.result.messagesAdded, 5_000);

      const again = await persist(fixture, many);
      assert.deepEqual({ added: again.result.messagesAdded, removed: again.result.messagesRemoved }, { added: 0, removed: 0 });

      const shorter = await persist(fixture, many.slice(0, 4_990));
      assert.equal(shorter.result.messagesRemoved, 10);
      assert.equal(await prisma.message.count({ where: { conversationId: fixture.conversation } }), 4_990);
    } finally {
      await removeFixture(fixture);
    }
  }
);
