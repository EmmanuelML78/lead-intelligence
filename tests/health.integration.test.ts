import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { createHealthChecker, prismaHealthProbes } from "../src/lib/health/health";
import { inspectSchema } from "../src/lib/health/schema";
import { createTempDatabase, deployMigrations, repositoryMigrations, type TempDatabase } from "./helpers/temp-database";

// The health check against real PostgreSQL databases at different migration
// levels, built with `prisma migrate deploy`. Skipped when DATABASE_URL is
// not configured.
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

const probeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "health-probe.ts");
const INCIDENT_MIGRATION = "20261124010000_lead_current_score";

type RouteAnswer = { status: number; cacheControl: string | null; body: Record<string, unknown> };

/** Runs the real route handler in a new process whose DATABASE_URL is the given database. */
function callHealthRoute(databaseUrl: string): RouteAnswer {
  const result = spawnSync(process.execPath, ["--import", "tsx", probeScript], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8"
  });
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith("{"));
  assert.ok(line, `the health probe printed no result:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line) as RouteAnswer;
}

async function withDatabase(label: string, run: (database: TempDatabase, db: PrismaClient) => Promise<void>) {
  const database = await createTempDatabase(label);
  const db = new PrismaClient({ datasourceUrl: database.url });
  try {
    await run(database, db);
  } finally {
    await db.$disconnect();
    await database.drop();
  }
}

test(
  "integration: a fully migrated database is healthy through the real route",
  { skip, timeout: 120_000 },
  async () => {
    await withDatabase("health_ok", async (database, db) => {
      deployMigrations(database);
      assert.deepEqual(await inspectSchema(db), { compatible: true, problems: [] });

      const answer = callHealthRoute(database.url);
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body, { status: "ok", database: "reachable", schema: "compatible" });
      assert.equal(answer.cacheControl, "no-store");
    });
  }
);

test(
  "integration: 2026-11-24 incident -- code deployed before its migration answers 503, not 200",
  { skip, timeout: 120_000 },
  async () => {
    await withDatabase("health_incident", async (database, db) => {
      // The production database that day: every migration except the one
      // the newly deployed code needed.
      deployMigrations(database, { include: (name) => name !== INCIDENT_MIGRATION });
      assert.ok(repositoryMigrations().includes(INCIDENT_MIGRATION));

      const answer = callHealthRoute(database.url);
      assert.equal(answer.status, 503, "the health endpoint must not report a healthy application");
      assert.deepEqual(answer.body, { status: "error", database: "reachable", schema: "incompatible" });
      const text = JSON.stringify(answer.body);
      assert.ok(!text.includes("LeadCurrentScore") && !text.includes("2026"), "no internal names in the response");

      const inspection = await inspectSchema(db);
      assert.equal(inspection.compatible, false);
      assert.ok(inspection.problems.includes(`migration not applied: ${INCIDENT_MIGRATION}`));
      assert.ok(inspection.problems.includes("table missing: LeadCurrentScore"));

      // Applying the pending migration is all it takes to recover.
      deployMigrations(database);
      assert.equal(callHealthRoute(database.url).status, 200);
    });
  }
);

test(
  "integration: a database ahead of the code (additive migration applied early) stays healthy",
  { skip, timeout: 120_000 },
  async () => {
    await withDatabase("health_ahead", async (database, db) => {
      deployMigrations(database, {
        extra: [
          {
            name: "29990101000000_future_additive_change",
            sql: [
              'CREATE TABLE "FutureFeature" ("id" TEXT NOT NULL, CONSTRAINT "FutureFeature_pkey" PRIMARY KEY ("id"));',
              'ALTER TABLE "Lead" ADD COLUMN "futureNote" TEXT;',
              `ALTER TYPE "AssignmentReason" ADD VALUE 'FUTURE_REASON';`
            ].join("\n")
          }
        ]
      });
      const applied = await db.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM "_prisma_migrations" WHERE migration_name LIKE '2999%'
      `;
      assert.equal(applied.length, 1, "the future migration must really be applied");

      assert.deepEqual(await inspectSchema(db), { compatible: true, problems: [] });
      assert.equal(callHealthRoute(database.url).status, 200);
    });
  }
);

test(
  "integration: a required migration recorded as failed or rolled back is not counted as applied",
  { skip, timeout: 120_000 },
  async () => {
    await withDatabase("health_failed", async (database, db) => {
      deployMigrations(database);
      await db.$executeRaw`UPDATE "_prisma_migrations" SET finished_at = NULL WHERE migration_name = ${INCIDENT_MIGRATION}`;
      let inspection = await inspectSchema(db);
      assert.equal(inspection.compatible, false);
      assert.deepEqual(inspection.problems, [`migration not applied: ${INCIDENT_MIGRATION}`]);

      await db.$executeRaw`
        UPDATE "_prisma_migrations" SET finished_at = now(), rolled_back_at = now() WHERE migration_name = ${INCIDENT_MIGRATION}
      `;
      inspection = await inspectSchema(db);
      assert.deepEqual(inspection.problems, [`migration not applied: ${INCIDENT_MIGRATION}`]);
      assert.equal(callHealthRoute(database.url).status, 503);
    });
  }
);

test(
  "integration: objects removed behind the migration history are detected",
  { skip, timeout: 120_000 },
  async () => {
    await withDatabase("health_drift", async (database, db) => {
      deployMigrations(database);
      await db.$executeRawUnsafe('ALTER TABLE "Assignment" DROP COLUMN "explanation"');
      await db.$executeRawUnsafe('DROP TABLE "LeadCurrentScore"');
      const inspection = await inspectSchema(db);
      assert.equal(inspection.compatible, false);
      assert.deepEqual(inspection.problems.sort(), ["column missing: Assignment.explanation", "table missing: LeadCurrentScore"]);
      assert.equal(callHealthRoute(database.url).status, 503);
    });
  }
);

test(
  "integration: a database with no migrations at all is incompatible, not an error",
  { skip, timeout: 120_000 },
  async () => {
    await withDatabase("health_empty", async (database, db) => {
      const inspection = await inspectSchema(db);
      assert.equal(inspection.compatible, false);
      assert.ok(inspection.problems.includes("the migrations table does not exist"));
      const answer = callHealthRoute(database.url);
      assert.equal(answer.status, 503);
      assert.deepEqual(answer.body, { status: "error", database: "reachable", schema: "incompatible" });
    });
  }
);

test(
  "integration: an unreachable database answers 503 without leaking the connection error",
  { skip, timeout: 120_000 },
  async () => {
    const unreachable = new URL(process.env.DATABASE_URL!);
    unreachable.port = "1";
    unreachable.searchParams.set("connect_timeout", "3");
    const answer = callHealthRoute(unreachable.toString());
    assert.equal(answer.status, 503);
    assert.deepEqual(answer.body, { status: "error", database: "unreachable", schema: "unknown" });
  }
);

test(
  "integration: the health check works on a read-only session, so it cannot be writing",
  { skip, timeout: 120_000 },
  async () => {
    await withDatabase("health_readonly", async (database) => {
      deployMigrations(database);
      const readOnlyUrl = new URL(database.url);
      readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
      const readOnly = new PrismaClient({ datasourceUrl: readOnlyUrl.toString() });
      try {
        const mode = await readOnly.$queryRaw<Array<{ transaction_read_only: string }>>`SHOW transaction_read_only`;
        assert.equal(mode[0]?.transaction_read_only, "on");
        const result = await createHealthChecker(prismaHealthProbes(readOnly))();
        assert.equal(result.httpStatus, 200);
      } finally {
        await readOnly.$disconnect();
      }
    });
  }
);
