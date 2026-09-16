import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { AiProviderError, type AiExtractionProvider, type AiExtractionProviderInput, type AiExtractionProviderOutput } from "../src/lib/ai/provider";
import { createAiProviderFromEnv, runAiExtractionStage, type EligibleConversation } from "../src/pipeline/ai-stage";
import { findCachedExtraction, persistAiExtraction } from "../src/pipeline/persist/ai-extractions";
import { GeminiProvider } from "../src/lib/ai/providers/gemini";
import { AI_PROMPT_VERSION } from "../src/lib/ai/prompt";
import { conversationHash as conversationHashFor, type TranscriptMessage } from "../src/lib/ai/transcript";

/**
 * Minimal in-memory double for the two AiExtraction operations the AI
 * stage/persistence layer uses. Filters like a real unique-key lookup would
 * (conversationId + conversationHash + promptVersion + model), so these
 * tests exercise the actual cache-key logic in our code, not a stub that
 * always says "hit" or "miss".
 */
function createFakeDb() {
  type Row = {
    id: string;
    createdAt: Date;
    conversationId: string;
    conversationHash: string;
    promptVersion: string;
    model: string;
    extractionVersion: string;
    [key: string]: unknown;
  };
  const rows: Row[] = [];
  let counter = 0;

  const db = {
    aiExtraction: {
      async findFirst(args: { where: Record<string, unknown> }) {
        const where = args.where as Pick<
          Row,
          "conversationId" | "conversationHash" | "promptVersion" | "model" | "extractionVersion"
        >;
        const matches = rows
          .filter(
            (r) =>
              r.conversationId === where.conversationId &&
              r.conversationHash === where.conversationHash &&
              r.promptVersion === where.promptVersion &&
              r.model === where.model &&
              r.extractionVersion === where.extractionVersion
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matches[0] ?? null;
      },
      async create(args: { data: Record<string, unknown> }) {
        counter += 1;
        const row = { id: `fake_${counter}`, createdAt: new Date(Date.now() + counter), ...args.data } as Row;
        rows.push(row);
        return row;
      }
    }
  };

  return { db: db as unknown as PrismaClient, rows };
}

function baseExtraction(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    motorcycleInterest: null,
    budget: null,
    downPayment: null,
    paymentMethod: "UNKNOWN",
    purchaseIntent: "UNKNOWN",
    mainObjection: "UNKNOWN",
    requestedAppointment: false,
    requestedQuote: false,
    confidence: 0.5,
    evidence: {},
    motorcycleSku: null,
    motorcycleMatchConfidence: null,
    motorcycleMatchMethod: null,
    ...overrides
  };
}

class CountingProvider implements AiExtractionProvider {
  readonly name = "fake";
  callCount = 0;
  constructor(readonly model: string) {}
  async extract(_input: AiExtractionProviderInput): Promise<AiExtractionProviderOutput> {
    this.callCount += 1;
    return { raw: baseExtraction() };
  }
}

const messages: TranscriptMessage[] = [
  { index: 0, sender: "cliente", sentTime: "16:55", text: "Hola, me interesa la GN 125" },
  { index: 1, sender: "asesor", sentTime: "16:56", text: "Claro, ¿de contado o financiada?" }
];

const catalog = [{ sku: "SKU-013", brand: "Suzuki", line: "GN 125" }];

test("missing AI_API_KEY: stage reports SKIPPED, never throws, ingestion is unaffected", async () => {
  const { db } = createFakeDb();
  const eligible: EligibleConversation[] = [{ conversationId: "CONV-1", leadId: "LD-1", messages }];
  const { report, issues } = await runAiExtractionStage(db, eligible, catalog, { env: {} });
  assert.equal(report.status, "SKIPPED");
  assert.equal(report.skippedNoApiKey, 1);
  assert.equal(report.conversationsEligible, 1);
  assert.equal(issues.length, 0);
});

test("createAiProviderFromEnv returns null without an API key, a GeminiProvider with one", () => {
  assert.equal(createAiProviderFromEnv({}), null);
  const provider = createAiProviderFromEnv({ AI_API_KEY: "test-key" });
  assert.ok(provider instanceof GeminiProvider);
});

