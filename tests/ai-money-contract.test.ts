import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { AiExtractionProvider, AiExtractionProviderOutput } from "../src/lib/ai/provider";
import { aiExtractionJsonSchema, aiExtractionResultSchema, MAX_COP_AMOUNT } from "../src/lib/ai/schema";
import { runAiExtractionStage } from "../src/pipeline/ai-stage";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

function extractionWith(fields: Record<string, unknown>) {
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
    ...fields
  };
}

function parse(field: "budget" | "downPayment", value: unknown) {
  return aiExtractionResultSchema.safeParse(extractionWith({ [field]: value }));
}

function rejection(field: "budget" | "downPayment", value: unknown): string {
  const result = parse(field, value);
  assert.equal(result.success, false, `${String(value)} must be rejected for ${field}`);
  const issue = result.error!.issues[0]!;
  assert.deepEqual(issue.path, [field]);
  return issue.message;
}

test("the monetary limit of the contract is exactly what a PostgreSQL INTEGER column can hold", () => {
  assert.equal(MAX_COP_AMOUNT, POSTGRES_INTEGER_MAX);
});

test("whole peso amounts within the storable range are accepted unchanged", () => {
  for (const field of ["budget", "downPayment"] as const) {
    for (const value of [0, 1, 2_000_000, 8_500_000, 49_990_000, MAX_COP_AMOUNT]) {
      const result = parse(field, value);
      assert.equal(result.success, true, `${value} must be accepted for ${field}`);
      assert.equal(result.data![field], value);
    }
    assert.equal(parse(field, null).data![field], null, "an absent amount stays null");
  }
});

test("a JSON number written with a zero fraction is the same whole amount", () => {
  const fromJson = JSON.parse('{"budget": 8500000.0, "downPayment": 2.0e6}') as { budget: number; downPayment: number };
  const result = aiExtractionResultSchema.safeParse(extractionWith(fromJson));
  assert.equal(result.success, true);
  assert.equal(result.data!.budget, 8_500_000);
  assert.equal(result.data!.downPayment, 2_000_000);
});

test("negative zero is stored and compared as zero", () => {
  const result = parse("budget", JSON.parse("-0"));
  assert.equal(result.success, true);
  assert.ok(Object.is(result.data!.budget, 0), "must be +0, not -0");
});

test("fractional amounts are rejected, never rounded or truncated", () => {
  for (const field of ["budget", "downPayment"] as const) {
    for (const value of [8_500_000.5, 0.1, 1999999.999, 2_147_483_646.5]) {
      assert.match(rejection(field, value), /whole number of Colombian pesos/);
    }
  }
});

test("negative amounts are rejected", () => {
  for (const value of [-1, -8_500_000, -0.5]) {
    const message = rejection("budget", value);
    assert.ok(/must not be negative|whole number/.test(message), message);
  }
  assert.match(rejection("downPayment", -1), /must not be negative/);
});

test("amounts beyond what the column can store are rejected instead of overflowing", () => {
  for (const value of [MAX_COP_AMOUNT + 1, 3_000_000_000, 1e12, Number.MAX_SAFE_INTEGER]) {
    assert.match(rejection("budget", value), /must not exceed 2147483647 COP/);
    assert.match(rejection("downPayment", value), /must not exceed 2147483647 COP/);
  }
});

test("values that are not finite numbers are rejected", () => {
  for (const value of ["8500000", "8.500.000", "8 millones", true, [], {}, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE, 1e400]) {
    const result = parse("budget", value);
    assert.equal(result.success, false, `${String(value)} must be rejected`);
  }
  assert.match(rejection("budget", "8500000"), /not text/);
});

test("the schema sent to the provider asks for integers, matching the contract", () => {
  assert.deepEqual(aiExtractionJsonSchema.properties.budget, { type: "integer", nullable: true });
  assert.deepEqual(aiExtractionJsonSchema.properties.downPayment, { type: "integer", nullable: true });
});

test("an amount outside the contract never reaches the database and does not stop the stage", async () => {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    aiExtraction: {
      async findFirst() {
        return null;
      },
      async create(args: { data: Record<string, unknown> }) {
        created.push(args.data);
        return { id: `row-${created.length}`, ...args.data };
      }
    }
  } as unknown as PrismaClient;

  const answers: Record<string, unknown> = {
    "CONV-FRACTION": extractionWith({ budget: 8_500_000.75 }),
    "CONV-OVERFLOW": extractionWith({ downPayment: 5_000_000_000 }),
    "CONV-OK": extractionWith({ budget: 8_500_000, downPayment: MAX_COP_AMOUNT })
  };
  const provider: AiExtractionProvider = {
    name: "fake",
    model: "fake-model",
    async extract(input): Promise<AiExtractionProviderOutput> {
      const id = Object.keys(answers).find((key) => input.userPrompt.includes(key))!;
      return { raw: answers[id] };
    }
  };
  const conversations = Object.keys(answers).map((conversationId) => ({
    conversationId,
    leadId: `LD-${conversationId}`,
    messages: [{ index: 0, sender: "cliente", sentTime: null, text: `Hola ${conversationId}` }]
  }));

  const { report, issues } = await runAiExtractionStage(db, conversations, [], {
    env: { AI_CONCURRENCY: "1" },
    provider,
    retry: { backoffMs: 0 }
  });

  assert.equal(report.status, "COMPLETED");
  assert.equal(report.successes, 1);
  assert.equal(report.validationFailures, 2);
  assert.equal(created.length, 1, "only the valid extraction is stored");
  assert.equal(created[0]?.budget, 8_500_000);
  assert.equal(created[0]?.downPayment, MAX_COP_AMOUNT);

  const messages = issues.filter((issue) => issue.type === "AI_EXTRACTION_VALIDATION_FAILED").map((issue) => issue.message);
  assert.equal(messages.length, 2);
  assert.ok(messages.some((message) => /budget: must be a whole number of Colombian pesos/.test(message)));
  assert.ok(messages.some((message) => /downPayment: must not exceed 2147483647 COP/.test(message)));
});
