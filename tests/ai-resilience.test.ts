import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { extractConversation } from "../src/lib/ai/extract-conversation";
import {
  AiProviderError,
  type AiExtractionProvider,
  type AiExtractionProviderInput,
  type AiExtractionProviderOptions,
  type AiExtractionProviderOutput
} from "../src/lib/ai/provider";
import type { TranscriptMessage } from "../src/lib/ai/transcript";
import { runAiExtractionStage, type EligibleConversation } from "../src/pipeline/ai-stage";

// Simulated providers only: nothing here calls a real model.

const messages: TranscriptMessage[] = [
  { index: 0, sender: "cliente", sentTime: "16:55", text: "Hola, me interesa la GN 125" },
  { index: 1, sender: "asesor", sentTime: "16:56", text: "Claro, ¿de contado o financiada?" },
  { index: 2, sender: "cliente", sentTime: "17:01", text: "De contado, tengo 8 millones" }
];

function valid(overrides: Record<string, unknown> = {}) {
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
    ...overrides
  };
}

type Step = { raw: unknown } | { error: Error };

/** Answers each call with the next scripted step; the last step repeats. */
function scriptedProvider(steps: Step[]) {
  const signals: Array<AbortSignal | undefined> = [];
  const provider: AiExtractionProvider & { calls: number } = {
    name: "fake",
    model: "fake-model",
    calls: 0,
    async extract(_input: AiExtractionProviderInput, options?: AiExtractionProviderOptions): Promise<AiExtractionProviderOutput> {
      const step = steps[Math.min(provider.calls, steps.length - 1)]!;
      provider.calls += 1;
      signals.push(options?.signal);
      if ("error" in step) throw step.error;
      return { raw: step.raw };
    }
  };
  return { provider, signals };
}

const transient = (status = 503, retryAfterMs?: number) =>
  new AiProviderError(`status ${status}`, { retryable: true, kind: "http", status, retryAfterMs });
const permanent = () => new AiProviderError("status 401", { retryable: false, kind: "http", status: 401 });

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

// --- retry policy -----------------------------------------------------------

test("transient provider failures are retried with exponential backoff and bounded jitter", async () => {
  const { provider } = scriptedProvider([{ error: transient() }, { error: transient() }, { raw: valid() }]);
  const { waits, sleep } = recordingSleep();
  const result = await extractConversation({ messages, catalog: [], provider, sleep, backoffMs: 500, random: () => 0.5 });
  assert.equal(result.outcome, "success");
  assert.equal(provider.calls, 3);
  assert.deepEqual(waits, [500, 1000], "with neutral jitter the wait doubles");

  for (const [random, expected] of [[0, [400, 800]], [1, [600, 1200]]] as const) {
    const again = scriptedProvider([{ error: transient() }, { error: transient() }, { raw: valid() }]);
    const recorded = recordingSleep();
    await extractConversation({ messages, catalog: [], provider: again.provider, sleep: recorded.sleep, backoffMs: 500, random: () => random });
    assert.deepEqual(recorded.waits, expected, "jitter stays within 20% of the base wait");
  }
});

test("the backoff is capped", async () => {
  const { provider } = scriptedProvider([{ error: transient() }]);
  const { waits, sleep } = recordingSleep();
  await extractConversation({ messages, catalog: [], provider, sleep, maxAttempts: 6, backoffMs: 1000, maxBackoffMs: 3000, random: () => 0.5 });
  assert.deepEqual(waits, [1000, 2000, 3000, 3000, 3000]);
});

test("the call budget is a hard limit: a failure that never clears stops after maxAttempts", async () => {
  const { provider } = scriptedProvider([{ error: transient() }]);
  const result = await extractConversation({ messages, catalog: [], provider, sleep: recordingSleep().sleep, maxAttempts: 3 });
  assert.equal(result.outcome, "provider_failed");
  assert.equal(provider.calls, 3);
  assert.equal(result.attempts, 3);
});