test("cache hit skips the provider call and does not insert a new AiExtraction row", async () => {
  const { db, rows } = createFakeDb();
  const provider = new CountingProvider("model-a");
  const eligible: EligibleConversation[] = [{ conversationId: "CONV-1", leadId: "LD-1", messages }];

  const first = await runAiExtractionStage(db, eligible, catalog, { env: {}, provider });
  assert.equal(first.report.modelCalls, 1);
  assert.equal(first.report.successes, 1);
  assert.equal(provider.callCount, 1);
  assert.equal(rows.length, 1);

  const second = await runAiExtractionStage(db, eligible, catalog, { env: {}, provider });
  assert.equal(second.report.cacheHits, 1);
  assert.equal(second.report.modelCalls, 0);
  assert.equal(provider.callCount, 1, "provider must not be called again on a cache hit");
  assert.equal(rows.length, 1, "no duplicate row for an unchanged conversation");
});

test("changed conversation content (different hash) is a cache miss and creates a new row", async () => {
  const { db, rows } = createFakeDb();
  const provider = new CountingProvider("model-a");
  const original: EligibleConversation = { conversationId: "CONV-1", leadId: "LD-1", messages };
  const changed: EligibleConversation = {
    conversationId: "CONV-1",
    leadId: "LD-1",
    messages: [...messages, { index: 2, sender: "cliente", sentTime: "16:59", text: "Ok gracias" }]
  };

  await runAiExtractionStage(db, [original], catalog, { env: {}, provider });
  const afterFirst = await runAiExtractionStage(db, [changed], catalog, { env: {}, provider });

  assert.equal(afterFirst.report.modelCalls, 1, "changed transcript must not be served from cache");
  assert.equal(provider.callCount, 2);
  assert.equal(rows.length, 2, "previous extraction history is preserved, not overwritten");
});

test("model change causes a new extraction (cache key includes model)", async () => {
  const { db, rows } = createFakeDb();
  const providerA = new CountingProvider("model-a");
  const providerB = new CountingProvider("model-b");
  const eligible: EligibleConversation[] = [{ conversationId: "CONV-1", leadId: "LD-1", messages }];

  await runAiExtractionStage(db, eligible, catalog, { env: {}, provider: providerA });
  const second = await runAiExtractionStage(db, eligible, catalog, { env: {}, provider: providerB });

  assert.equal(second.report.modelCalls, 1, "different model must not reuse the other model's cached extraction");
  assert.equal(rows.length, 2);
});

test("findCachedExtraction directly: promptVersion mismatch is a cache miss, match is a hit", async () => {
  const { db } = createFakeDb();
  await persistAiExtraction(db, {
    leadId: "LD-1",
    conversationId: "CONV-1",
    conversationHash: "hash-1",
    provider: "fake",
    model: "model-a",
    promptVersion: "v1",
    extractionVersion: "v1",
    data: baseExtraction() as never
  });

  const miss = await findCachedExtraction(db, {
    conversationId: "CONV-1",
    conversationHash: "hash-1",
    promptVersion: "v2",
    model: "model-a",
    extractionVersion: "v1"
  });
  assert.equal(miss, null);

  const hit = await findCachedExtraction(db, {
    conversationId: "CONV-1",
    conversationHash: "hash-1",
    promptVersion: "v1",
    model: "model-a",
    extractionVersion: "v1"
  });
  assert.ok(hit);
});

test("findCachedExtraction directly: extractionVersion mismatch is a cache miss even with identical transcript/prompt/model", async () => {
  // Milestone 3.1 cache-key review: a bump to AI_EXTRACTION_VERSION (the
  // extraction contract/shape changed) must invalidate previously cached
  // extractions, even when the conversation content, prompt wording, and
  // model are all unchanged -- otherwise a contract change would silently
  // serve data shaped for the old contract.
  const { db } = createFakeDb();
  await persistAiExtraction(db, {
    leadId: "LD-1",
    conversationId: "CONV-1",
    conversationHash: "hash-1",
    provider: "fake",
    model: "model-a",
    promptVersion: "v1",
    extractionVersion: "v1",
    data: baseExtraction() as never
  });

  const missOnVersionBump = await findCachedExtraction(db, {
    conversationId: "CONV-1",
    conversationHash: "hash-1",
    promptVersion: "v1",
    model: "model-a",
    extractionVersion: "v2"
  });
  assert.equal(missOnVersionBump, null);

  const hitOnSameVersion = await findCachedExtraction(db, {
    conversationId: "CONV-1",
    conversationHash: "hash-1",
    promptVersion: "v1",
    model: "model-a",
    extractionVersion: "v1"
  });
  assert.ok(hitOnSameVersion);
});

