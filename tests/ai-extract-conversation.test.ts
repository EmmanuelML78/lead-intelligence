import assert from "node:assert/strict";
import test from "node:test";
import { extractConversation } from "../src/lib/ai/extract-conversation";
import { AiProviderError, type AiExtractionProvider, type AiExtractionProviderInput, type AiExtractionProviderOutput } from "../src/lib/ai/provider";
import { buildCanonicalTranscript } from "../src/lib/ai/transcript";
import type { TranscriptMessage } from "../src/lib/ai/transcript";

const catalog = [
  { sku: "SKU-008", brand: "Bajaj", line: "Pulsar NS 125" },
  { sku: "SKU-009", brand: "Bajaj", line: "Pulsar NS 160" },
  { sku: "SKU-010", brand: "Bajaj", line: "Pulsar RS 200" },
  { sku: "SKU-013", brand: "Suzuki", line: "GN 125" }
];

const noSleep = async () => {};

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
    ...overrides
  };
}

class ScriptedProvider implements AiExtractionProvider {
  readonly name = "fake";
  readonly model = "fake-model-1";
  calls: AiExtractionProviderInput[] = [];
  private readonly steps: Array<() => Promise<AiExtractionProviderOutput>>;

  constructor(steps: Array<() => Promise<AiExtractionProviderOutput>>) {
    this.steps = steps;
  }

  async extract(input: AiExtractionProviderInput): Promise<AiExtractionProviderOutput> {
    this.calls.push(input);
    const step = this.steps[this.calls.length - 1];
    if (!step) throw new Error("ScriptedProvider ran out of steps");
    return step();
  }
}

function ok(raw: unknown): () => Promise<AiExtractionProviderOutput> {
  return async () => ({ raw });
}

function fail(error: Error): () => Promise<AiExtractionProviderOutput> {
  return async () => {
    throw error;
  };
}

const messages: TranscriptMessage[] = [
  { index: 0, sender: "cliente", sentTime: "16:55", text: "Hola buenas, me interesa la Bajaj Pulsar RS 200" },
  { index: 1, sender: "asesor", sentTime: "16:56", text: "Con gusto, ¿de contado o financiada?" }
];

test("valid provider response is returned on the first attempt (no retries)", async () => {
  const provider = new ScriptedProvider([ok(baseExtraction({ purchaseIntent: "MEDIUM" }))]);
  const result = await extractConversation({ messages, catalog, provider, sleep: noSleep });
  assert.equal(result.outcome, "success");
  assert.equal(provider.calls.length, 1);
  if (result.outcome === "success") {
    assert.equal(result.data.purchaseIntent, "MEDIUM");
    assert.equal(result.attempts, 1);
    assert.equal(result.provider, "fake");
    assert.equal(result.model, "fake-model-1");
  }
});

test("retryable provider error is retried and succeeds on a later attempt", async () => {
  const provider = new ScriptedProvider([
    fail(new AiProviderError("temporary 503", { retryable: true })),
    ok(baseExtraction())
  ]);
  const result = await extractConversation({ messages, catalog, provider, sleep: noSleep });
  assert.equal(result.outcome, "success");
  assert.equal(provider.calls.length, 2);
  if (result.outcome === "success") assert.equal(result.attempts, 2);
});

test("permanent (non-retryable) provider error fails immediately without exhausting the retry budget", async () => {
  const provider = new ScriptedProvider([fail(new AiProviderError("401 invalid API key", { retryable: false }))]);
  const result = await extractConversation({ messages, catalog, provider, maxAttempts: 5, sleep: noSleep });
  assert.equal(result.outcome, "provider_failed");
  assert.equal(provider.calls.length, 1, "must not retry a permanent error");
});

test("retryable provider error that never succeeds fails after the bounded retry budget", async () => {
  const provider = new ScriptedProvider([
    fail(new AiProviderError("timeout", { retryable: true })),
    fail(new AiProviderError("timeout", { retryable: true })),
    fail(new AiProviderError("timeout", { retryable: true }))
  ]);
  const result = await extractConversation({ messages, catalog, provider, maxAttempts: 3, sleep: noSleep });
  assert.equal(result.outcome, "provider_failed");
  assert.equal(provider.calls.length, 3, "bounded retries, not infinite");
});

test("malformed (schema-invalid) provider response is retried, then reported as validation_failed", async () => {
  const provider = new ScriptedProvider([
    ok({ purchaseIntent: "MAYBE_NOT_AN_ENUM_VALUE" }),
    ok({ purchaseIntent: "STILL_INVALID" })
  ]);
  const result = await extractConversation({ messages, catalog, provider, maxAttempts: 2, sleep: noSleep });
  assert.equal(result.outcome, "validation_failed");
  assert.equal(provider.calls.length, 2);
});

test("post-AI motorcycle resolution: exact catalog match resolves a SKU the LLM never invented", async () => {
  const provider = new ScriptedProvider([ok(baseExtraction({ motorcycleInterest: "Bajaj Pulsar RS 200" }))]);
  const result = await extractConversation({ messages, catalog, provider, sleep: noSleep });
  assert.equal(result.outcome, "success");
  if (result.outcome === "success") {
    assert.equal(result.data.motorcycleSku, "SKU-010");
    assert.equal(result.data.motorcycleMatchMethod, "exact");
  }
});

test("post-AI motorcycle resolution: ambiguous free text stays unresolved (never force-matched)", async () => {
  const provider = new ScriptedProvider([ok(baseExtraction({ motorcycleInterest: "Bajaj Pulsar" }))]);
  const result = await extractConversation({ messages, catalog, provider, sleep: noSleep });
  assert.equal(result.outcome, "success");
  if (result.outcome === "success") {
    assert.equal(result.data.motorcycleSku, null);
  }
});

test("customer statement overrides advisor proposal: transcript labels roles correctly for the model, and extraction pass-through is not overridden by extra business logic", async () => {
  const advisorThenCustomer: TranscriptMessage[] = [
    { index: 0, sender: "asesor", sentTime: "10:00", text: "Te puedo agendar una cita." },
    { index: 1, sender: "cliente", sentTime: "10:01", text: "No gracias, solo estoy mirando." }
  ];

  // The prompt sent to the model must clearly attribute each line to the
  // correct role so a well-behaved model can apply the customer-priority
  // rule (spec item 2) -- this is the part our code controls and can assert.
  const transcript = buildCanonicalTranscript(advisorThenCustomer);
  assert.equal(transcript, "[10:00] ADVISOR: Te puedo agendar una cita.\n[10:01] CUSTOMER: No gracias, solo estoy mirando.");

  // A correctly-behaving model (mocked here) resolves requestedAppointment/
  // purchaseIntent from the customer's decline, not the advisor's offer.
  // Assert our code passes that judgment through unchanged.
  const provider = new ScriptedProvider([
    ok(
      baseExtraction({
        requestedAppointment: false,
        purchaseIntent: "LOW",
        evidence: { requestedAppointment: ["No gracias, solo estoy mirando."] }
      })
    )
  ]);
  const result = await extractConversation({ messages: advisorThenCustomer, catalog, provider, sleep: noSleep });
  assert.equal(result.outcome, "success");
  if (result.outcome === "success") {
    assert.equal(result.data.requestedAppointment, false);
    assert.equal(result.data.purchaseIntent, "LOW");
  }
});
