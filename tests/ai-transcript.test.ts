import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalTranscript, conversationHash, resolveTranscriptRole } from "../src/lib/ai/transcript";
import type { TranscriptMessage } from "../src/lib/ai/transcript";

const baseMessages: TranscriptMessage[] = [
  { index: 0, sender: "cliente", sentTime: "16:55", text: "Hola, estoy interesado en la Pulsar RS 200" },
  { index: 1, sender: "asesor", sentTime: "16:56", text: "Claro, con gusto le ayudo" },
  { index: 2, sender: "cliente", sentTime: "16:58", text: "Tengo 3 millones para cuota inicial" }
];

test("resolves cliente/asesor to CUSTOMER/ADVISOR, unknown sender to UNKNOWN", () => {
  assert.equal(resolveTranscriptRole("cliente"), "CUSTOMER");
  assert.equal(resolveTranscriptRole("Cliente"), "CUSTOMER");
  assert.equal(resolveTranscriptRole("asesor"), "ADVISOR");
  assert.equal(resolveTranscriptRole("bot"), "UNKNOWN");
});

test("canonical transcript renders role, time, and text in order, without database ids", () => {
  const transcript = buildCanonicalTranscript(baseMessages);
  assert.equal(
    transcript,
    [
      "[16:55] CUSTOMER: Hola, estoy interesado en la Pulsar RS 200",
      "[16:56] ADVISOR: Claro, con gusto le ayudo",
      "[16:58] CUSTOMER: Tengo 3 millones para cuota inicial"
    ].join("\n")
  );
});

test("canonical transcript is stable across repeated calls and independent of input array order (sorted by index)", () => {
  const shuffled = [baseMessages[2]!, baseMessages[0]!, baseMessages[1]!];
  const a = buildCanonicalTranscript(baseMessages);
  const b = buildCanonicalTranscript(shuffled);
  const c = buildCanonicalTranscript(baseMessages);
  assert.equal(a, b);
  assert.equal(a, c);
});

test("conversation hash is deterministic for identical content", () => {
  const h1 = conversationHash(baseMessages);
  const h2 = conversationHash([...baseMessages]);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64, "sha256 hex digest");
});

test("conversation hash changes when message text changes", () => {
  const changed: TranscriptMessage[] = [
    baseMessages[0]!,
    baseMessages[1]!,
    { ...baseMessages[2]!, text: "Tengo 5 millones para cuota inicial" }
  ];
  assert.notEqual(conversationHash(baseMessages), conversationHash(changed));
});

test("conversation hash changes when message order changes", () => {
  const reordered: TranscriptMessage[] = [
    { ...baseMessages[0]!, index: 1 },
    { ...baseMessages[1]!, index: 0 },
    baseMessages[2]!
  ];
  assert.notEqual(conversationHash(baseMessages), conversationHash(reordered));
});

test("conversation hash changes when a message is added or removed", () => {
  const extended = [...baseMessages, { index: 3, sender: "asesor", sentTime: "17:00", text: "Quedo atento" }];
  assert.notEqual(conversationHash(baseMessages), conversationHash(extended));
});
