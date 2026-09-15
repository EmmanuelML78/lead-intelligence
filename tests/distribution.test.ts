import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeScoreDistribution,
  selectSanitySamples,
  type ScoreExample
} from "../src/lib/scoring/distribution";
import { priorityBandFor } from "../src/lib/scoring/hybrid";
import type { LeadPriorityScore } from "../src/lib/scoring/score-lead";

function fakeScore(input: {
  leadId: string;
  totalScore: number;
  usedAiExtraction?: boolean;
  contacted?: boolean;
  inventoryAvailable?: boolean | null;
  sku?: string | null;
}): LeadPriorityScore {
  const priorityBand = priorityBandFor(input.totalScore);
  return {
    leadId: input.leadId,
    companyId: "EMP-01",
    scoreVersion: "hybrid-v1",
    inputFingerprint: input.leadId,
    propensityComponent: 10,
    intentComponent: 40,
    urgencyComponent: 90,
    inventoryComponent: 50,
    contributions: { propensity: 2, intent: 14, urgency: 36, inventory: 2.5 },
    totalScore: input.totalScore,
    priorityBand,
    explanation: {
      summary: `Prioridad ${priorityBand.toLowerCase()}.`,
      scoreVersion: "hybrid-v1",
      weights: { propensity: 20, intent: 35, urgency: 40, inventory: 5 },
      propensity: {
        rawProbability: 0.1,
        artifactVersion: "v1",
        component: 10,
        contribution: 2,
        importantFactors: []
      },
      intent: {
        purchaseIntent: "UNKNOWN",
        modifiers: [],
        component: 40,
        usedAiExtraction: input.usedAiExtraction ?? false,
        contribution: 14
      },
      urgency: {
        leadAgeMinutes: 180,
        contacted: input.contacted ?? false,
        registrationTimeReliable: true,
        bucket: input.contacted ? "CONTACTED" : "OVERDUE_1_4H",
        component: 90,
        contribution: 36
      },
      inventory: {
        sku: input.sku ?? null,
        catalogStatus:
          input.sku == null
            ? "UNKNOWN"
            : input.inventoryAvailable === true
              ? "CATALOG_AVAILABLE"
              : input.inventoryAvailable === false
                ? "CATALOG_UNAVAILABLE"
                : "UNKNOWN",
        available: input.inventoryAvailable ?? null,
        unitsGlobal: input.inventoryAvailable === true ? 3 : input.sku ? 0 : null,
        component: 50,
        contribution: 2.5
      }
    }
  };
}

test("distribution reports count, quantiles, and operational band counts", () => {
  const scores = [10, 30, 45, 55, 90].map((totalScore, index) =>
    fakeScore({ leadId: `LD-${index}`, totalScore })
  );
  const distribution = analyzeScoreDistribution(scores);

  assert.equal(distribution.count, 5);
  assert.equal(distribution.min, 10);
  assert.equal(distribution.median, 45);
  assert.equal(distribution.mean, 46);
  assert.equal(distribution.p75, 55);
  assert.equal(distribution.p90, 76);
  assert.equal(distribution.max, 90);
  assert.deepEqual(distribution.bands, {
    CRITICAL: 2,
    HIGH: 1,
    MEDIUM: 1,
    LOW: 1
  });
});

test("sanity samples keep highest, lowest, and operational slices", () => {
  const scores = [
    fakeScore({ leadId: "LD-HIGH", totalScore: 80, usedAiExtraction: true, sku: "SKU-1" }),
    fakeScore({ leadId: "LD-LOW", totalScore: 12, contacted: true }),
    fakeScore({
      leadId: "LD-NO-AI",
      totalScore: 40,
      usedAiExtraction: false,
      inventoryAvailable: false,
      sku: "SKU-2"
    })
  ];
  const samples = selectSanitySamples(scores);
  const ids = (rows: ScoreExample[]) => rows.map((row) => row.leadId);

  assert.deepEqual(ids(samples.highest), ["LD-HIGH", "LD-NO-AI", "LD-LOW"]);
  assert.deepEqual(ids(samples.lowest), ["LD-LOW", "LD-NO-AI", "LD-HIGH"]);
  assert.deepEqual(ids(samples.noAiExtraction), ["LD-NO-AI", "LD-LOW"]);
  assert.deepEqual(ids(samples.contacted), ["LD-LOW"]);
  assert.deepEqual(ids(samples.inventoryUnavailable), ["LD-NO-AI"]);
});