test("a permanent provider failure is not retried", async () => {
  const { provider } = scriptedProvider([{ error: permanent() }]);
  const { waits, sleep } = recordingSleep();
  const result = await extractConversation({ messages, catalog: [], provider, sleep, maxAttempts: 5 });
  assert.equal(result.outcome, "provider_failed");
  assert.equal(provider.calls, 1);
  assert.deepEqual(waits, []);
});

test("the wait requested by the provider is honored when it is longer than the backoff", async () => {
  const { provider } = scriptedProvider([{ error: transient(429, 4_000) }, { raw: valid() }]);
  const { waits, sleep } = recordingSleep();
  const result = await extractConversation({ messages, catalog: [], provider, sleep, backoffMs: 500, random: () => 0.5 });
  assert.equal(result.outcome, "success");
  assert.deepEqual(waits, [4_000]);
});

test("a provider asking to wait longer than the run allows fails the conversation at once, flagged as rate limited", async () => {
  const { provider } = scriptedProvider([{ error: transient(429, 120_000) }]);
  const { waits, sleep } = recordingSleep();
  const result = await extractConversation({ messages, catalog: [], provider, sleep, maxRetryAfterMs: 20_000 });
  assert.equal(result.outcome, "provider_failed");
  assert.equal(provider.calls, 1, "no second request is sent");
  assert.deepEqual(waits, [], "and nobody waits two minutes");
  assert.ok(result.outcome === "provider_failed" && result.rateLimited);
  assert.match(result.outcome === "provider_failed" ? result.message : "", /asked to wait 120 s/);
});

test("output that fails validation is retried once, not for the whole call budget", async () => {
  const { provider } = scriptedProvider([{ raw: { nonsense: true } }]);
  const result = await extractConversation({ messages, catalog: [], provider, sleep: recordingSleep().sleep, maxAttempts: 5 });
  assert.equal(result.outcome, "validation_failed");
  assert.equal(provider.calls, 2, "a deterministic request is unlikely to answer differently a third time");
});

test("validation retries and transient retries share one call budget", async () => {
  const { provider } = scriptedProvider([{ error: transient() }, { raw: { nonsense: true } }, { raw: { nonsense: true } }, { raw: valid() }]);
  const result = await extractConversation({ messages, catalog: [], provider, sleep: recordingSleep().sleep, maxAttempts: 3 });
  assert.equal(result.outcome, "validation_failed");
  assert.equal(provider.calls, 3);
});

// --- cancellation -----------------------------------------------------------

test("cancelling during the wait between attempts stops at once and sends no further request", async () => {
  const controller = new AbortController();
  const { provider } = scriptedProvider([{ error: transient() }, { raw: valid() }]);
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 50);
  const result = await extractConversation({ messages, catalog: [], provider, signal: controller.signal, backoffMs: 60_000, random: () => 0.5 });
  assert.equal(result.outcome, "cancelled");
  assert.equal(provider.calls, 1);
  assert.ok(Date.now() - startedAt < 5_000, "the 60 s wait was interrupted");
});

test("the cancellation signal reaches the provider, and a cancelled request is not a provider failure", async () => {
  const controller = new AbortController();
  const provider: AiExtractionProvider = {
    name: "fake",
    model: "fake-model",
    extract: (_input, options) =>
      new Promise<AiExtractionProviderOutput>((_, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new AiProviderError("cancelled", { retryable: false, kind: "cancelled" })),
          { once: true }
        );
      })
  };
  setTimeout(() => controller.abort(), 30);
  const result = await extractConversation({ messages, catalog: [], provider, signal: controller.signal });
  assert.equal(result.outcome, "cancelled");
});

test("an extraction cancelled before it starts makes no call", async () => {
  const { provider } = scriptedProvider([{ raw: valid() }]);
  const result = await extractConversation({ messages, catalog: [], provider, signal: AbortSignal.abort() });
  assert.equal(result.outcome, "cancelled");
  assert.equal(provider.calls, 0);
});

