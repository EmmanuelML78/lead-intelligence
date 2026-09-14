import assert from "node:assert/strict";
import test from "node:test";
import { buildLeadRecord } from "../src/pipeline/persist/build-lead-record";
import type { RawLead } from "../src/pipeline/types";

const catalog = [
  { sku: "SKU-008", brand: "Bajaj", line: "Pulsar NS 125" },
  { sku: "SKU-009", brand: "Bajaj", line: "Pulsar NS 160" },
  { sku: "SKU-010", brand: "Bajaj", line: "Pulsar RS 200" },
  { sku: "SKU-013", brand: "Suzuki", line: "GN 125" }
];

function row(overrides: Partial<RawLead>): RawLead {
  return {
    lead_id: "LD-1",
    fecha_registro: "2026-08-25",
    canal: "WhatsApp",
    empresa_id: "EMP-01",
    punto_venta_id: "PV-001",
    nombre_cliente: "Test",
    telefono: "3001234567",
    email: "",
    ciudad: "Bogota",
    modelo_interes_texto: "",
    estado_gestion: "Sin gestión",
    fecha_primer_contacto: "",
    campania: "",
    ...overrides
  };
}

test("missing motorcycle interest -> MISSING_MOTORCYCLE_INTEREST, never UNRESOLVED_MOTORCYCLE", () => {
  const { record, issues } = buildLeadRecord(row({ modelo_interes_texto: "" }), catalog);
  assert.equal(record.motorcycleSku, null);
  const types = issues.map((i) => i.type);
  assert.ok(types.includes("MISSING_MOTORCYCLE_INTEREST"));
  assert.ok(!types.includes("UNRESOLVED_MOTORCYCLE"));
  const issue = issues.find((i) => i.type === "MISSING_MOTORCYCLE_INTEREST");
  assert.equal(issue?.severity, "INFO");
});

test("whitespace-only motorcycle interest is treated as missing, not unresolved", () => {
  const { issues } = buildLeadRecord(row({ modelo_interes_texto: "   " }), catalog);
  const types = issues.map((i) => i.type);
  assert.ok(types.includes("MISSING_MOTORCYCLE_INTEREST"));
  assert.ok(!types.includes("UNRESOLVED_MOTORCYCLE"));
});

test("non-empty, non-matching motorcycle text -> UNRESOLVED_MOTORCYCLE, never MISSING_MOTORCYCLE_INTEREST", () => {
  const { record, issues } = buildLeadRecord(row({ modelo_interes_texto: "Bajaj Pulsar" }), catalog);
  assert.equal(record.motorcycleSku, null);
  const types = issues.map((i) => i.type);
  assert.ok(types.includes("UNRESOLVED_MOTORCYCLE"));
  assert.ok(!types.includes("MISSING_MOTORCYCLE_INTEREST"));
  const issue = issues.find((i) => i.type === "UNRESOLVED_MOTORCYCLE");
  assert.equal(issue?.severity, "WARNING");
});

test("ambiguous model family (multiple tied candidates) is not force-resolved", () => {
  // "Bajaj Pulsar" ties across NS125/NS160/RS200 at the same token-similarity
  // score, all below the 0.6 threshold -- must stay unresolved.
  const { record } = buildLeadRecord(row({ modelo_interes_texto: "Bajaj Pulsar" }), catalog);
  assert.equal(record.motorcycleSku, null);
});

test("brand-only text is not force-resolved to a guessed model", () => {
  const { record, issues } = buildLeadRecord(row({ modelo_interes_texto: "Bajaj" }), catalog);
  assert.equal(record.motorcycleSku, null);
  assert.ok(issues.some((i) => i.type === "UNRESOLVED_MOTORCYCLE"));
});

test("exact catalog match resolves and raises neither motorcycle issue", () => {
  const { record, issues } = buildLeadRecord(row({ modelo_interes_texto: "Suzuki GN 125" }), catalog);
  assert.equal(record.motorcycleSku, "SKU-013");
  const types = issues.map((i) => i.type);
  assert.ok(!types.includes("UNRESOLVED_MOTORCYCLE"));
  assert.ok(!types.includes("MISSING_MOTORCYCLE_INTEREST"));
});

test("ambiguous date field produces one AMBIGUOUS_DATE issue per affected field", () => {
  const { issues } = buildLeadRecord(
    row({ fecha_registro: "03/08/2026 10:30", fecha_primer_contacto: "05/08/2026 09:00" }),
    catalog
  );
  const ambiguous = issues.filter((i) => i.type === "AMBIGUOUS_DATE");
  assert.equal(ambiguous.length, 2);
  assert.deepEqual(
    ambiguous.map((i) => i.field).sort(),
    ["fecha_primer_contacto", "fecha_registro"]
  );
});
