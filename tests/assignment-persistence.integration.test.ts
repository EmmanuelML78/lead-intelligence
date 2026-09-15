import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../src/lib/db/client";
import { ASSIGNMENT_SCORE_VERSION } from "../src/lib/assignment/eligibility";
import { runAssignmentStage } from "../src/pipeline/assignment-stage";

const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

test(
  "integration: assignment is idempotent, tenant-scoped, and date-scoped",
  { skip },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const companyA = `EMP-ASG-A-${suffix}`;
    const companyB = `EMP-ASG-B-${suffix}`;
    const salesPointA = `PV-ASG-A-${suffix}`;
    const salesPointB = `PV-ASG-B-${suffix}`;
    const advisorA = `AS-ASG-A-${suffix}`;
    const advisorB = `AS-ASG-B-${suffix}`;
    const leadA = `LD-ASG-A-${suffix}`;
    const leadB = `LD-ASG-B-${suffix}`;
    const businessDate = "2026-09-14";

    try {
      await prisma.company.createMany({ data: [{ id: companyA }, { id: companyB }] });
      await prisma.salesPoint.createMany({
        data: [
          { id: salesPointA, companyId: companyA },
          { id: salesPointB, companyId: companyB }
        ]
      });
      await prisma.advisor.createMany({
        data: [
          {
            id: advisorA,
            name: "Advisor A",
            companyId: companyA,
            salesPointId: salesPointA,
            dailyCapacity: 2,
            active: true
          },
          {
            id: advisorB,
            name: "Advisor B",
            companyId: companyB,
            salesPointId: salesPointB,
            dailyCapacity: 20,
            active: true
          }
        ]
      });
      await prisma.lead.createMany({
        data: [
          {
            id: leadA,
            companyId: companyA,
            salesPointId: salesPointA,
            channel: "WHATSAPP",
            status: "SIN_GESTION",
            sourceFingerprint: `asg-a-${suffix}`,
            rawPayload: {},
            registeredAt: new Date("2026-09-01T00:00:00.000Z")
          },
          {
            id: leadB,
            companyId: companyB,
            salesPointId: salesPointB,
            channel: "WHATSAPP",
            status: "SIN_GESTION",
            sourceFingerprint: `asg-b-${suffix}`,
            rawPayload: {},
            registeredAt: new Date("2026-09-01T00:00:00.000Z")
          }
        ]
      });
      await prisma.leadScore.createMany({
        data: [
          {
            leadId: leadA,
            propensityComponent: 40,
            intentComponent: 40,
            urgencyComponent: 50,
            inventoryComponent: 50,
            totalScore: 44,
            priorityBand: "MEDIUM",
            explanation: { summary: "test" },
            scoreVersion: ASSIGNMENT_SCORE_VERSION,
            inputFingerprint: `fp-a-${suffix}`
          },
          {
            leadId: leadB,
            propensityComponent: 40,
            intentComponent: 40,
            urgencyComponent: 50,
            inventoryComponent: 50,
            totalScore: 44,
            priorityBand: "MEDIUM",
            explanation: { summary: "test" },
            scoreVersion: ASSIGNMENT_SCORE_VERSION,
            inputFingerprint: `fp-b-${suffix}`
          }
        ]
      });

      const first = await runAssignmentStage(prisma, {
        businessDate,
        timeZone: "America/Bogota",
        companyId: companyA
      });
      assert.equal(first.report.assigned, 1);
      assert.equal(first.report.crossCompanyAssignments, 0);
      assert.equal(first.report.assignmentsByAdvisor[advisorA], 1);
      assert.equal(first.report.assignmentsByAdvisor[advisorB], undefined);

      const assigned = await prisma.assignment.findMany({ where: { leadId: leadA } });
      assert.equal(assigned.length, 1);
      assert.equal(assigned[0]?.advisorId, advisorA);

      const rerun = await runAssignmentStage(prisma, {
        businessDate,
        timeZone: "America/Bogota",
        companyId: companyA
      });
      assert.equal(rerun.report.assigned, 1);
      assert.equal(rerun.report.persist.reused, 1);
      assert.equal(await prisma.assignment.count({ where: { leadId: leadA } }), 1);

      const otherDate = await runAssignmentStage(prisma, {
        businessDate: "2026-09-15",
        timeZone: "America/Bogota",
        companyId: companyA
      });
      assert.equal(otherDate.report.assigned, 1);
      assert.equal(await prisma.assignment.count({ where: { leadId: leadA } }), 2);
    } finally {
      await prisma.assignment.deleteMany({ where: { leadId: { in: [leadA, leadB] } } });
      await prisma.leadScore.deleteMany({ where: { leadId: { in: [leadA, leadB] } } });
      await prisma.lead.deleteMany({ where: { id: { in: [leadA, leadB] } } });
      await prisma.advisor.deleteMany({ where: { id: { in: [advisorA, advisorB] } } });
      await prisma.salesPoint.deleteMany({ where: { id: { in: [salesPointA, salesPointB] } } });
      await prisma.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
    }
  }
);
