import assert from "node:assert/strict";
import test from "node:test";
import { aiExtractionResultSchema } from "../src/lib/ai/schema";

function validExtraction(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    motorcycleInterest: "Bajaj Pulsar RS 200",
    budget: 15000000,
    downPayment: 3000000,
    paymentMethod: "CREDIT",
    purchaseIntent: "HIGH",
    mainObjection: "NONE",
    requestedAppointment: false,
    requestedQuote: true,
    confidence: 0.9,
    evidence: {
      motorcycleInterest: ["Estoy interesado en la Pulsar RS 200"],
      downPayment: ["Tengo 3 millones para la inicial"]
    },
    ...overrides
  };
}

test("valid extraction with all fields populated passes Zod validation", () => {
  const result = aiExtractionResultSchema.safeParse(validExtraction());
  assert.equal(result.success, true);
});

test("valid extraction with UNKNOWN/null for absent information passes Zod validation", () => {
  const result = aiExtractionResultSchema.safeParse(
    validExtraction({
      motorcycleInterest: null,
      budget: null,
      downPayment: null,
      paymentMethod: "UNKNOWN",
      purchaseIntent: "UNKNOWN",
      mainObjection: "UNKNOWN",
      requestedAppointment: false,
      requestedQuote: false,
      confidence: 0.2,
      evidence: {}
    })
  );
  assert.equal(result.success, true);
  if (result.success) {
    // Fields omitted from evidence default to an empty array, never undefined.
    assert.deepEqual(result.data.evidence.motorcycleInterest, []);
  }
});

test("malformed extraction (invalid enum value) fails Zod validation", () => {
  const result = aiExtractionResultSchema.safeParse(validExtraction({ purchaseIntent: "MAYBE" }));
  assert.equal(result.success, false);
});

test("malformed extraction (confidence out of 0..1 range) fails Zod validation", () => {
  const result = aiExtractionResultSchema.safeParse(validExtraction({ confidence: 1.5 }));
  assert.equal(result.success, false);
});

test("malformed extraction (missing required field) fails Zod validation", () => {
  const { requestedAppointment: _drop, ...withoutRequestedAppointment } = validExtraction();
  const result = aiExtractionResultSchema.safeParse(withoutRequestedAppointment);
  assert.equal(result.success, false);
});

test("malformed extraction (wrong type for budget) fails Zod validation", () => {
  const result = aiExtractionResultSchema.safeParse(validExtraction({ budget: "fifteen million" }));
  assert.equal(result.success, false);
});

test("evidence validation: non-string evidence excerpt fails", () => {
  const result = aiExtractionResultSchema.safeParse(
    validExtraction({ evidence: { motorcycleInterest: [123] } })
  );
  assert.equal(result.success, false);
});

test("evidence validation: empty evidence object is accepted (all fields default to [])", () => {
  const result = aiExtractionResultSchema.safeParse(validExtraction({ evidence: {} }));
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.evidence.budget, []);
    assert.deepEqual(result.data.evidence.purchaseIntent, []);
  }
});

test("evidence validation: missing evidence key entirely fails (evidence object itself is required)", () => {
  const { evidence: _drop, ...withoutEvidence } = validExtraction();
  const result = aiExtractionResultSchema.safeParse(withoutEvidence);
  assert.equal(result.success, false);
});
