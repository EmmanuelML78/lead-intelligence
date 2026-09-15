import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../src/lib/db/client";
import { runScoringStage } from "../src/pipeline/scoring-stage";

const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

test(
  "integration: scoring is tenant-scoped, idempotent, and preserves changed-input history",
  { skip },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const companyA = `EMP-SCORE-A-${suffix}`;
    const companyB = `EMP-SCORE-B-${suffix}`;
    const salesPointA = `PV-SCORE-A-${suffix}`;
    const salesPointB = `PV-SCORE-B-${suffix}`;
    const motorcycleSku = `SKU-SCORE-${suffix}`;
    const leadId = `LD-SCORE-${suffix}`;
    const leadBId = `LD-SCORE-B-${suffix}`;
    const decisionAt = new Date("2026-09-14T20:00:00.000Z");

    try {
      await prisma.company.createMany({
        data: [{ id: companyA }, { id: companyB }]
      });
      await prisma.salesPoint.createMany({
        data: [
          { id: salesPointA, companyId: companyA },
          { id: salesPointB, companyId: companyB }
        ]
      });
      await prisma.motorcycle.create({
        data: {
          sku: motorcycleSku,
          brand: "Test",
          line: "Scoped 125",
          displacement: 125,
          segment: "TEST",
          listPrice: 8_000_000
        }
      });
      await prisma.motorcycleInventory.create({
        data: {
          motorcycleSku,
          salesPointId: salesPointB,
          available: true,
          unitsGlobal: 10
        }
      });
      await prisma.lead.create({
        data: {
          id: leadId,
          companyId: companyA,
          salesPointId: salesPointA,
          registeredAt: new Date("2026-09-14T18:00:00.000Z"),
          channel: "WHATSAPP",
          status: "SIN_GESTION",
          motorcycleSku,
          sourceFingerprint: "scoring-integration",
          rawPayload: {}
        }
      });
      await prisma.lead.create({
        data: {
          id: leadBId,
          companyId: companyB,
          salesPointId: salesPointB,
          registeredAt: new Date("2026-09-14T18:00:00.000Z"),
          channel: "WHATSAPP",
          status: "SIN_GESTION",
          motorcycleSku,
          sourceFingerprint: "scoring-integration-b",
          rawPayload: {}
        }
      });

      const first = await runScoringStage(prisma, { companyId: companyA, decisionAt });
      assert.equal(first.report.countScored, 1);
      assert.equal(first.report.created, 1);
      assert.equal(first.scores[0]?.leadId, leadId);
      assert.equal(first.scores[0]?.inventoryComponent, 100);
      assert.equal(first.scores[0]?.explanation.inventory.catalogStatus, "CATALOG_AVAILABLE");
      assert.match(
        first.scores[0]?.explanation.summary ?? "",
        /disponibilidad global en el catálogo/
      );
      assert.doesNotMatch(
        first.scores[0]?.explanation.summary ?? "",
        /punto de venta|sede|esta empresa/
      );

      const identical = await runScoringStage(prisma, { companyId: companyA, decisionAt });
      assert.equal(identical.report.created, 0);
      assert.equal(identical.report.reused, 1);

      await prisma.lead.update({
        where: { id: leadId },
        data: { firstContactAt: new Date("2026-09-14T19:00:00.000Z") }
      });
      const changed = await runScoringStage(prisma, { companyId: companyA, decisionAt });
      assert.equal(changed.report.created, 1);
      assert.equal(changed.scores[0]?.urgencyComponent, 20);

      const tenantScores = await prisma.leadScore.findMany({
        where: { lead: { companyId: companyA } },
        include: { lead: { select: { companyId: true } } }
      });
      assert.equal(tenantScores.length, 2);
      assert.ok(tenantScores.every((score) => score.leadId === leadId));
      assert.ok(tenantScores.every((score) => score.lead.companyId === companyA));
      assert.equal(
        await prisma.leadScore.count({ where: { leadId: leadBId } }),
        0,
        "company A scoring must not persist company B lead scores"
      );
    } finally {
      await prisma.leadScore.deleteMany({ where: { leadId: { in: [leadId, leadBId] } } });
      await prisma.lead.deleteMany({ where: { id: { in: [leadId, leadBId] } } });
      await prisma.motorcycleInventory.deleteMany({ where: { motorcycleSku } });
      await prisma.motorcycle.deleteMany({ where: { sku: motorcycleSku } });
      await prisma.salesPoint.deleteMany({
        where: { id: { in: [salesPointA, salesPointB] } }
      });
      await prisma.company.deleteMany({
        where: { id: { in: [companyA, companyB] } }
      });
    }
  }
);
