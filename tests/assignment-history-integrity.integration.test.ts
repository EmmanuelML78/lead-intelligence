import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { parseBusinessDate } from "../src/lib/assignment/business-date";
import { prisma } from "../src/lib/db/client";

// Assignment rows are the audit trail of who was given which lead and why.
// These suites pin the database-level guarantees that protect that history.
// Skipped when DATABASE_URL is not configured.
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

type Fixture = {
  company: string;
  salesPoint: string;
  advisor: string;
  lead: string;
  assignedFor: Date;
};

async function createFixture(prefix: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    company: `EMP-${prefix}-${suffix}`,
    salesPoint: `PV-${prefix}-${suffix}`,
    advisor: `AS-${prefix}-${suffix}`,
    lead: `LD-${prefix}-${suffix}`,
    assignedFor: parseBusinessDate("2026-09-14")
  };
  await prisma.company.create({ data: { id: fixture.company } });
  await prisma.salesPoint.create({ data: { id: fixture.salesPoint, companyId: fixture.company } });
  await prisma.advisor.create({
    data: {
      id: fixture.advisor,
      name: "Synthetic Advisor",
      companyId: fixture.company,
      salesPointId: fixture.salesPoint,
      dailyCapacity: 5,
      active: true
    }
  });
  await prisma.lead.create({
    data: {
      id: fixture.lead,
      companyId: fixture.company,
      salesPointId: fixture.salesPoint,
      channel: "WHATSAPP",
      status: "SIN_GESTION",
      sourceFingerprint: `fp-${fixture.lead}`,
      rawPayload: {}
    }
  });
  return fixture;
}

async function removeFixture(fixture: Fixture) {
  await prisma.assignment.deleteMany({ where: { leadId: fixture.lead } });
  await prisma.lead.deleteMany({ where: { id: fixture.lead } });
  await prisma.advisor.deleteMany({ where: { id: fixture.advisor } });
  await prisma.salesPoint.deleteMany({ where: { id: fixture.salesPoint } });
  await prisma.company.deleteMany({ where: { id: fixture.company } });
}

function databaseErrorCode(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as { code?: unknown } | undefined;
    return typeof meta?.code === "string" ? meta.code : error.code;
  }
  return undefined;
}

test(
  "integration: an advisor with assignment history cannot be deleted and the history is untouched",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("HIST-DEL");
    try {
      const created = await prisma.assignment.create({
        data: {
          leadId: fixture.lead,
          advisorId: fixture.advisor,
          assignedFor: fixture.assignedFor,
          reasonCode: "ASSIGNED",
          explanation: "Asignado a Synthetic Advisor."
        }
      });

      await assert.rejects(
        () => prisma.advisor.delete({ where: { id: fixture.advisor } }),
        (error: unknown) => {
          assert.ok(error instanceof Prisma.PrismaClientKnownRequestError);
          assert.equal(error.code, "P2003", "expected a foreign key constraint violation");
          return true;
        }
      );
      await assert.rejects(() => prisma.advisor.deleteMany({ where: { id: fixture.advisor } }));

      assert.equal(await prisma.advisor.count({ where: { id: fixture.advisor } }), 1);
      const after = await prisma.assignment.findUniqueOrThrow({ where: { id: created.id } });
      assert.deepEqual(after, created, "the assignment row must be exactly as it was written");
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: an advisor without assignment history can still be deleted",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("HIST-FREE");
    try {
      await prisma.assignment.create({
        data: {
          leadId: fixture.lead,
          assignedFor: fixture.assignedFor,
          reasonCode: "NO_ACTIVE_ADVISOR",
          explanation: "Sin asignar: no hay asesores activos."
        }
      });
      await prisma.advisor.delete({ where: { id: fixture.advisor } });
      assert.equal(await prisma.advisor.count({ where: { id: fixture.advisor } }), 0);
      assert.equal(await prisma.assignment.count({ where: { leadId: fixture.lead } }), 1);
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: the database rejects an assignment written without reasonCode or explanation",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("HIST-REQ");
    const NOT_NULL_VIOLATION = "23502";
    try {
      // Raw SQL on purpose: the Prisma client already requires both fields,
      // so only a write that bypasses it can reach the column defaults.
      await assert.rejects(
        () => prisma.$executeRaw`
          INSERT INTO "Assignment" ("id", "leadId", "assignedFor", "explanation")
          VALUES (${`asg-${randomUUID()}`}, ${fixture.lead}, ${fixture.assignedFor}, 'explained')
        `,
        (error: unknown) => {
          assert.equal(databaseErrorCode(error), NOT_NULL_VIOLATION, "reasonCode must have no default");
          return true;
        }
      );
      await assert.rejects(
        () => prisma.$executeRaw`
          INSERT INTO "Assignment" ("id", "leadId", "assignedFor", "reasonCode")
          VALUES (${`asg-${randomUUID()}`}, ${fixture.lead}, ${fixture.assignedFor}, 'ASSIGNED'::"AssignmentReason")
        `,
        (error: unknown) => {
          assert.equal(databaseErrorCode(error), NOT_NULL_VIOLATION, "explanation must have no default");
          return true;
        }
      );
      assert.equal(await prisma.assignment.count({ where: { leadId: fixture.lead } }), 0);
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: the Assignment table keeps its history-preserving constraints",
  { skip, timeout: 60_000 },
  async () => {
    const defaults = await prisma.$queryRaw<Array<{ column_name: string; column_default: string | null; is_nullable: string }>>`
      SELECT column_name, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'Assignment'
        AND column_name IN ('reasonCode', 'explanation')
      ORDER BY column_name
    `;
    assert.deepEqual(defaults, [
      { column_name: "explanation", column_default: null, is_nullable: "NO" },
      { column_name: "reasonCode", column_default: null, is_nullable: "NO" }
    ]);

    const foreignKeys = await prisma.$queryRaw<Array<{ conname: string; on_delete: string }>>`
      SELECT c.conname, c.confdeltype::text AS on_delete
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'f' AND t.relname = 'Assignment' AND n.nspname = current_schema()
      ORDER BY c.conname
    `;
    // r = RESTRICT, c = CASCADE, n = SET NULL
    assert.deepEqual(foreignKeys, [
      { conname: "Assignment_advisorId_fkey", on_delete: "r" },
      { conname: "Assignment_leadId_fkey", on_delete: "c" },
      { conname: "Assignment_leadScoreId_fkey", on_delete: "n" }
    ]);
  }
);
