import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ASSIGNMENT_SCORE_VERSION } from "../src/lib/assignment/eligibility";
import { parseBusinessDate } from "../src/lib/assignment/business-date";
import { prisma } from "../src/lib/db/client";
import { getLeadDetail, listLeadQueue } from "../src/lib/dashboard/queries";
import { MissingCompanyIdError } from "../src/lib/dashboard/tenant";

const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

test("dashboard tenant queries reject a missing companyId", () => {
  assert.rejects(() => listLeadQueue(prisma, ""), MissingCompanyIdError);
  assert.rejects(() => getLeadDetail(prisma, "  ", "LD-1"), MissingCompanyIdError);
});

test(
  "integration: company-scoped queue and lead detail never leak another tenant",
  { skip },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const companyA = `EMP-UI-A-${suffix}`;
    const companyB = `EMP-UI-B-${suffix}`;
    const salesPointA = `PV-UI-A-${suffix}`;
    const salesPointB = `PV-UI-B-${suffix}`;
    const advisorA = `AS-UI-A-${suffix}`;
    const leadA = `LD-UI-A-${suffix}`;
    const leadB = `LD-UI-B-${suffix}`;
    const conversationA = `CONV-UI-A-${suffix}`;
    const conversationB = `CONV-UI-B-${suffix}`;
    const assignedFor = parseBusinessDate("2026-09-14");

    try {
      await prisma.company.createMany({
        data: [
          { id: companyA, name: "Company A" },
          { id: companyB, name: "Company B" }
        ]
      });
      await prisma.salesPoint.createMany({
        data: [
          { id: salesPointA, companyId: companyA },
          { id: salesPointB, companyId: companyB }
        ]
      });
      await prisma.advisor.create({
        data: {
          id: advisorA,
          name: "Advisor A",
          companyId: companyA,
          salesPointId: salesPointA,
          dailyCapacity: 5,
          active: true
        }
      });
      await prisma.lead.createMany({
        data: [
          {
            id: leadA,
            companyId: companyA,
            salesPointId: salesPointA,
            channel: "WHATSAPP",
            status: "SIN_GESTION",
            customerNameRaw: "Cliente A",
            sourceFingerprint: `ui-a-${suffix}`,
            rawPayload: {},
            registeredAt: new Date("2026-09-01T00:00:00.000Z")
          },
          {
            id: leadB,
            companyId: companyB,
            salesPointId: salesPointB,
            channel: "WHATSAPP",
            status: "SIN_GESTION",
            customerNameRaw: "Cliente B",
            sourceFingerprint: `ui-b-${suffix}`,
            rawPayload: {},
            registeredAt: new Date("2026-09-01T00:00:00.000Z")
          }
        ]
      });
      await prisma.leadScore.createMany({
        data: [
          {
            leadId: leadA,
            propensityComponent: 20,
            intentComponent: 40,
            urgencyComponent: 100,
            inventoryComponent: 100,
            totalScore: 62,
            priorityBand: "CRITICAL",
            explanation: {
              summary: "current",
              scoreVersion: "hybrid-v1",
              weights: { propensity: 20, intent: 35, urgency: 40, inventory: 5 },
              propensity: { rawProbability: 0.2, artifactVersion: "v1", component: 20, contribution: 4, importantFactors: [] },
              intent: {
                purchaseIntent: "UNKNOWN",
                modifiers: [],
                component: 40,
                usedAiExtraction: false,
                contribution: 14
              },
              urgency: {
                leadAgeMinutes: 2000,
                contacted: false,
                registrationTimeReliable: true,
                bucket: "CRITICAL_24H_PLUS",
                component: 100,
                contribution: 40
              },
              inventory: {
                sku: null,
                catalogStatus: "UNKNOWN",
                available: null,
                unitsGlobal: null,
                component: 50,
                contribution: 2.5
              }
            },
            scoreVersion: ASSIGNMENT_SCORE_VERSION,
            inputFingerprint: `fp-a-current-${suffix}`,
            createdAt: new Date("2026-09-14T18:00:00.000Z")
          },
          {
            leadId: leadA,
            propensityComponent: 10,
            intentComponent: 10,
            urgencyComponent: 10,
            inventoryComponent: 10,
            totalScore: 10,
            priorityBand: "LOW",
            explanation: { summary: "obsolete-other-version" },
            scoreVersion: "hybrid-v0",
            inputFingerprint: `fp-a-oldver-${suffix}`,
            createdAt: new Date("2026-09-15T00:00:00.000Z")
          },
          {
            leadId: leadB,
            propensityComponent: 20,
            intentComponent: 40,
            urgencyComponent: 100,
            inventoryComponent: 100,
            totalScore: 80,
            priorityBand: "CRITICAL",
            explanation: { summary: "other-company" },
            scoreVersion: ASSIGNMENT_SCORE_VERSION,
            inputFingerprint: `fp-b-${suffix}`
          }
        ]
      });
      await prisma.assignment.createMany({
        data: [
          {
            leadId: leadA,
            advisorId: advisorA,
            assignedFor,
            reasonCode: "ASSIGNED",
            explanation: "Asignado a Advisor A."
          },
          {
            leadId: leadB,
            assignedFor,
            reasonCode: "CAPACITY_EXHAUSTED",
            explanation: "Sin asignar: capacidad diaria agotada."
          }
        ]
      });
      await prisma.conversation.createMany({
        data: [
          { id: conversationA, leadId: leadA, sourceLeadId: leadA, isOrphan: false },
          { id: conversationB, leadId: leadB, sourceLeadId: leadB, isOrphan: false }
        ]
      });
      await prisma.message.createMany({
        data: [
          {
            id: `msg-a-${suffix}`,
            conversationId: conversationA,
            index: 0,
            sender: "cliente",
            sentTime: "10:00",
            text: "secret A"
          },
          {
            id: `msg-b-${suffix}`,
            conversationId: conversationB,
            index: 0,
            sender: "cliente",
            sentTime: "10:00",
            text: "secret B"
          }
        ]
      });
      await prisma.aiExtraction.create({
        data: {
          leadId: leadB,
          conversationId: conversationB,
          conversationHash: `hash-b-${suffix}`,
          motorcycleInterest: "Should not leak",
          paymentMethod: "CASH",
          purchaseIntent: "HIGH",
          mainObjection: "NONE",
          requestedAppointment: true,
          requestedQuote: true,
          confidence: 0.9,
          evidence: {},
          provider: "test",
          model: "test",
          promptVersion: "v1",
          extractionVersion: "v1"
        }
      });

      const previous = process.env.ASSIGNMENT_BUSINESS_DATE;
      process.env.ASSIGNMENT_BUSINESS_DATE = "2026-09-14";
      try {
        const queue = await listLeadQueue(prisma, companyA);
        assert.equal(queue.rows.length, 1);
        assert.equal(queue.rows[0]?.leadId, leadA);
        assert.equal(queue.rows.some((row) => row.leadId === leadB), false);
        assert.equal(queue.rows[0]?.totalScore, 62);
        assert.equal(queue.rows[0]?.priorityBand, "CRITICAL");
        assert.equal(queue.rows[0]?.assignment.state, "ASSIGNED");

        const own = await getLeadDetail(prisma, companyA, leadA);
        assert.ok(own);
        assert.equal(own.score?.totalScore, 62);
        assert.equal(own.conversation.some((message) => message.text === "secret A"), true);
        assert.equal(own.conversation.some((message) => message.text === "secret B"), false);
        assert.equal(own.aiExtraction, null);

        const leaked = await getLeadDetail(prisma, companyA, leadB);
        assert.equal(leaked, null);
      } finally {
        if (previous === undefined) delete process.env.ASSIGNMENT_BUSINESS_DATE;
        else process.env.ASSIGNMENT_BUSINESS_DATE = previous;
      }
    } finally {
      await prisma.message.deleteMany({
        where: { conversationId: { in: [conversationA, conversationB] } }
      });
      await prisma.aiExtraction.deleteMany({ where: { leadId: { in: [leadA, leadB] } } });
      await prisma.conversation.deleteMany({ where: { id: { in: [conversationA, conversationB] } } });
      await prisma.assignment.deleteMany({ where: { leadId: { in: [leadA, leadB] } } });
      await prisma.leadScore.deleteMany({ where: { leadId: { in: [leadA, leadB] } } });
      await prisma.lead.deleteMany({ where: { id: { in: [leadA, leadB] } } });
      await prisma.advisor.deleteMany({ where: { id: advisorA } });
      await prisma.salesPoint.deleteMany({ where: { id: { in: [salesPointA, salesPointB] } } });
      await prisma.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
    }
  }
);
