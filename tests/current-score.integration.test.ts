import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { ASSIGNMENT_SCORE_VERSION } from "../src/lib/assignment/eligibility";
import { getLeadDetail, listLeadQueue } from "../src/lib/dashboard/queries";
import { prisma } from "../src/lib/db/client";
import { runAssignmentStage } from "../src/pipeline/assignment-stage";
import { runScoringStage } from "../src/pipeline/scoring-stage";

// The current score of a lead is tracked explicitly and separately from the
// append-only LeadScore history. These suites drive the real scoring stage
// through an A -> B -> A change of the lead's data and check every consumer.
// Skipped when DATABASE_URL is not configured.
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

const decisionAt = new Date("2026-09-14T20:00:00.000Z");
const FIRST_CONTACT = new Date("2026-09-14T19:00:00.000Z");

type Fixture = { company: string; salesPoint: string; advisor: string; lead: string; otherLead: string };

async function createFixture(prefix: string): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    company: `EMP-${prefix}-${suffix}`,
    salesPoint: `PV-${prefix}-${suffix}`,
    advisor: `AS-${prefix}-${suffix}`,
    lead: `LD-${prefix}-${suffix}`,
    otherLead: `LD-${prefix}-OTHER-${suffix}`
  };
  await prisma.company.create({ data: { id: fixture.company } });
  await prisma.salesPoint.create({ data: { id: fixture.salesPoint, companyId: fixture.company } });
  await prisma.advisor.create({
    data: {
      id: fixture.advisor,
      name: "Synthetic Advisor",
      companyId: fixture.company,
      salesPointId: fixture.salesPoint,
      dailyCapacity: 20,
      active: true
    }
  });
  for (const id of [fixture.lead, fixture.otherLead]) {
    await prisma.lead.create({
      data: {
        id,
        companyId: fixture.company,
        salesPointId: fixture.salesPoint,
        registeredAt: new Date("2026-09-14T18:00:00.000Z"),
        channel: "WHATSAPP",
        status: "SIN_GESTION",
        sourceFingerprint: `fp-${id}`,
        rawPayload: {}
      }
    });
  }
  return fixture;
}

async function removeFixture(fixture: Fixture) {
  const leadIds = [fixture.lead, fixture.otherLead];
  await prisma.assignment.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.leadScore.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.advisor.deleteMany({ where: { id: fixture.advisor } });
  await prisma.salesPoint.deleteMany({ where: { id: fixture.salesPoint } });
  await prisma.company.deleteMany({ where: { id: fixture.company } });
}

/** Scores the fixture company and returns the evaluation of the main lead. */
async function scoreLead(fixture: Fixture) {
  const result = await runScoringStage(prisma, { companyId: fixture.company, decisionAt });
  assert.equal(result.report.failures, 0);
  const score = result.scores.find((row) => row.leadId === fixture.lead);
  assert.ok(score, "the lead was not scored");
  const row = await prisma.leadScore.findUniqueOrThrow({
    where: {
      leadId_scoreVersion_inputFingerprint: {
        leadId: score.leadId,
        scoreVersion: score.scoreVersion,
        inputFingerprint: score.inputFingerprint
      }
    }
  });
  return { report: result.report, score, row };
}

async function setContacted(fixture: Fixture, contacted: boolean) {
  await prisma.lead.update({
    where: { id: fixture.lead },
    data: { firstContactAt: contacted ? FIRST_CONTACT : null }
  });
}

async function queueScoreOf(fixture: Fixture): Promise<number | undefined> {
  const queue = await listLeadQueue(prisma, fixture.company);
  return queue.rows.find((row) => row.leadId === fixture.lead)?.totalScore;
}

