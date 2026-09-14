import assert from "node:assert/strict";
import test from "node:test";
import { deduplicateLeadRows } from "../src/pipeline/dedupe-lead-rows";
import type { RawLead } from "../src/pipeline/types";

function row(overrides: Partial<RawLead>): RawLead {
  return {
    lead_id: "LD-1",
    fecha_registro: "",
    canal: "",
    empresa_id: "EMP-01",
    punto_venta_id: "PV-001",
    nombre_cliente: "",
    telefono: "",
    email: "",
    ciudad: "",
    modelo_interes_texto: "",
    estado_gestion: "",
    fecha_primer_contacto: "",
    campania: "",
    ...overrides
  };
}

test("duplicate lead source id -> only one canonical row survives for persistence", () => {
  const rows = [row({ lead_id: "LD-00011" }), row({ lead_id: "LD-00251" }), row({ lead_id: "LD-00011" })];
  const { canonical, duplicates } = deduplicateLeadRows(rows);
  assert.equal(canonical.length, 2);
  assert.deepEqual(canonical.map((r) => r.lead_id), ["LD-00011", "LD-00251"]);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.lead_id, "LD-00011");
});

test("no duplicates -> every row is canonical", () => {
  const rows = [row({ lead_id: "LD-1" }), row({ lead_id: "LD-2" }), row({ lead_id: "LD-3" })];
  const { canonical, duplicates } = deduplicateLeadRows(rows);
  assert.equal(canonical.length, 3);
  assert.equal(duplicates.length, 0);
});

test("whitespace around lead_id does not defeat duplicate detection", () => {
  const rows = [row({ lead_id: "LD-1" }), row({ lead_id: " LD-1 " })];
  const { canonical, duplicates } = deduplicateLeadRows(rows);
  assert.equal(canonical.length, 1);
  assert.equal(duplicates.length, 1);
});