// --- evidence ---------------------------------------------------------------

test("evidence that is not in the transcript is removed from the result; the extracted values stay", async () => {
  const { provider } = scriptedProvider([
    {
      raw: valid({
        budget: 8_000_000,
        paymentMethod: "CASH",
        evidence: {
          budget: ["tengo 8 millones", "mi presupuesto es de 8 millones exactos"],
          paymentMethod: ["De contado"],
          purchaseIntent: ["la compro mañana"]
        }
      })
    }
  ]);
  const result = await extractConversation({ messages, catalog: [], provider });
  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") return;
  assert.equal(result.data.budget, 8_000_000);
  assert.equal(result.data.paymentMethod, "CASH");
  assert.deepEqual(result.data.evidence.budget, ["tengo 8 millones"]);
  assert.deepEqual(result.data.evidence.paymentMethod, ["De contado"]);
  assert.deepEqual(result.data.evidence.purchaseIntent, []);
  assert.deepEqual(result.evidenceDropped, [
    { field: "budget", excerpt: "mi presupuesto es de 8 millones exactos" },
    { field: "purchaseIntent", excerpt: "la compro mañana" }
  ]);
  assert.equal(provider.calls, 1, "unsupported evidence does not cost another request");
});

// --- the stage isolates each conversation -----------------------------------

function fakeDb(behavior: { failLookupFor?: string; failCreateFor?: string } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    aiExtraction: {
      async findFirst(args: { where: { conversationId: string } }) {
        if (args.where.conversationId === behavior.failLookupFor) throw new Error("connection reset while reading");
        return null;
      },
      async create(args: { data: Record<string, unknown> }) {
        if (args.data.conversationId === behavior.failCreateFor) throw new Error("value out of range for type integer");
        rows.push(args.data);
        return { id: `row-${rows.length}`, ...args.data };
      }
    }
  };
  return { db: db as unknown as PrismaClient, rows };
}

function conversations(ids: string[]): EligibleConversation[] {
  return ids.map((conversationId) => ({
    conversationId,
    leadId: `LD-${conversationId}`,
    messages: [{ index: 0, sender: "cliente", sentTime: null, text: `Hola, soy ${conversationId}` }]
  }));
}

test("a database error while storing one extraction does not stop the others or the stage", async () => {
  const { db, rows } = fakeDb({ failCreateFor: "CONV-2" });
  const { provider } = scriptedProvider([{ raw: valid() }]);
  const { report, issues } = await runAiExtractionStage(db, conversations(["CONV-1", "CONV-2", "CONV-3", "CONV-4"]), [], {
    env: { AI_CONCURRENCY: "2" },
    provider
  });

  assert.equal(report.status, "COMPLETED");
  assert.equal(report.successes, 3);
  assert.equal(report.storeFailures, 1);
  assert.deepEqual(rows.map((row) => row.conversationId).sort(), ["CONV-1", "CONV-3", "CONV-4"]);
  const failure = issues.find((issue) => issue.type === "AI_EXTRACTION_STORE_FAILED");
  assert.equal(failure?.entityId, "CONV-2");
  assert.match(failure?.message ?? "", /could not be stored: value out of range/);
});

test("a database error while looking up the cache skips that conversation without calling the model", async () => {
  const { db, rows } = fakeDb({ failLookupFor: "CONV-2" });
  const { provider } = scriptedProvider([{ raw: valid() }]);
  const { report, issues } = await runAiExtractionStage(db, conversations(["CONV-1", "CONV-2", "CONV-3"]), [], {
    env: { AI_CONCURRENCY: "1" },
    provider
  });
  assert.equal(report.storeFailures, 1);
  assert.equal(report.modelCalls, 2, "no paid call without knowing whether it is needed");
  assert.equal(provider.calls, 2);
  assert.equal(rows.length, 2);
  assert.equal(issues[0]?.type, "AI_EXTRACTION_STORE_FAILED");
});

