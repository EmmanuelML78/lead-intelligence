import assert from "node:assert/strict";
import test from "node:test";
import { issueFingerprint, messageId, sourceFingerprint } from "../src/pipeline/persist/fingerprint";

test("sourceFingerprint is deterministic and independent of key order", () => {
  const rowA = { lead_id: "LD-1", empresa_id: "EMP-01", telefono: "3001234567" };
  const rowB = { telefono: "3001234567", lead_id: "LD-1", empresa_id: "EMP-01" };
  assert.equal(sourceFingerprint(rowA), sourceFingerprint(rowB));
});

test("sourceFingerprint changes when content changes", () => {
  const before = sourceFingerprint({ lead_id: "LD-1", estado_gestion: "Sin gestión" });
  const after = sourceFingerprint({ lead_id: "LD-1", estado_gestion: "Contactado" });
  assert.notEqual(before, after);
});

test("sourceFingerprint is stable across repeated calls (rerun safety)", () => {
  const row = { lead_id: "LD-1", empresa_id: "EMP-01" };
  assert.equal(sourceFingerprint(row), sourceFingerprint({ ...row }));
});

test("messageId is deterministic for identical inputs and differs by index", () => {
  const base = { conversationId: "CONV-1", sender: "cliente", sentTime: "10:00", text: "hola" };
  const first = messageId({ ...base, index: 0 });
  const again = messageId({ ...base, index: 0 });
  const secondPosition = messageId({ ...base, index: 1 });
  assert.equal(first, again);
  assert.notEqual(first, secondPosition);
});

test("messageId differs across conversations even with identical text", () => {
  const a = messageId({ conversationId: "CONV-1", index: 0, sender: "cliente", sentTime: "10:00", text: "hola" });
  const b = messageId({ conversationId: "CONV-2", index: 0, sender: "cliente", sentTime: "10:00", text: "hola" });
  assert.notEqual(a, b);
});

test("issueFingerprint identifies the same issue independent of the pipeline run", () => {
  const a = issueFingerprint({ type: "MISSING_CITY", entityType: "Lead", entityId: "LD-1", field: "ciudad", rawValue: null });
  const b = issueFingerprint({ type: "MISSING_CITY", entityType: "Lead", entityId: "LD-1", field: "ciudad", rawValue: null });
  assert.equal(a, b);
});

test("issueFingerprint differs when the field or entity differs", () => {
  const missingCity = issueFingerprint({ type: "MISSING_CITY", entityType: "Lead", entityId: "LD-1", field: "ciudad" });
  const ambiguousDate = issueFingerprint({ type: "AMBIGUOUS_DATE", entityType: "Lead", entityId: "LD-1", field: "fecha_registro" });
  const otherLead = issueFingerprint({ type: "MISSING_CITY", entityType: "Lead", entityId: "LD-2", field: "ciudad" });
  assert.notEqual(missingCity, ambiguousDate);
  assert.notEqual(missingCity, otherLead);
});
