import assert from "node:assert/strict";
import test from "node:test";
import {
  PRIORITY_SCORE_VERSION,
  calculateHybridScore,
  scoreCommercialIntent,
  scoreInputFingerprint,
  scoreInventory,
  scoreOperationalUrgency,
  weightSum
} from "../src/lib/scoring/hybrid";
import {
  scoreLeadPriority,
  selectCatalogInventory,
  type InventoryCandidate,
  type LeadPriorityScore,
  type ScoringAiExtraction,
  type ScoringMotorcycle
} from "../src/lib/scoring/score-lead";
import {
  persistLeadScore,
  type LeadScoreCreate,
  type LeadScoreIdentity,
  type LeadScoreStore
} from "../src/pipeline/persist/lead-scores";

const decisionAt = new Date("2026-09-14T20:00:00.000Z");
const motorcycle: ScoringMotorcycle = {
  sku: "SKU-010",
  brand: "Bajaj",
  line: "Pulsar RS 200",
  listPrice: 15_000_000
};
const baseExtraction: ScoringAiExtraction = {
  purchaseIntent: "MEDIUM",
  requestedAppointment: false,
  requestedQuote: false,
  downPayment: null,
  paymentMethod: "UNKNOWN",
  mainObjection: "NONE",
  confidence: 0.95,
  motorcycleSku: motorcycle.sku
};
const availableInventory: InventoryCandidate = {
  motorcycleSku: motorcycle.sku,
  unitsGlobal: 4
};

function leadScore(overrides: {
  extraction?: ScoringAiExtraction | null;
  registeredAt?: Date | null;
  firstContactAt?: Date | null;
  leadMotorcycleSku?: string | null;
  inventory?: InventoryCandidate[];
} = {}): LeadPriorityScore {
  return scoreLeadPriority({
    leadId: "LD-001",
    companyId: "EMP-01",
    salesPointId: "PV-001",
    channel: "WHATSAPP",
    registeredAt:
      overrides.registeredAt === undefined
        ? new Date("2026-09-14T17:00:00.000Z")
        : overrides.registeredAt,
    registeredAtAmbiguous: false,
    firstContactAt: overrides.firstContactAt ?? null,
    leadMotorcycleSku:
      overrides.leadMotorcycleSku === undefined
        ? motorcycle.sku
        : overrides.leadMotorcycleSku,
    aiExtraction:
      overrides.extraction === undefined ? baseExtraction : overrides.extraction,
    motorcycles: new Map([[motorcycle.sku, motorcycle]]),
    inventoryCandidates: overrides.inventory ?? [availableInventory],
    decisionAt
  });
}

test("V1 weights sum to 100 percent", () => {
  assert.equal(weightSum(), 100);
});

test("hybrid score is deterministic and always remains in 0..100", () => {
  const first = calculateHybridScore({
    propensityComponent: 55.123,
    intentComponent: 65,
    urgencyComponent: 90,
    inventoryComponent: 100
  });
  const second = calculateHybridScore({
    propensityComponent: 55.123,
    intentComponent: 65,
    urgencyComponent: 90,
    inventoryComponent: 100
  });
  assert.deepEqual(first, second);

  for (const component of [-1_000, 0, 50, 100, 1_000, Number.NaN]) {
    const score = calculateHybridScore({
      propensityComponent: component,
      intentComponent: component,
      urgencyComponent: component,
      inventoryComponent: component
    });
    assert.ok(score.totalScore >= 0 && score.totalScore <= 100);
  }
});

test("intent mapping orders HIGH above MEDIUM above LOW and handles UNKNOWN safely", () => {
  const score = (purchaseIntent: ScoringAiExtraction["purchaseIntent"]) =>
    scoreCommercialIntent({ ...baseExtraction, purchaseIntent }).component;
  assert.ok(score("HIGH") > score("MEDIUM"));
  assert.ok(score("MEDIUM") > score("LOW"));
  assert.equal(score("UNKNOWN"), 40);
  assert.equal(scoreCommercialIntent(null).component, 40);
});

test("AI extraction confidence does not change the V1 intent or final score", () => {
  const lowConfidence = leadScore({
    extraction: { ...baseExtraction, confidence: 0.1 }
  });
  const highConfidence = leadScore({
    extraction: { ...baseExtraction, confidence: 0.99 }
  });
  assert.equal(lowConfidence.intentComponent, highConfidence.intentComponent);
  assert.equal(lowConfidence.totalScore, highConfidence.totalScore);
  assert.equal(lowConfidence.inputFingerprint, highConfidence.inputFingerprint);
});