test("a provider that fails for every conversation leaves the stage completed, with nothing stored", async () => {
  const { db, rows } = fakeDb();
  const { provider } = scriptedProvider([{ error: permanent() }]);
  const { report, issues } = await runAiExtractionStage(db, conversations(["CONV-1", "CONV-2", "CONV-3"]), [], { env: {}, provider });
  assert.equal(report.status, "COMPLETED");
  assert.equal(report.providerFailures, 3);
  assert.equal(report.successes, 0);
  assert.equal(rows.length, 0);
  assert.equal(issues.length, 3);
});

test("a provider that throws something unexpected is contained per conversation", async () => {
  const { db } = fakeDb();
  let calls = 0;
  const provider: AiExtractionProvider = {
    name: "fake",
    model: "fake-model",
    async extract() {
      calls += 1;
      throw new TypeError("Cannot read properties of undefined");
    }
  };
  const { report } = await runAiExtractionStage(db, conversations(["CONV-1", "CONV-2"]), [], {
    env: { AI_CONCURRENCY: "1" },
    provider,
    retry: { backoffMs: 0 }
  });
  assert.equal(report.status, "COMPLETED");
  assert.equal(report.providerFailures, 2);
  assert.ok(calls >= 2);
});

test("a rate limit stops the stage and cancels the requests still in flight", async () => {
  const { db, rows } = fakeDb();
  const aborted: string[] = [];
  let started = 0;
  const provider: AiExtractionProvider = {
    name: "fake",
    model: "fake-model",
    extract(input, options) {
      started += 1;
      const id = /CONV-\d+/.exec(input.userPrompt)![0];
      if (id === "CONV-1") {
        // Fails once the other workers are waiting on their own requests.
        return new Promise<AiExtractionProviderOutput>((_, reject) =>
          setTimeout(() => reject(new AiProviderError("status 429: RESOURCE_EXHAUSTED", { retryable: true, kind: "http", status: 429, retryAfterMs: 3_600_000 })), 40)
        );
      }
      return new Promise<AiExtractionProviderOutput>((_, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => {
            aborted.push(id);
            reject(new AiProviderError("cancelled", { retryable: false, kind: "cancelled" }));
          },
          { once: true }
        );
      });
    }
  };

  const { report, issues } = await runAiExtractionStage(db, conversations(["CONV-1", "CONV-2", "CONV-3", "CONV-4", "CONV-5", "CONV-6"]), [], {
    env: { AI_CONCURRENCY: "3" },
    provider
  });

  assert.equal(report.status, "STOPPED");
  assert.match(report.reason ?? "", /quota\/rate-limit/);
  assert.equal(started, 3, "only the three requests already in flight were ever sent");
  assert.deepEqual(aborted.sort(), ["CONV-2", "CONV-3"], "the two requests in flight were cancelled");
  assert.equal(report.providerFailures, 1);
  assert.equal(report.skippedDueToQuota, 5, "two cancelled in flight and three never started");
  assert.equal(report.skippedDueToCancellation, 0);
  assert.equal(
    report.successes + report.providerFailures + report.validationFailures + report.storeFailures + report.cacheHits +
      report.skippedDueToQuota + report.skippedDueToCancellation + report.skippedEmptyTranscript,
    6,
    "every conversation is accounted for exactly once"
  );
  assert.equal(rows.length, 0);
  assert.equal(issues.length, 1, "cancelled conversations are not reported as failures");
});

test("the stage can be cancelled from outside", async () => {
  const { db } = fakeDb();
  const controller = new AbortController();
  const provider: AiExtractionProvider = {
    name: "fake",
    model: "fake-model",
    extract: (_input, options) =>
      new Promise<AiExtractionProviderOutput>((_, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new AiProviderError("cancelled", { retryable: false, kind: "cancelled" })),
          { once: true }
        );
      })
  };
  setTimeout(() => controller.abort(), 40);
  const { report, issues } = await runAiExtractionStage(db, conversations(["CONV-1", "CONV-2", "CONV-3"]), [], {
    env: { AI_CONCURRENCY: "2" },
    provider,
    signal: controller.signal
  });
  assert.equal(report.status, "STOPPED");
  assert.match(report.reason ?? "", /Cancelled/);
  assert.equal(report.skippedDueToCancellation, 3);
  assert.equal(report.skippedDueToQuota, 0, "a cancellation is not reported as a quota problem");
  assert.deepEqual(issues, []);
});

