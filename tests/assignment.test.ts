import assert from "node:assert/strict";
import test from "node:test";
import { analyzeAssignments } from "../src/lib/assignment/analyze";
import {
  BUSINESS_TIMEZONE,
  calendarDateInTimeZone,
  parseBusinessDate,
  resolveBusinessDate
} from "../src/lib/assignment/business-date";
import {
  ASSIGNMENT_SCORE_VERSION,
  compareAssignableLeads,
  isAssignableStatus,
  selectCurrentScore,
  trustedRegistrationMs
} from "../src/lib/assignment/eligibility";
import { formatAssignedExplanation } from "../src/lib/assignment/explain";
import {
  assignLeads,
  type AssignmentAdvisor,
  type AssignmentDecision,
  type AssignmentLead,
  type ExistingAssignment
} from "../src/lib/assignment/engine";
import { chooseAdvisor, normalizedLoad } from "../src/lib/assignment/load-balance";

const businessDate = parseBusinessDate("2026-09-14");

function advisor(overrides: Partial<AssignmentAdvisor> & Pick<AssignmentAdvisor, "advisorId">): AssignmentAdvisor {
  return {
    name: overrides.advisorId,
    companyId: "EMP-01",
    salesPointId: "PV-001",
    dailyCapacity: 10,
    assignedToday: 0,
    active: true,
    ...overrides
  };
}

function score(totalScore: number, id = "score-1"): NonNullable<AssignmentLead["currentScore"]> {
  return {
    id,
    scoreVersion: ASSIGNMENT_SCORE_VERSION,
    totalScore,
    createdAt: new Date("2026-09-14T12:00:00.000Z")
  };
}

function lead(
  overrides: Partial<AssignmentLead> & Pick<AssignmentLead, "leadId">
): AssignmentLead {
  return {
    companyId: "EMP-01",
    salesPointId: "PV-001",
    status: "SIN_GESTION",
    registeredAt: new Date("2026-09-01T00:00:00.000Z"),
    registeredAtAmbiguous: false,
    currentScore: score(50, `score-${overrides.leadId}`),
    ...overrides
  };
}

function existingAssigned(leadId: string, advisorId: string): ExistingAssignment {
  return { id: `asg-${leadId}`, leadId, advisorId, reasonCode: "ASSIGNED" };
}

function assignedAdvisorIds(decisions: AssignmentDecision[]): string[] {
  return decisions
    .filter((decision) => decision.reasonCode === "ASSIGNED" && decision.advisorId)
    .map((decision) => decision.advisorId)
    .filter((id): id is string => id !== null)
    .sort((a, b) => a.localeCompare(b));
}

test("SIN_GESTION/CONTACTADO/NO_CONTESTA/COTIZACION_ENVIADA/EN_PROCESO are assignable; DESCARTADO and UNKNOWN are not", () => {
  assert.equal(isAssignableStatus("SIN_GESTION"), true);
  assert.equal(isAssignableStatus("CONTACTADO"), true);
  assert.equal(isAssignableStatus("NO_CONTESTA"), true);
  assert.equal(isAssignableStatus("COTIZACION_ENVIADA"), true);
  assert.equal(isAssignableStatus("EN_PROCESO"), true);
  assert.equal(isAssignableStatus("DESCARTADO"), false);
  assert.equal(isAssignableStatus("UNKNOWN"), false);
});

test("selectCurrentScore returns the recorded hybrid-v1 score and ignores other versions even if newer", () => {
  const hybrid = {
    scoreVersion: "hybrid-v1",
    leadScore: { id: "old-v1", totalScore: 41, createdAt: new Date("2026-09-13T00:00:00.000Z") }
  };
  const otherVersionNewer = {
    scoreVersion: "hybrid-v0",
    leadScore: { id: "new-other", totalScore: 99, createdAt: new Date("2026-09-15T00:00:00.000Z") }
  };
  const selected = selectCurrentScore([otherVersionNewer, hybrid]);
  assert.equal(selected?.id, "old-v1");
  assert.equal(selected?.totalScore, 41);
  assert.equal(selectCurrentScore([otherVersionNewer, hybrid], "hybrid-v0")?.id, "new-other");
});

test("selectCurrentScore returns the recorded score even when its createdAt is the oldest in the history", () => {
  // Data went A -> B -> A: row A was created first and is current again.
  const recordedCurrent = {
    scoreVersion: "hybrid-v1",
    leadScore: { id: "score-a", totalScore: 48, createdAt: new Date("2026-09-14T10:00:00.000Z") }
  };
  assert.equal(selectCurrentScore([recordedCurrent])?.id, "score-a");
});