test(
  "integration: when a lead's data goes A -> B -> A, score A is current again for every consumer",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("CUR-ABA");
    try {
      const a = await scoreLead(fixture);
      await setContacted(fixture, true);
      const b = await scoreLead(fixture);
      assert.notEqual(b.row.id, a.row.id, "state B must create a new history row");
      assert.notEqual(b.score.totalScore, a.score.totalScore, "fixture must produce two different scores");
      assert.equal((await getLeadDetail(prisma, fixture.company, fixture.lead))?.score?.totalScore, b.score.totalScore);

      await setContacted(fixture, false);
      const backToA = await scoreLead(fixture);
      assert.equal(backToA.row.id, a.row.id, "state A must reuse its history row instead of duplicating it");
      assert.equal(backToA.report.created, 0);

      // History: both evaluations are kept, untouched.
      const history = await prisma.leadScore.findMany({ where: { leadId: fixture.lead }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(history.map((row) => row.id), [a.row.id, b.row.id]);
      assert.deepEqual(history[1], b.row, "the superseded evaluation must not be modified");
      assert.ok(a.row.createdAt.getTime() <= b.row.createdAt.getTime(), "A is the older row by createdAt");

      // Dashboard consumers.
      const detail = await getLeadDetail(prisma, fixture.company, fixture.lead);
      assert.equal(detail?.score?.totalScore, a.score.totalScore, "lead detail must show score A");
      assert.equal(await queueScoreOf(fixture), a.score.totalScore, "lead queue must show score A");

      // Assignment consumer.
      const assigned = await runAssignmentStage(prisma, {
        businessDate: "2026-09-14",
        timeZone: "America/Bogota",
        companyId: fixture.company
      });
      assert.equal(assigned.report.assigned, 2);
      const assignment = await prisma.assignment.findFirstOrThrow({ where: { leadId: fixture.lead } });
      assert.equal(assignment.leadScoreId, a.row.id, "the assignment must be linked to score A");
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: re-scoring unchanged data is idempotent for the history and for the current score",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("CUR-IDEM");
    try {
      const first = await scoreLead(fixture);
      const pointerBefore = await prisma.leadCurrentScore.findMany({ where: { leadId: fixture.lead } });
      assert.equal(pointerBefore.length, 1);
      assert.equal(pointerBefore[0]?.leadScoreId, first.row.id);
      assert.equal(pointerBefore[0]?.scoreVersion, ASSIGNMENT_SCORE_VERSION);

      const second = await scoreLead(fixture);
      assert.equal(second.report.created, 0);
      assert.equal(second.report.reused, 2);
      assert.equal(await prisma.leadScore.count({ where: { leadId: fixture.lead } }), 1);
      assert.deepEqual(
        await prisma.leadCurrentScore.findMany({ where: { leadId: fixture.lead } }),
        pointerBefore,
        "an unchanged evaluation must not rewrite the current-score record"
      );
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: a change of current score never rewrites assignments from earlier business dates",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("CUR-HIST");
    try {
      const a = await scoreLead(fixture);
      await setContacted(fixture, true);
      const b = await scoreLead(fixture);
      await runAssignmentStage(prisma, { businessDate: "2026-09-14", timeZone: "America/Bogota", companyId: fixture.company });
      const historical = await prisma.assignment.findFirstOrThrow({ where: { leadId: fixture.lead } });
      assert.equal(historical.leadScoreId, b.row.id);

      await setContacted(fixture, false);
      await scoreLead(fixture);
      await runAssignmentStage(prisma, { businessDate: "2026-09-14", timeZone: "America/Bogota", companyId: fixture.company });
      await runAssignmentStage(prisma, { businessDate: "2026-09-15", timeZone: "America/Bogota", companyId: fixture.company });

      const assignments = await prisma.assignment.findMany({ where: { leadId: fixture.lead }, orderBy: { assignedFor: "asc" } });
      assert.equal(assignments.length, 2);
      assert.deepEqual(assignments[0], historical, "the earlier assignment must be exactly as it was written");
      assert.equal(assignments[1]?.leadScoreId, a.row.id, "the new business date uses the current score A");
    } finally {
      await removeFixture(fixture);
    }
  }
);

test(
  "integration: the database keeps one current score per lead and version, owned by that lead",
  { skip, timeout: 60_000 },
  async () => {
    const fixture = await createFixture("CUR-DB");
    try {
      await scoreLead(fixture);
      const scores = await prisma.leadScore.findMany({ where: { leadId: { in: [fixture.lead, fixture.otherLead] } } });
      const own = scores.find((row) => row.leadId === fixture.lead);
      const foreign = scores.find((row) => row.leadId === fixture.otherLead);
      assert.ok(own && foreign);

      // A second current score for the same lead and version is rejected.
      await assert.rejects(
        () => prisma.leadCurrentScore.create({
          data: { leadId: fixture.lead, scoreVersion: own.scoreVersion, leadScoreId: own.id }
        }),
        (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
      );
      // The current score of a lead cannot point at another lead's score.
      await assert.rejects(
        () => prisma.leadCurrentScore.update({
          where: { leadId_scoreVersion: { leadId: fixture.lead, scoreVersion: own.scoreVersion } },
          data: { leadScoreId: foreign.id }
        }),
        (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003"
      );
      const pointer = await prisma.leadCurrentScore.findUniqueOrThrow({
        where: { leadId_scoreVersion: { leadId: fixture.lead, scoreVersion: own.scoreVersion } }
      });
      assert.equal(pointer.leadScoreId, own.id);
    } finally {
      await removeFixture(fixture);
    }
  }
);
