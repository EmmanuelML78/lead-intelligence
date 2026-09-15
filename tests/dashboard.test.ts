import assert from "node:assert/strict";
import test from "node:test";
import { selectCurrentScore } from "../src/lib/assignment/eligibility";
import { computeCapacityPools } from "../src/lib/dashboard/capacity";
import { countIssuesByType } from "../src/lib/dashboard/issues";
import {
  MISSING_AI_EXTRACTION_COPY,
  presentAiExtraction,
  presentAssignment,
  presentConversationMessage,
  presentSla
} from "../src/lib/dashboard/present";
import { leadScopeWhere } from "../src/lib/dashboard/queries";
import { MissingCompanyIdError, requireCompanyId } from "../src/lib/dashboard/tenant";

test("requireCompanyId rejects missing tenant context", () => {
  assert.throws(() => requireCompanyId(""), MissingCompanyIdError);
  assert.throws(() => requireCompanyId(null), MissingCompanyIdError);
  assert.throws(() => requireCompanyId("  "), MissingCompanyIdError);
  assert.equal(requireCompanyId("EMP-01"), "EMP-01");
});

test("leadScopeWhere always requires companyId and never drops it", () => {
  assert.throws(() => leadScopeWhere(""), MissingCompanyIdError);
  const where = leadScopeWhere("EMP-01", { id: "LD-1", salesPointId: "PV-001" });
  assert.equal(where.companyId, "EMP-01");
  assert.equal(where.id, "LD-1");
});

test("current hybrid-v1 score selection ignores newer non-v1 rows", () => {
  const selected = selectCurrentScore([
    {
      id: "new-other",
      scoreVersion: "hybrid-v0",
      totalScore: 99,
      createdAt: new Date("2026-09-15T00:00:00.000Z")
    },
    {
      id: "current-v1",
      scoreVersion: "hybrid-v1",
      totalScore: 61.2,
      createdAt: new Date("2026-09-14T12:00:00.000Z")
    },
    {
      id: "old-v1",
      scoreVersion: "hybrid-v1",
      totalScore: 20,
      createdAt: new Date("2026-09-13T00:00:00.000Z")
    }
  ]);
  assert.equal(selected?.id, "current-v1");
  assert.equal(selected?.totalScore, 61.2);
});

test("assignment presentation hides enums behind operational copy", () => {
  assert.equal(
    presentAssignment({
      reasonCode: "CAPACITY_EXHAUSTED",
      explanation: "Sin asignar: capacidad diaria agotada en EMP-01/PV-001.",
      advisorId: null,
      advisorName: null,
      assignedFor: new Date("2026-09-14T00:00:00.000Z")
    }).explanation,
    "Waiting: sales-point daily capacity exhausted."
  );
  const assigned = presentAssignment({
    reasonCode: "ASSIGNED",
    explanation: "Asignado a AS-1.",
    advisorId: "AS-1",
    advisorName: "Ana",
    assignedFor: new Date("2026-09-14T00:00:00.000Z")
  });
  assert.equal(assigned.state, "ASSIGNED");
  assert.equal(assigned.advisorName, "Ana");
  assert.equal(presentAssignment(null).state, "UNASSIGNED");
});

test("capacity calculations exclude inactive advisors and mark saturated pools", () => {
  const snapshot = computeCapacityPools({
    salesPointIds: ["PV-001", "PV-002"],
    advisors: [
      {
        advisorId: "AS-1",
        name: "Ana",
        salesPointId: "PV-001",
        active: true,
        dailyCapacity: 2
      },
      {
        advisorId: "AS-2",
        name: "Inactive",
        salesPointId: "PV-001",
        active: false,
        dailyCapacity: 50
      },
      {
        advisorId: "AS-3",
        name: "Luis",
        salesPointId: "PV-002",
        active: true,
        dailyCapacity: 10
      }
    ],
    leads: [
      { leadId: "L1", salesPointId: "PV-001", eligible: true },
      { leadId: "L2", salesPointId: "PV-001", eligible: true },
      { leadId: "L3", salesPointId: "PV-001", eligible: true },
      { leadId: "L4", salesPointId: "PV-002", eligible: true }
    ],
    assignments: [
      { leadId: "L1", salesPointId: "PV-001", advisorId: "AS-1", reasonCode: "ASSIGNED" },
      { leadId: "L2", salesPointId: "PV-001", advisorId: "AS-1", reasonCode: "ASSIGNED" },
      { leadId: "L3", salesPointId: "PV-001", advisorId: null, reasonCode: "CAPACITY_EXHAUSTED" },
      { leadId: "L4", salesPointId: "PV-002", advisorId: "AS-3", reasonCode: "ASSIGNED" }
    ]
  });

  const pv1 = snapshot.pools.find((pool) => pool.salesPointId === "PV-001");
  assert.ok(pv1);
  assert.equal(pv1.activeAdvisors, 1);
  assert.equal(pv1.dailyCapacity, 2);
  assert.equal(pv1.eligibleLeads, 3);
  assert.equal(pv1.assigned, 2);
  assert.equal(pv1.waitingDueToCapacity, 1);
  assert.equal(pv1.saturated, true);
  assert.equal(pv1.advisors.length, 1);
  assert.equal(pv1.advisors[0]?.name, "Ana");
  assert.equal(pv1.advisors[0]?.utilization, 1);
  assert.equal(snapshot.saturatedPoolCount, 1);
});

test("data-quality unique issue counts ignore reobservedRunCount", () => {
  const counts = countIssuesByType([
    { type: "AMBIGUOUS_DATE", reobservedRunCount: 9 },
    { type: "AMBIGUOUS_DATE", reobservedRunCount: 3 },
    { type: "MISSING_CITY", reobservedRunCount: 40 }
  ]);
  assert.deepEqual(counts, [
    { type: "AMBIGUOUS_DATE", count: 2 },
    { type: "MISSING_CITY", count: 1 }
  ]);
});

test("missing AI extraction stays a neutral empty state", () => {
  assert.equal(presentAiExtraction(null), null);
  assert.equal(MISSING_AI_EXTRACTION_COPY, "No AI extraction available for this conversation.");
  const view = presentAiExtraction({
    motorcycleInterest: "Pulsar",
    budget: 12_000_000,
    downPayment: 2_000_000,
    paymentMethod: "CREDIT",
    purchaseIntent: "HIGH",
    mainObjection: "PRICE",
    requestedAppointment: true,
    requestedQuote: false,
    evidence: { motorcycleInterest: ["busco pulsar"] }
  });
  assert.equal(view?.motorcycleInterest, "Pulsar");
  assert.deepEqual(view?.evidence.motorcycleInterest, ["busco pulsar"]);
});

test("conversation presentation distinguishes CUSTOMER and ADVISOR", () => {
  assert.equal(presentConversationMessage({
    id: "1",
    index: 0,
    sender: "cliente",
    sentTime: "10:00",
    text: "hola"
  }).role, "CUSTOMER");
  assert.equal(presentConversationMessage({
    id: "2",
    index: 1,
    sender: "asesor",
    sentTime: "10:01",
    text: "buenas"
  }).role, "ADVISOR");
});

test("SLA copy uses urgency bucket rather than raw enums", () => {
  const sla = presentSla({
    bucket: "CRITICAL_24H_PLUS",
    contacted: false,
    leadAgeMinutes: 36 * 60
  });
  assert.equal(sla.label, "Critical (24h+ uncontacted)");
  assert.equal(sla.ageLabel, "1d 12h");
});