test("evidence the transcript does not support is reported per conversation and left out of what is stored", async () => {
  const { db, rows } = fakeDb();
  const { provider } = scriptedProvider([
    { raw: valid({ purchaseIntent: "HIGH", evidence: { purchaseIntent: ["Hola, soy CONV-1", "la quiero ya mismo"] } }) }
  ]);
  const { report, issues } = await runAiExtractionStage(db, conversations(["CONV-1"]), [], { env: {}, provider });
  assert.equal(report.successes, 1);
  assert.equal(report.evidenceExcerptsDropped, 1);
  assert.deepEqual((rows[0]?.evidence as { purchaseIntent: string[] }).purchaseIntent, ["Hola, soy CONV-1"]);
  assert.equal(rows[0]?.purchaseIntent, "HIGH", "the value itself is kept");
  const issue = issues.find((entry) => entry.type === "AI_EVIDENCE_NOT_IN_TRANSCRIPT");
  assert.equal(issue?.entityId, "CONV-1");
  assert.match(issue?.message ?? "", /1 evidence excerpt\(s\) that do not appear in the transcript \(fields: purchaseIntent\)/);
});

test("without an API key the stage is skipped and reports every conversation as not analysed", async () => {
  const { db, rows } = fakeDb();
  const { report, issues } = await runAiExtractionStage(db, conversations(["CONV-1", "CONV-2"]), [], { env: {} });
  assert.equal(report.status, "SKIPPED");
  assert.equal(report.skippedNoApiKey, 2);
  assert.equal(report.modelCalls, 0);
  assert.deepEqual(issues, []);
  assert.equal(rows.length, 0);
});

test("a server error that merely mentions quotas does not stop the stage; only a real rate limit does", async () => {
  const { db, rows } = fakeDb();
  let calls = 0;
  const provider: AiExtractionProvider = {
    name: "fake",
    model: "fake-model",
    async extract(input) {
      calls += 1;
      if (input.userPrompt.includes("CONV-1")) {
        throw new AiProviderError("status 500: internal error while checking quota for rate-limit 429", { retryable: false, kind: "http", status: 500 });
      }
      if (input.userPrompt.includes("CONV-2")) {
        throw new AiProviderError("status 400: quota project not set", { retryable: false, kind: "http", status: 400 });
      }
      return { raw: valid() };
    }
  };
  const { report } = await runAiExtractionStage(db, conversations(["CONV-1", "CONV-2", "CONV-3", "CONV-4"]), [], {
    env: { AI_CONCURRENCY: "1" },
    provider
  });
  assert.equal(report.status, "COMPLETED");
  assert.equal(report.providerFailures, 2);
  assert.equal(report.successes, 2, "the conversations after the failures are still processed");
  assert.equal(report.skippedDueToQuota, 0);
  assert.equal(rows.length, 2);
  assert.equal(calls, 4);
});

test("a failure without an HTTP status is judged by its text, as before", async () => {
  const { db } = fakeDb();
  const provider: AiExtractionProvider = {
    name: "fake",
    model: "fake-model",
    async extract() {
      throw new AiProviderError("Gemini request failed with status 429: RESOURCE_EXHAUSTED quota", { retryable: false });
    }
  };
  const { report } = await runAiExtractionStage(db, conversations(["CONV-1", "CONV-2", "CONV-3"]), [], {
    env: { AI_CONCURRENCY: "1" },
    provider
  });
  assert.equal(report.status, "STOPPED");
  assert.equal(report.providerFailures, 1);
  assert.equal(report.skippedDueToQuota, 2);
});