test("urgency rises across overdue uncontacted buckets and contact reduces SLA urgency", () => {
  const urgencyAt = (minutesOld: number, contacted = false) =>
    scoreOperationalUrgency({
      registeredAt: new Date(decisionAt.getTime() - minutesOld * 60_000),
      firstContactAt: contacted ? new Date(decisionAt.getTime() - 10 * 60_000) : null,
      decisionAt
    }).component;

  assert.ok(urgencyAt(50) > urgencyAt(20));
  assert.ok(urgencyAt(120) > urgencyAt(50));
  assert.ok(urgencyAt(24 * 60) > urgencyAt(120));
  assert.ok(urgencyAt(120, true) < urgencyAt(120));
});

test("ambiguous registration time does not fabricate precise lead age", () => {
  const urgency = scoreOperationalUrgency({
    registeredAt: new Date("2026-09-14T18:00:00.000Z"),
    registeredAtAmbiguous: true,
    firstContactAt: null,
    decisionAt
  });
  assert.equal(urgency.leadAgeMinutes, null);
  assert.equal(urgency.component, 50);
  assert.equal(urgency.registrationTimeReliable, false);
});

test("global catalog stock scores above global zero stock", () => {
  const available = scoreInventory({
    sku: motorcycle.sku,
    unitsGlobal: 2
  });
  const unavailable = scoreInventory({
    sku: motorcycle.sku,
    unitsGlobal: 0
  });
  assert.equal(available.catalogStatus, "CATALOG_AVAILABLE");
  assert.equal(unavailable.catalogStatus, "CATALOG_UNAVAILABLE");
  assert.equal(available.component, 100);
  assert.equal(unavailable.component, 20);
  assert.ok(available.component > unavailable.component);
});

test("missing AI and unresolved motorcycle use neutral fallbacks without crashing", () => {
  const score = leadScore({
    extraction: null,
    leadMotorcycleSku: null,
    inventory: []
  });
  assert.equal(score.intentComponent, 40);
  assert.equal(score.inventoryComponent, 50);
  assert.equal(score.explanation.inventory.catalogStatus, "UNKNOWN");
  assert.match(score.explanation.summary, /extracción IA/);
  assert.match(score.explanation.summary, /catálogo sin resolver/);
});

test("global catalog units are not treated as store or company stock", () => {
  const catalogRowOnOtherCompanyPv: InventoryCandidate = {
    motorcycleSku: motorcycle.sku,
    unitsGlobal: 10
  };
  assert.deepEqual(
    selectCatalogInventory(motorcycle.sku, [catalogRowOnOtherCompanyPv]),
    catalogRowOnOtherCompanyPv
  );

  const score = leadScore({
    inventory: [catalogRowOnOtherCompanyPv]
  });
  assert.equal(score.explanation.inventory.catalogStatus, "CATALOG_AVAILABLE");
  assert.equal(score.inventoryComponent, 100);
  assert.match(score.explanation.summary, /disponibilidad global en el catálogo/);
  assert.doesNotMatch(score.explanation.summary, /punto de venta|sede|esta empresa|stock físico/i);
});

test("company isolation stays on lead identity while catalog inventory stays global", () => {
  const emp01 = leadScore();
  const emp02 = scoreLeadPriority({
    leadId: "LD-002",
    companyId: "EMP-02",
    salesPointId: "PV-099",
    channel: "WHATSAPP",
    registeredAt: new Date("2026-09-14T17:00:00.000Z"),
    registeredAtAmbiguous: false,
    firstContactAt: null,
    leadMotorcycleSku: motorcycle.sku,
    aiExtraction: baseExtraction,
    motorcycles: new Map([[motorcycle.sku, motorcycle]]),
    inventoryCandidates: [availableInventory],
    decisionAt
  });

  assert.equal(emp01.inventoryComponent, emp02.inventoryComponent);
  assert.equal(emp01.explanation.inventory.catalogStatus, "CATALOG_AVAILABLE");
  assert.equal(emp02.explanation.inventory.catalogStatus, "CATALOG_AVAILABLE");
  assert.equal(emp01.companyId, "EMP-01");
  assert.equal(emp02.companyId, "EMP-02");
  assert.notEqual(emp01.inputFingerprint, emp02.inputFingerprint);
});

test("zero global catalog units use conservative unavailable copy", () => {
  const score = leadScore({
    inventory: [{ motorcycleSku: motorcycle.sku, unitsGlobal: 0 }]
  });
  assert.equal(score.explanation.inventory.catalogStatus, "CATALOG_UNAVAILABLE");
  assert.equal(score.inventoryComponent, 20);
  assert.match(score.explanation.summary, /no registra unidades disponibles en el catálogo global/);
  assert.doesNotMatch(score.explanation.summary, /punto de venta|sede|stock físico/i);
});