test("selectCurrentScore returns null without a recorded score and rejects an ambiguous record", () => {
  assert.equal(selectCurrentScore([]), null);
  assert.equal(selectCurrentScore([{ scoreVersion: "hybrid-v0", leadScore: { id: "other" } }]), null);
  assert.throws(
    () =>
      selectCurrentScore([
        { scoreVersion: "hybrid-v1", leadScore: { id: "one" } },
        { scoreVersion: "hybrid-v1", leadScore: { id: "two" } }
      ]),
    /at most one current hybrid-v1 score/
  );
});

test("queue order is totalScore DESC, then trusted registration ASC, then leadId; bands never override", () => {
  const lowBandHigherNumber = lead({
    leadId: "LD-LOW",
    currentScore: score(54, "s-low")
  });
  const highBandLowerNumber = lead({
    leadId: "LD-HIGH-BAND",
    currentScore: score(53, "s-high")
  });
  assert.ok(compareAssignableLeads(lowBandHigherNumber, highBandLowerNumber) < 0);

  const older = lead({
    leadId: "LD-002",
    currentScore: score(50, "s2"),
    registeredAt: new Date("2026-08-01T00:00:00.000Z")
  });
  const newer = lead({
    leadId: "LD-001",
    currentScore: score(50, "s1"),
    registeredAt: new Date("2026-09-01T00:00:00.000Z")
  });
  assert.ok(compareAssignableLeads(older, newer) < 0);
});

test("ambiguous registration time is not used for ordering", () => {
  const ambiguousEarly = lead({
    leadId: "LD-002",
    currentScore: score(50, "sa"),
    registeredAt: new Date("2020-01-01T00:00:00.000Z"),
    registeredAtAmbiguous: true
  });
  const trustedLater = lead({
    leadId: "LD-001",
    currentScore: score(50, "sb"),
    registeredAt: new Date("2026-09-01T00:00:00.000Z"),
    registeredAtAmbiguous: false
  });
  assert.equal(trustedRegistrationMs(ambiguousEarly), null);
  // Both-trusted rule does not apply, so leadId ASC: LD-001 before LD-002.
  assert.ok(compareAssignableLeads(trustedLater, ambiguousEarly) < 0);
});

test("business date uses America/Bogota, not the UTC calendar date", () => {
  const stillSundayInBogota = resolveBusinessDate({
    now: new Date("2026-09-14T04:00:00.000Z"),
    timeZone: BUSINESS_TIMEZONE
  });
  assert.equal(calendarDateInTimeZone(new Date("2026-09-14T04:00:00.000Z"), BUSINESS_TIMEZONE), "2026-09-13");
  assert.equal(stillSundayInBogota.toISOString(), "2026-09-13T00:00:00.000Z");

  const mondayInBogota = resolveBusinessDate({
    now: new Date("2026-09-14T06:00:00.000Z"),
    timeZone: BUSINESS_TIMEZONE
  });
  assert.equal(mondayInBogota.toISOString(), "2026-09-14T00:00:00.000Z");

  const explicit = resolveBusinessDate({ businessDate: "2026-09-01" });
  assert.equal(explicit.toISOString(), "2026-09-01T00:00:00.000Z");
});

test("inactive advisor with zero utilization never receives a new assignment", () => {
  const decisions = assignLeads({
    businessDate,
    advisors: [
      advisor({ advisorId: "AS-INACTIVE", active: false, assignedToday: 0, dailyCapacity: 50 }),
      advisor({ advisorId: "AS-ACTIVE", active: true, assignedToday: 4, dailyCapacity: 10 })
    ],
    existing: [],
    leads: [lead({ leadId: "LD-1", currentScore: score(80, "s1") })]
  });
  assert.deepEqual(assignedAdvisorIds(decisions), ["AS-ACTIVE"]);
  assert.equal(decisions[0]?.reasonCode, "ASSIGNED");
});

test("company isolation: EMP-01 lead cannot be assigned to EMP-02 advisor", () => {
  const decisions = assignLeads({
    businessDate,
    advisors: [
      advisor({ advisorId: "AS-B", companyId: "EMP-02", salesPointId: "PV-001", assignedToday: 0, dailyCapacity: 100 })
    ],
    existing: [],
    leads: [lead({ leadId: "LD-A", companyId: "EMP-01", salesPointId: "PV-001" })]
  });
  assert.equal(decisions[0]?.advisorId, null);
  assert.equal(decisions[0]?.reasonCode, "NO_ELIGIBLE_ADVISOR");
  const report = analyzeAssignments({
    businessDate: "2026-09-14",
    timeZone: BUSINESS_TIMEZONE,
    scoreVersion: ASSIGNMENT_SCORE_VERSION,
    leads: [lead({ leadId: "LD-A", companyId: "EMP-01", salesPointId: "PV-001" })],
    advisors: [advisor({ advisorId: "AS-B", companyId: "EMP-02", salesPointId: "PV-001" })],
    decisions
  });
  assert.equal(report.crossCompanyAssignments, 0);
});

