import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readCsv, readJson } from "../src/pipeline/io";
import { deduplicateLeadRows } from "../src/pipeline/dedupe-lead-rows";
import { buildLeadRecord } from "../src/pipeline/persist/build-lead-record";
import type { RawConversation, RawLead, RawMotorcycle } from "../src/pipeline/types";

// These assert the exact data-quality metrics reconciled for the supplied
// assessment dataset (data/raw/*). They exercise the same pure functions
// run.ts uses, without touching the database, so they double as a
// regression guard for the ambiguous-date-fields / motorcycle-interest
// semantics cleanup. Dataset-specific numbers belong here, not in the
// generic domain unit tests.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../data/raw");

test("dataset-level data-quality metrics match the reconciled expectations", async () => {
  const leads = await readCsv<RawLead>(path.join(dataDir, "leads.csv"));
  const motorcycles = await readCsv<RawMotorcycle>(path.join(dataDir, "catalogo_motos.csv"));
  const conversations = await readJson<RawConversation[]>(path.join(dataDir, "conversaciones.json"));

  const { canonical, duplicates } = deduplicateLeadRows(leads);
  assert.equal(duplicates.length, 2, "known duplicate raw lead_id rows (LD-00011, LD-00251)");

  const catalog = motorcycles.map((m) => ({ sku: m.sku.trim(), brand: m.marca.trim(), line: m.linea.trim() }));
  const built = canonical.map((raw) => buildLeadRecord(raw, catalog));
  const issues = built.flatMap((b) => b.issues);

  const ambiguousDateIssues = issues.filter((i) => i.type === "AMBIGUOUS_DATE");
  const leadsWithAmbiguousDates = new Set(ambiguousDateIssues.map((i) => i.entityId)).size;
  const unresolvedMotorcycles = issues.filter((i) => i.type === "UNRESOLVED_MOTORCYCLE").length;
  const missingMotorcycleInterest = issues.filter((i) => i.type === "MISSING_MOTORCYCLE_INTEREST").length;

  assert.equal(ambiguousDateIssues.length, 481, "ambiguousDateFields");
  assert.equal(leadsWithAmbiguousDates, 414, "leadsWithAmbiguousDates");
  assert.equal(unresolvedMotorcycles, 134, "unresolvedMotorcycles");
  assert.equal(missingMotorcycleInterest, 80, "missingMotorcycleInterest");
  assert.equal(unresolvedMotorcycles + missingMotorcycleInterest, 214, "sum matches the pre-Milestone-2 preflight total");

  const knownLeadIds = new Set(canonical.map((row) => row.lead_id.trim()));
  const orphanConversations = conversations.filter((c) => !knownLeadIds.has(c.lead_id)).length;
  assert.equal(orphanConversations, 12);
});
