import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHealthChecker, type HealthProbes } from "../src/lib/health/health";
import { REQUIRED_MIGRATIONS } from "../src/lib/health/required-migrations";
import { requiredObjectsFromClient, type SchemaInspection } from "../src/lib/health/schema";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prisma", "migrations");

function fakeProbes(initial: { reachable?: boolean; inspection?: SchemaInspection } = {}) {
  const state = {
    reachable: initial.reachable ?? true,
    inspection: initial.inspection ?? ({ compatible: true, problems: [] } as SchemaInspection),
    inspectionFails: false,
    pings: 0,
    inspections: 0
  };
  const probes: HealthProbes = {
    async ping() {
      state.pings += 1;
      if (!state.reachable) throw new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2");
    },
    async inspectSchema() {
      state.inspections += 1;
      if (state.inspectionFails) throw new Error("permission denied for table _prisma_migrations");
      return state.inspection;
    }
  };
  return { state, probes };
}

test("the required migrations list matches the migrations in the repository", () => {
  const inRepository = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    [...REQUIRED_MIGRATIONS],
    inRepository,
    "update src/lib/health/required-migrations.ts in the same commit that adds or removes a migration"
  );
});

test("required objects come from the generated client and cover the table behind the 2026-11-24 incident", () => {
  const { tables, enums } = requiredObjectsFromClient();
  assert.deepEqual(tables.get("LeadCurrentScore"), ["leadId", "scoreVersion", "leadScoreId", "updatedAt"]);
  assert.ok(tables.get("Lead")?.includes("companyId"));
  assert.ok(!tables.get("Lead")?.includes("scores"), "relations are not columns");
  assert.ok(enums.get("AssignmentReason")?.includes("CAPACITY_EXHAUSTED"));
});

test("healthy: 200 with the three fixed words", async () => {
  const { probes } = fakeProbes();
  const result = await createHealthChecker(probes)();
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(result.body, { status: "ok", database: "reachable", schema: "compatible" });
});

test("unreachable database: 503, and no error text reaches the body", async () => {
  const { probes, state } = fakeProbes({ reachable: false });
  const result = await createHealthChecker(probes)();
  assert.equal(result.httpStatus, 503);
  assert.deepEqual(result.body, { status: "error", database: "unreachable", schema: "unknown" });
  assert.equal(state.inspections, 0, "the schema is not inspected when the database is unreachable");
  assert.ok(!JSON.stringify(result).includes("hunter2"));
});

test("incompatible schema: 503, details go to the log and never to the body", async () => {
  const logged: string[] = [];
  const { probes } = fakeProbes({
    inspection: {
      compatible: false,
      problems: ["migration not applied: 20261124010000_lead_current_score", "table missing: LeadCurrentScore"]
    }
  });
  const check = createHealthChecker(probes, { log: (message) => logged.push(message) });
  const result = await check();
  assert.equal(result.httpStatus, 503);
  assert.deepEqual(result.body, { status: "error", database: "reachable", schema: "incompatible" });
  assert.ok(!JSON.stringify(result).includes("LeadCurrentScore"));
  assert.ok(!JSON.stringify(result).includes("20261124010000"));
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /migration not applied: 20261124010000_lead_current_score; table missing: LeadCurrentScore/);
});

test("a failing inspection is reported as incompatible, not as healthy", async () => {
  const { probes, state } = fakeProbes();
  state.inspectionFails = true;
  const logged: string[] = [];
  const result = await createHealthChecker(probes, { log: (message) => logged.push(message) })();
  assert.equal(result.httpStatus, 503);
  assert.deepEqual(result.body, { status: "error", database: "reachable", schema: "incompatible" });
  assert.ok(!JSON.stringify(result).includes("permission denied"));
});

test("the schema inspection is cached while reachability is checked on every request", async () => {
  let clock = 1_000_000;
  const { probes, state } = fakeProbes();
  const check = createHealthChecker(probes, { now: () => clock, compatibleTtlMs: 30_000, incompatibleTtlMs: 5_000 });

  for (let request = 0; request < 5; request += 1) {
    assert.equal((await check()).httpStatus, 200);
    clock += 1_000;
  }
  assert.equal(state.pings, 5);
  assert.equal(state.inspections, 1, "five requests within the window inspect the schema once");

  clock += 30_000;
  await check();
  assert.equal(state.inspections, 2, "the inspection is repeated after the window");
});

test("an incompatible answer expires quickly, so applying the migration is noticed without a redeploy", async () => {
  let clock = 0;
  const logged: string[] = [];
  const { probes, state } = fakeProbes({ inspection: { compatible: false, problems: ["table missing: LeadCurrentScore"] } });
  const check = createHealthChecker(probes, {
    now: () => clock,
    compatibleTtlMs: 30_000,
    incompatibleTtlMs: 5_000,
    log: (message) => logged.push(message)
  });

  assert.equal((await check()).httpStatus, 503);
  clock += 2_000;
  assert.equal((await check()).httpStatus, 503);
  assert.equal(state.inspections, 1);
  assert.equal(logged.length, 1, "the same problem is logged once, not on every request");

  // The migration is applied.
  state.inspection = { compatible: true, problems: [] };
  clock += 5_000;
  const recovered = await check();
  assert.equal(recovered.httpStatus, 200);
  assert.deepEqual(recovered.body, { status: "ok", database: "reachable", schema: "compatible" });
});

test("a cached healthy answer is not served while the database is unreachable, nor reused afterwards", async () => {
  let clock = 0;
  const { probes, state } = fakeProbes();
  const check = createHealthChecker(probes, { now: () => clock });

  assert.equal((await check()).httpStatus, 200);
  state.reachable = false;
  clock += 1_000;
  assert.deepEqual((await check()).body, { status: "error", database: "unreachable", schema: "unknown" });

  state.reachable = true;
  state.inspection = { compatible: false, problems: ["table missing: Lead"] };
  clock += 1_000;
  assert.equal((await check()).httpStatus, 503, "the schema is inspected again once the database is back");
  assert.equal(state.inspections, 2);
});