test("sales-point isolation: PV-001 lead cannot be assigned to PV-002 advisor", () => {
  const decisions = assignLeads({
    businessDate,
    advisors: [
      advisor({ advisorId: "AS-PV2", companyId: "EMP-01", salesPointId: "PV-002", assignedToday: 0, dailyCapacity: 100 })
    ],
    existing: [],
    leads: [lead({ leadId: "LD-PV1", companyId: "EMP-01", salesPointId: "PV-001" })]
  });
  assert.equal(decisions[0]?.advisorId, null);
  assert.equal(decisions[0]?.reasonCode, "NO_ELIGIBLE_ADVISOR");
  const report = analyzeAssignments({
    businessDate: "2026-09-14",
    timeZone: BUSINESS_TIMEZONE,
    scoreVersion: ASSIGNMENT_SCORE_VERSION,
    leads: [lead({ leadId: "LD-PV1" })],
    advisors: [advisor({ advisorId: "AS-PV2", salesPointId: "PV-002" })],
    decisions
  });
  assert.equal(report.crossSalesPointAssignments, 0);
});

test("normalized utilization: 7/20 beats 5/10", () => {
  const a = advisor({ advisorId: "AS-A", dailyCapacity: 10 });
  const b = advisor({ advisorId: "AS-B", dailyCapacity: 20 });
  const existing: ExistingAssignment[] = [
    ...Array.from({ length: 5 }, (_, i) => existingAssigned(`LD-A${i}`, "AS-A")),
    ...Array.from({ length: 7 }, (_, i) => existingAssigned(`LD-B${i}`, "AS-B"))
  ];
  const chosen = chooseAdvisor(
    [
      { ...a, assignedToday: 5 },
      { ...b, assignedToday: 7 }
    ],
    "EMP-01",
    "PV-001"
  );
  assert.equal(chosen?.advisorId, "AS-B");
  assert.ok(normalizedLoad(7, 20) < normalizedLoad(5, 10));

  const decisions = assignLeads({
    businessDate,
    advisors: [a, b],
    existing,
    leads: [
      ...existing.map((row) => lead({ leadId: row.leadId })),
      lead({ leadId: "LD-NEW", currentScore: score(90, "s-new") })
    ]
  });
  const fresh = decisions.find((decision) => decision.leadId === "LD-NEW");
  assert.equal(fresh?.advisorId, "AS-B");
  assert.match(fresh?.explanation ?? "", /35%/);
});

test("deterministic tie-break: same utilization, then fewer assignments, then advisorId ASC", () => {
  const sameRaw = chooseAdvisor(
    [
      advisor({ advisorId: "AS-B", dailyCapacity: 10, assignedToday: 2 }),
      advisor({ advisorId: "AS-A", dailyCapacity: 10, assignedToday: 2 })
    ],
    "EMP-01",
    "PV-001"
  );
  assert.equal(sameRaw?.advisorId, "AS-A");

  const sameLoadDifferentCount = chooseAdvisor(
    [
      advisor({ advisorId: "AS-B", dailyCapacity: 20, assignedToday: 4 }),
      advisor({ advisorId: "AS-A", dailyCapacity: 10, assignedToday: 2 })
    ],
    "EMP-01",
    "PV-001"
  );
  assert.equal(sameLoadDifferentCount?.advisorId, "AS-A");
});

test("daily capacity is never exceeded", () => {
  const decisions = assignLeads({
    businessDate,
    advisors: [advisor({ advisorId: "AS-1", dailyCapacity: 1 })],
    existing: [],
    leads: [
      lead({ leadId: "LD-1", currentScore: score(80, "s1") }),
      lead({ leadId: "LD-2", currentScore: score(70, "s2") })
    ]
  });
  const assigned = decisions.filter((decision) => decision.reasonCode === "ASSIGNED");
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0]?.leadId, "LD-1");
  assert.equal(decisions.find((decision) => decision.leadId === "LD-2")?.reasonCode, "CAPACITY_EXHAUSTED");
});

test("priority order is preserved under capacity shortage", () => {
  const decisions = assignLeads({
    businessDate,
    advisors: [advisor({ advisorId: "AS-1", dailyCapacity: 1 })],
    existing: [],
    leads: [
      lead({ leadId: "LD-B", currentScore: score(40, "sb") }),
      lead({ leadId: "LD-A", currentScore: score(80, "sa") })
    ]
  });
  assert.equal(decisions.find((decision) => decision.leadId === "LD-A")?.reasonCode, "ASSIGNED");
  assert.equal(decisions.find((decision) => decision.leadId === "LD-B")?.reasonCode, "CAPACITY_EXHAUSTED");
});

