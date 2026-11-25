import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeForEvidence, verifyEvidence } from "../src/lib/ai/evidence";
import type { TranscriptMessage } from "../src/lib/ai/transcript";

const messages: TranscriptMessage[] = [
  { index: 0, sender: "cliente", sentTime: "07:24", text: "Qué más pues, me interesa la Hero Eco Deluxe 100" },
  { index: 1, sender: "asesor", sentTime: "07:35", text: "¡Hola! La Hero Eco Deluxe 100 está en $4.990.000 más matrícula y SOAT. ¿De contado o financiada?" },
  { index: 2, sender: "cliente", sentTime: "08:08", text: "Financiada, tengo 2,0 millones para la inicial" },
  { index: 3, sender: "cliente", sentTime: "08:20", text: "La quiero en color rojo, modelo 1250" }
];

function dropped(evidence: Record<string, string[]>): string[] {
  return verifyEvidence(evidence, messages).dropped.map((entry) => entry.excerpt);
}

test("normalization ignores case, accents, punctuation and spacing, and nothing else", () => {
  assert.equal(normalizeForEvidence("  ¿De CONTADO,  o   financiada?  "), "de contado o financiada");
  assert.equal(normalizeForEvidence("Qué más pues"), "que mas pues");
  assert.equal(normalizeForEvidence("$4.990.000"), normalizeForEvidence("4.990.000"), "the currency sign is presentation");
  assert.notEqual(normalizeForEvidence("4.990.000"), normalizeForEvidence("4 990 000"), "a number keeps its separators");
  assert.notEqual(normalizeForEvidence("año"), normalizeForEvidence("ano"), "ñ is a different letter, not an accent");
  assert.equal(normalizeForEvidence("¡¿...?!"), "");
});

test("excerpts copied from the conversation are kept, however they are cased or punctuated", () => {
  const evidence = {
    motorcycleInterest: ["me interesa la Hero Eco Deluxe 100"],
    downPayment: ["tengo 2,0 millones para la inicial", "TENGO 2,0 MILLONES PARA LA INICIAL", "tengo 2,0 millones... inicial"],
    paymentMethod: ["Financiada", "financiada,"],
    budget: ["Que mas pues"]
  };
  const result = verifyEvidence(evidence, messages);
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(result.evidence, evidence, "kept excerpts are stored exactly as the model wrote them");
});

test("quotes that are not in the conversation are dropped and reported with their field", () => {
  const result = verifyEvidence(
    {
      budget: ["tengo 20 millones de presupuesto"],
      downPayment: ["tengo 2,0 millones para la inicial", "tengo 3,0 millones para la inicial"],
      purchaseIntent: ["la compro hoy mismo"]
    },
    messages
  );
  assert.deepEqual(result.dropped, [
    { field: "budget", excerpt: "tengo 20 millones de presupuesto" },
    { field: "downPayment", excerpt: "tengo 3,0 millones para la inicial" },
    { field: "purchaseIntent", excerpt: "la compro hoy mismo" }
  ]);
  assert.deepEqual(result.evidence, {
    budget: [],
    downPayment: ["tengo 2,0 millones para la inicial"],
    purchaseIntent: []
  });
});

test("matching is by whole words: part of a number or of a word is not a quote", () => {
  assert.deepEqual(dropped({ motorcycleInterest: ["modelo 125"] }), ["modelo 125"]);
  assert.deepEqual(dropped({ motorcycleInterest: ["modelo 1250"] }), []);
  assert.deepEqual(dropped({ paymentMethod: ["financia"] }), ["financia"]);
});

test("the words must come from one message, in order", () => {
  assert.deepEqual(dropped({ downPayment: ["Financiada La quiero en color rojo"] }), ["Financiada La quiero en color rojo"]);
  assert.deepEqual(dropped({ downPayment: ["para la inicial tengo 2,0 millones"] }), ["para la inicial tengo 2,0 millones"]);
  assert.deepEqual(dropped({ downPayment: ["inicial... tengo 2,0 millones"] }), ["inicial... tengo 2,0 millones"], "an ellipsis does not reorder");
});

test("an excerpt with no words is not evidence", () => {
  assert.deepEqual(dropped({ budget: ["...", "?!", "…"] }), ["...", "?!", "…"]);
});

test("a conversation without messages supports no evidence", () => {
  const result = verifyEvidence({ budget: ["tengo 8 millones"] }, []);
  assert.equal(result.dropped.length, 1);
  assert.deepEqual(result.evidence, { budget: [] });
});

test("every hand-curated excerpt of the evaluation fixture is found in its own transcript", () => {
  type Case = {
    conversationId: string;
    messages: Array<{ emisor: string; hora?: string; texto: string }>;
    expected: { evidence: Record<string, string[]> };
  };
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "eval", "conversation-extraction-eval.json");
  const { cases } = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: Case[] };

  let excerpts = 0;
  for (const item of cases) {
    const transcript = item.messages.map((message, index) => ({
      index,
      sender: message.emisor,
      sentTime: message.hora ?? null,
      text: message.texto
    }));
    const result = verifyEvidence(item.expected.evidence, transcript);
    excerpts += Object.values(item.expected.evidence).flat().length;
    assert.deepEqual(result.dropped, [], `${item.conversationId}: a human-verified quote was rejected`);
  }
  assert.ok(excerpts >= 60, `expected the fixture to exercise the matcher, found ${excerpts} excerpts`);
});

test("a number is one word with its separators: part of an amount is not a quote of it", () => {
  const amounts: TranscriptMessage[] = [
    { index: 0, sender: "cliente", sentTime: null, text: "tengo 2.500.000 ahorrados y puedo dar 2,5 millones de inicial" }
  ];
  const result = verifyEvidence(
    {
      budget: ["tengo 2.500.000 ahorrados", "500.000", "tengo 2.500", "2.500.000"],
      downPayment: ["2,5 millones de inicial", "5 millones de inicial", "puedo dar 2"]
    },
    amounts
  );
  assert.deepEqual(result.evidence, {
    budget: ["tengo 2.500.000 ahorrados", "2.500.000"],
    downPayment: ["2,5 millones de inicial"]
  });
  assert.deepEqual(
    result.dropped.map((entry) => entry.excerpt),
    ["500.000", "tengo 2.500", "5 millones de inicial", "puedo dar 2"]
  );
});

test("a different spelling of the same amount is not treated as a quote", () => {
  const spelled: TranscriptMessage[] = [{ index: 0, sender: "cliente", sentTime: null, text: "mi presupuesto es 8.500.000" }];
  assert.equal(verifyEvidence({ budget: ["8500000"] }, spelled).dropped.length, 1);
  assert.equal(verifyEvidence({ budget: ["8.500.000"] }, spelled).dropped.length, 0);
});

test("ñ is not interchangeable with n", () => {
  const year: TranscriptMessage[] = [{ index: 0, sender: "cliente", sentTime: null, text: "La compro este año" }];
  assert.equal(verifyEvidence({ purchaseIntent: ["este ano"] }, year).dropped.length, 1);
  assert.equal(verifyEvidence({ purchaseIntent: ["este año", "ESTE AÑO"] }, year).dropped.length, 0);
});

test("a quote may carry the role label and time the transcript shows before the message", () => {
  const result = verifyEvidence(
    {
      paymentMethod: ["CUSTOMER: Financiada, tengo 2,0 millones para la inicial", "[08:08] CUSTOMER: Financiada"],
      purchaseIntent: ["ADVISOR: Financiada"]
    },
    messages
  );
  assert.deepEqual(result.dropped, [], "the label is the transcript's, not part of what was said");
});