test("fingerprints change with relevant inputs and ignore irrelevant confidence", () => {
  const baseline = leadScore();
  const changedIntent = leadScore({
    extraction: { ...baseExtraction, purchaseIntent: "HIGH" }
  });
  const contacted = leadScore({
    firstContactAt: new Date("2026-09-14T19:00:00.000Z")
  });
  const unavailable = leadScore({
    inventory: [{ motorcycleSku: motorcycle.sku, unitsGlobal: 0 }]
  });

  assert.equal(baseline.inputFingerprint, leadScore().inputFingerprint);
  assert.notEqual(baseline.inputFingerprint, changedIntent.inputFingerprint);
  assert.notEqual(baseline.inputFingerprint, contacted.inputFingerprint);
  assert.notEqual(baseline.inputFingerprint, unavailable.inputFingerprint);
  assert.notEqual(
    scoreInputFingerprint({ scoreVersion: PRIORITY_SCORE_VERSION }),
    scoreInputFingerprint({ scoreVersion: "hybrid-v2" })
  );
});

test("explanation contains factual urgency, intent, and catalog inventory reasons", () => {
  const score = leadScore({
    extraction: {
      ...baseExtraction,
      purchaseIntent: "HIGH",
      requestedQuote: true
    }
  });
  assert.match(score.explanation.summary, /sin primer contacto/);
  assert.match(score.explanation.summary, /intención alta/);
  assert.match(score.explanation.summary, /cotización/);
  assert.match(score.explanation.summary, /disponibilidad global en el catálogo/);
  assert.doesNotMatch(score.explanation.summary, /seguramente comprará/);
  assert.doesNotMatch(score.explanation.summary, /punto de venta|sede|stock físico/i);
});

test("identical score input is idempotent and a scoreVersion change creates history", async () => {
  const rows = new Map<string, LeadScoreCreate & { id: string }>();
  const key = (identity: LeadScoreIdentity) =>
    `${identity.leadId}|${identity.scoreVersion}|${identity.inputFingerprint}`;
  const store: LeadScoreStore = {
    async findByIdentity(identity) {
      return rows.get(key(identity)) ?? null;
    },
    async create(input) {
      const id = `score-${rows.size + 1}`;
      rows.set(key(input), { ...input, id });
      return { id };
    }
  };
  const score = leadScore();

  assert.equal((await persistLeadScore(store, score)).outcome, "created");
  assert.equal((await persistLeadScore(store, score)).outcome, "reused");
  assert.equal(rows.size, 1);

  const nextVersion = {
    ...score,
    scoreVersion: "hybrid-v2"
  };
  assert.equal((await persistLeadScore(store, nextVersion)).outcome, "created");
  assert.equal(rows.size, 2);
});

test("persist refreshes explanation copy on an identical identity without inserting a duplicate", async () => {
  const rows = new Map<string, LeadScoreCreate & { id: string }>();
  const key = (identity: LeadScoreIdentity) =>
    `${identity.leadId}|${identity.scoreVersion}|${identity.inputFingerprint}`;
  const store: LeadScoreStore = {
    async findByIdentity(identity) {
      return rows.get(key(identity)) ?? null;
    },
    async create(input) {
      const id = "score-refresh";
      rows.set(key(input), { ...input, id });
      return { id };
    },
    async refresh(id, input) {
      const current = [...rows.values()].find((row) => row.id === id);
      if (!current) throw new Error("missing score");
      rows.set(key(current), { ...input, id });
    }
  };
  const score = leadScore();
  assert.equal((await persistLeadScore(store, score)).outcome, "created");
  const updated = {
    ...score,
    explanation: { ...score.explanation, summary: "Prioridad alta. copy refresh." }
  };
  assert.equal((await persistLeadScore(store, updated)).outcome, "reused");
  assert.equal(rows.size, 1);
  assert.equal([...rows.values()][0]?.explanation.summary, "Prioridad alta. copy refresh.");
});

test("persist treats a unique-identity race as reused instead of crashing", async () => {
  const score = leadScore();
  let created = false;
  const store: LeadScoreStore = {
    async findByIdentity() {
      return created ? { id: "score-raced" } : null;
    },
    async create() {
      created = true;
      throw new Error("Unique constraint failed");
    }
  };

  const result = await persistLeadScore(store, score);
  assert.equal(result.outcome, "reused");
  assert.equal(result.id, "score-raced");
});
