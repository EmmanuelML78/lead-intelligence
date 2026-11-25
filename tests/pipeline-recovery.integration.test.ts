import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { failInterruptedRuns, INTERRUPTED_RUN_REASON } from "../src/pipeline/persist/pipeline-run";
import { createTempDatabase, deployMigrations } from "./helpers/temp-database";

// Uses its own database: closing interrupted runs acts on every RUNNING row,
// which would interfere with other suites sharing a database.
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

test(
  "integration: runs left in RUNNING by an interrupted process are closed as FAILED, finished runs are untouched",
  { skip, timeout: 120_000 },
  async () => {
    const database = await createTempDatabase("recovery");
    const db = new PrismaClient({ datasourceUrl: database.url });
    try {
      deployMigrations(database);
      const finishedAt = new Date("2026-09-17T01:20:00.000Z");
      const success = await db.pipelineRun.create({ data: { status: "SUCCESS", finishedAt, leadsReceived: 10 } });
      const failed = await db.pipelineRun.create({ data: { status: "FAILED", finishedAt, failureReason: "earlier failure" } });
      const interrupted = await db.pipelineRun.create({ data: { status: "RUNNING", leadsReceived: 7 } });

      assert.equal(await failInterruptedRuns(db), 1);

      const after = await db.pipelineRun.findUniqueOrThrow({ where: { id: interrupted.id } });
      assert.equal(after.status, "FAILED");
      assert.equal(after.failureReason, INTERRUPTED_RUN_REASON);
      assert.ok(after.finishedAt instanceof Date);
      assert.equal(after.leadsReceived, 7, "what the interrupted run had recorded is kept");

      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: success.id } }), success);
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);

      assert.equal(await failInterruptedRuns(db), 0, "running it again changes nothing");
    } finally {
      await db.$disconnect();
      await database.drop();
    }
  }
);