test("runAiExtractionStage end to end: extractionVersion bump forces a fresh model call and a new row, old row preserved", async () => {
  // Simulates AI_EXTRACTION_VERSION changing between two pipeline runs
  // (contract/shape change) with transcript, prompt version, and model held
  // constant -- the second run must not reuse the first run's cached row.
  const { db, rows } = createFakeDb();
  const eligible: EligibleConversation[] = [{ conversationId: "CONV-1", leadId: "LD-1", messages }];

  await persistAiExtraction(db, {
    leadId: "LD-1",
    conversationId: "CONV-1",
    conversationHash: conversationHashFor(messages),
    provider: "fake",
    model: "model-a",
    promptVersion: AI_PROMPT_VERSION,
    extractionVersion: "v0-old-contract",
    data: baseExtraction() as never
  });
  assert.equal(rows.length, 1);

  const provider = new CountingProvider("model-a");
  const { report } = await runAiExtractionStage(db, eligible, catalog, { env: {}, provider });

  assert.equal(report.modelCalls, 1, "current AI_EXTRACTION_VERSION must not match the old-contract cached row");
  assert.equal(report.cacheHits, 0);
  assert.equal(provider.callCount, 1);
  assert.equal(rows.length, 2, "old-contract row is preserved, not overwritten");
});

test("provider and validation failures are counted and recorded as PipelineIssue entries, not persisted as AiExtraction rows", async () => {
  const { db, rows } = createFakeDb();
  const failingProvider: AiExtractionProvider = {
    name: "fake",
    model: "model-a",
    async extract() {
      return { raw: { purchaseIntent: "NOT_VALID" } };
    }
  };
  const eligible: EligibleConversation[] = [{ conversationId: "CONV-1", leadId: "LD-1", messages }];

  const { report, issues } = await runAiExtractionStage(db, eligible, catalog, { env: {}, provider: failingProvider });
  assert.equal(report.validationFailures, 1);
  assert.equal(rows.length, 0, "malformed extraction is never persisted as valid data");
  assert.equal(issues[0]?.type, "AI_EXTRACTION_VALIDATION_FAILED");
});

test("AI_MAX_CONVERSATIONS defers remaining eligible conversations without calling the provider", async () => {
  const { db, rows } = createFakeDb();
  const provider = new CountingProvider("model-a");
  const eligible: EligibleConversation[] = [
    { conversationId: "CONV-1", leadId: "LD-1", messages },
    { conversationId: "CONV-2", leadId: "LD-2", messages },
    { conversationId: "CONV-3", leadId: "LD-3", messages }
  ];

  const { report } = await runAiExtractionStage(db, eligible, catalog, {
    env: { AI_MAX_CONVERSATIONS: "1", AI_CONCURRENCY: "1" },
    provider
  });

  assert.equal(report.conversationsEligible, 3);
  assert.equal(report.skippedDueToLimit, 2);
  assert.equal(report.modelCalls, 1);
  assert.equal(report.successes, 1);
  assert.equal(provider.callCount, 1);
  assert.equal(rows.length, 1);
});

test("quota/rate-limit provider errors stop remaining work instead of looping the batch", async () => {
  const { db, rows } = createFakeDb();
  const quotaProvider: AiExtractionProvider = {
    name: "fake",
    model: "model-a",
    async extract() {
      throw new AiProviderError("Gemini request failed with status 429: RESOURCE_EXHAUSTED quota", {
        retryable: false
      });
    }
  };
  const eligible: EligibleConversation[] = [
    { conversationId: "CONV-1", leadId: "LD-1", messages },
    { conversationId: "CONV-2", leadId: "LD-2", messages },
    { conversationId: "CONV-3", leadId: "LD-3", messages }
  ];

  const { report, issues } = await runAiExtractionStage(db, eligible, catalog, {
    env: { AI_CONCURRENCY: "1" },
    provider: quotaProvider
  });

  assert.equal(report.status, "STOPPED");
  assert.equal(report.providerFailures, 1);
  assert.equal(report.skippedDueToQuota, 2);
  assert.equal(report.modelCalls, 1);
  assert.equal(rows.length, 0);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.type, "AI_EXTRACTION_PROVIDER_FAILED");
});