test("rerun reuses the active assignment and does not duplicate or reassign", () => {
  const advisors = [
    advisor({ advisorId: "AS-1", dailyCapacity: 5 }),
    advisor({ advisorId: "AS-2", dailyCapacity: 5 })
  ];
  const leads = [lead({ leadId: "LD-1", currentScore: score(80, "s1") })];
  const first = assignLeads({ businessDate, advisors, existing: [], leads });
  assert.equal(first[0]?.reasonCode, "ASSIGNED");
  const firstAdvisor = first[0]?.advisorId;
  assert.ok(firstAdvisor);

  const second = assignLeads({
    businessDate,
    advisors: [
      advisor({ advisorId: "AS-1", dailyCapacity: 5 }),
      advisor({ advisorId: "AS-2", dailyCapacity: 50 })
    ],
    existing: [{ id: "keep", leadId: "LD-1", advisorId: firstAdvisor, reasonCode: "ASSIGNED" }],
    leads
  });
  assert.equal(second.length, 1);
  assert.equal(second[0]?.outcome, "reused");
  assert.equal(second[0]?.advisorId, firstAdvisor);
  assert.equal(second.filter((decision) => decision.reasonCode === "ASSIGNED").length, 1);
});

test("no advisor at the sales point yields NO_ELIGIBLE_ADVISOR", () => {
  const decisions = assignLeads({
    businessDate,
    advisors: [],
    existing: [],
    leads: [lead({ leadId: "LD-1" })]
  });
  assert.equal(decisions[0]?.reasonCode, "NO_ELIGIBLE_ADVISOR");
  assert.equal(decisions[0]?.advisorId, null);
});

test("only inactive advisors yield NO_ACTIVE_ADVISOR", () => {
  const decisions = assignLeads({
    businessDate,
    advisors: [advisor({ advisorId: "AS-OFF", active: false, dailyCapacity: 20 })],
    existing: [],
    leads: [lead({ leadId: "LD-1" })]
  });
  assert.equal(decisions[0]?.reasonCode, "NO_ACTIVE_ADVISOR");
});

test("closed and invalid leads are not assigned", () => {
  const decisions = assignLeads({
    businessDate,
    advisors: [advisor({ advisorId: "AS-1", dailyCapacity: 10 })],
    existing: [],
    leads: [
      lead({ leadId: "LD-CLOSED", status: "DESCARTADO" }),
      lead({ leadId: "LD-UNKNOWN", status: "UNKNOWN" }),
      lead({ leadId: "LD-NOSCORE", currentScore: null })
    ]
  });
  assert.equal(decisions.length, 0);
});

test("explicit business date is persisted on every decision", () => {
  const date = parseBusinessDate("2026-08-20");
  const decisions = assignLeads({
    businessDate: date,
    advisors: [advisor({ advisorId: "AS-1" })],
    existing: [],
    leads: [lead({ leadId: "LD-1" })]
  });
  assert.equal(decisions[0]?.assignedFor.toISOString(), "2026-08-20T00:00:00.000Z");
});

test("assignment explanation names advisor, tenant, store, and utilization", () => {
  const text = formatAssignedExplanation({
    advisorId: "AS-014",
    companyId: "EMP-02",
    salesPointId: "PV-007",
    assignedToday: 7,
    dailyCapacity: 20
  });
  assert.equal(
    text,
    "Asignado a AS-014: asesor activo de EMP-02/PV-007 con 35% de capacidad utilizada, menor carga normalizada entre los asesores elegibles."
  );
});

test("capacity analysis flags an overloaded pool without borrowing another store", () => {
  const leads = [
    lead({ leadId: "LD-1", currentScore: score(80, "s1") }),
    lead({ leadId: "LD-2", currentScore: score(40, "s2") })
  ];
  const advisors = [advisor({ advisorId: "AS-1", dailyCapacity: 1 })];
  const decisions = assignLeads({ businessDate, advisors, existing: [], leads });
  const report = analyzeAssignments({
    businessDate: "2026-09-14",
    timeZone: BUSINESS_TIMEZONE,
    scoreVersion: ASSIGNMENT_SCORE_VERSION,
    leads,
    advisors,
    decisions
  });
  assert.equal(report.overloadedPools.length, 1);
  assert.equal(report.overloadedPools[0]?.salesPointId, "PV-001");
  assert.equal(report.unassignedDueToCapacity, 1);
  assert.equal(report.inactiveAdvisorsReceivingAssignments, 0);
});
