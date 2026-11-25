import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "../src/lib/db/client";
import { persistConversation } from "../src/pipeline/persist/conversations";
import { buildLeadRecord } from "../src/pipeline/persist/build-lead-record";
import { persistLead } from "../src/pipeline/persist/leads";
import { persistIssues } from "../src/pipeline/persist/pipeline-issue";
import type { RawLead } from "../src/pipeline/types";

// These tests exercise real Postgres writes (upsert idempotency, unique
// constraints). They are skipped when DATABASE_URL is not configured
// instead of failing the whole suite -- see README "Verification" section
// for how to run them once a database is available.
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb ? false : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

function rawLead(overrides: Partial<RawLead>): RawLead {
  return {
    lead_id: "LD-TEST-0001",
    fecha_registro: "2026-08-25",
    canal: "WhatsApp",
    empresa_id: "EMP-TEST",
    punto_venta_id: "PV-TEST",
    nombre_cliente: "Test Customer",
    telefono: "300 111 2222",
    email: "test@example.com",
    ciudad: "Bogota",
    modelo_interes_texto: "",
    estado_gestion: "Sin gestión",
    fecha_primer_contacto: "",
    campania: "",
    ...overrides
  };
}

test("integration: idempotent lead persistence, source-change detection, orphan conversations", { skip, timeout: 60_000 }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const companyId = `EMP-TEST-${suffix}`;
  const salesPointId = `PV-TEST-${suffix}`;
  const leadId = `LD-TEST-${suffix}`;
  const conversationId = `CONV-TEST-${suffix}`;

  try {
    await prisma.company.upsert({ where: { id: companyId }, update: {}, create: { id: companyId } });
    await prisma.salesPoint.upsert({
      where: { id: salesPointId },
      update: { companyId },
      create: { id: salesPointId, companyId }
    });

    // 6. same source row rerun -> no additional Lead ----------------------
    const { record } = buildLeadRecord(rawLead({ lead_id: leadId, empresa_id: companyId, punto_venta_id: salesPointId }), []);
    const first = await persistLead(prisma, record);
    assert.equal(first.result.outcome, "created");
    assert.ok(first.result.customerId);
    // A fixed old timestamp makes an otherwise invisible no-op UPDATE fail deterministically.
    await prisma.customer.update({
      where: { id: first.result.customerId },
      data: { updatedAt: new Date("2000-01-01T00:00:00.000Z") }
    });
    const customerBefore = await prisma.customer.findUniqueOrThrow({ where: { id: first.result.customerId } });
    const leadBefore = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });

    const rerun = await persistLead(prisma, record);
    assert.equal(rerun.result.outcome, "unchanged");
    assert.equal(rerun.result.customerId, first.result.customerId);
    assert.deepEqual(rerun.issues, []);
    assert.deepEqual(await prisma.customer.findUniqueOrThrow({ where: { id: first.result.customerId } }), customerBefore);
    assert.deepEqual(await prisma.lead.findUniqueOrThrow({ where: { id: leadId } }), leadBefore);
    assert.equal(await prisma.lead.count({ where: { id: leadId } }), 1);

    // A nullable existing link must stay null; replay is not an implicit repair.
    const unlinkedBefore = await prisma.lead.update({ where: { id: leadId }, data: { customerId: null } });
    const unlinkedRerun = await persistLead(prisma, record);
    assert.equal(unlinkedRerun.result.outcome, "unchanged");
    assert.equal(unlinkedRerun.result.customerId, null);
    assert.deepEqual(unlinkedRerun.issues, []);
    assert.deepEqual(await prisma.lead.findUniqueOrThrow({ where: { id: leadId } }), unlinkedBefore);
    assert.deepEqual(await prisma.customer.findUniqueOrThrow({ where: { id: first.result.customerId } }), customerBefore);
    assert.equal(await prisma.customer.count({ where: { companyId } }), 1);
    await prisma.lead.update({ where: { id: leadId }, data: { customerId: first.result.customerId } });

    // 10. source record changed -> detectable via issue -------------------
    const { record: changedRecord } = buildLeadRecord(
      rawLead({ lead_id: leadId, empresa_id: companyId, punto_venta_id: salesPointId, nombre_cliente: "Changed Name" }),
      []
    );
    const changed = await persistLead(prisma, changedRecord);
    assert.equal(changed.result.outcome, "updated");
    assert.equal(changed.issues.length, 1);
    assert.equal(changed.issues[0]?.type, "SOURCE_RECORD_CHANGED");
    assert.equal(await prisma.lead.count({ where: { id: leadId } }), 1);
    assert.equal(changed.result.customerId, first.result.customerId);
    const customerChanged = await prisma.customer.findUniqueOrThrow({ where: { id: first.result.customerId } });
    assert.equal(customerChanged.normalizedName, changedRecord.normalizedName);
    assert.deepEqual(customerChanged.createdAt, customerBefore.createdAt);

    // 7. orphan conversation -> persisted and marked isOrphan --------------
    const { result: convResult, issues: convIssues } = await persistConversation(prisma, {
      id: conversationId,
      sourceLeadId: `${leadId}-DOES-NOT-EXIST`,
      leadId: null,
      channel: "WhatsApp",
      startedAt: null,
      messages: [{ index: 0, sender: "cliente", sentTime: "10:00", text: "hola" }]
    });
    assert.equal(convResult.isOrphan, true);
    assert.equal(convIssues[0]?.type, "ORPHAN_CONVERSATION");

    const savedConversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    assert.equal(savedConversation?.isOrphan, true);
    assert.equal(savedConversation?.leadId, null);
  } finally {
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.conversation.deleteMany({ where: { id: conversationId } });
    await prisma.lead.deleteMany({ where: { companyId } });
    await prisma.customer.deleteMany({ where: { companyId } });
    await prisma.salesPoint.deleteMany({ where: { id: salesPointId } });
    await prisma.company.deleteMany({ where: { id: companyId } });
  }
});

test("integration: unchanged source does not overwrite a shared customer updated by another lead", { skip, timeout: 60_000 }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const companyId = `EMP-SHARED-${suffix}`;
  const salesPointId = `PV-SHARED-${suffix}`;
  const base = { empresa_id: companyId, punto_venta_id: salesPointId, nombre_cliente: "Shared Original" };
  const { record: firstRecord } = buildLeadRecord(rawLead({ ...base, lead_id: `LD-SHARED-A-${suffix}` }), []);
  const { record: secondRecord } = buildLeadRecord(rawLead({ ...base, lead_id: `LD-SHARED-B-${suffix}` }), []);
  try {
    await prisma.company.create({ data: { id: companyId } });
    await prisma.salesPoint.create({ data: { id: salesPointId, companyId } });
    const first = await persistLead(prisma, firstRecord);
    const second = await persistLead(prisma, secondRecord);
    assert.equal(first.result.outcome, "created");
    assert.equal(second.result.outcome, "created");
    assert.ok(first.result.customerId);
    assert.equal(second.result.customerId, first.result.customerId);
    const { record: changedRecord } = buildLeadRecord(rawLead({
      ...base, lead_id: firstRecord.id, nombre_cliente: "Shared Updated", ciudad: "Medellin"
    }), []);
    const changed = await persistLead(prisma, changedRecord);
    assert.equal(changed.result.outcome, "updated");
    assert.equal(changed.issues[0]?.type, "SOURCE_RECORD_CHANGED");
    assert.equal(changed.result.customerId, first.result.customerId);
    await prisma.customer.update({ where: { id: first.result.customerId }, data: { updatedAt: new Date("2000-01-01T00:00:00.000Z") } });
    const customerBefore = await prisma.customer.findUniqueOrThrow({ where: { id: first.result.customerId } });
    const secondLeadBefore = await prisma.lead.findUniqueOrThrow({ where: { id: secondRecord.id } });
    assert.equal(customerBefore.normalizedName, changedRecord.normalizedName);
    assert.equal(customerBefore.city, changedRecord.cityNormalized);
    for (const record of [secondRecord, changedRecord]) {
      const repeated = await persistLead(prisma, record);
      assert.equal(repeated.result.outcome, "unchanged");
      assert.equal(repeated.result.customerId, first.result.customerId);
      assert.deepEqual(repeated.issues, []);
      assert.deepEqual(await prisma.customer.findUniqueOrThrow({ where: { id: first.result.customerId } }), customerBefore);
    }
    assert.deepEqual(await prisma.lead.findUniqueOrThrow({ where: { id: secondRecord.id } }), secondLeadBefore);
    assert.equal(await prisma.customer.count({ where: { companyId } }), 1);
  } finally {
    await prisma.lead.deleteMany({ where: { companyId } });
    await prisma.customer.deleteMany({ where: { companyId } });
    await prisma.salesPoint.deleteMany({ where: { id: salesPointId } });
    await prisma.company.deleteMany({ where: { id: companyId } });
  }
});

test("integration: reobservedRunCount increments once per pipeline execution, no duplicate row", { skip, timeout: 60_000 }, async () => {
  const suffix = randomUUID().slice(0, 8);
  const runA = await prisma.pipelineRun.create({ data: { status: "RUNNING" } });
  const runB = await prisma.pipelineRun.create({ data: { status: "RUNNING" } });

  const issue = {
    type: "MISSING_CITY" as const,
    severity: "INFO" as const,
    entityType: "Lead",
    entityId: `LD-REOBSERVE-${suffix}`,
    field: "ciudad",
    rawValue: null,
    message: `Lead LD-REOBSERVE-${suffix} has no usable city value.`
  };

  try {
    // Run 1 observes the issue for the first time.
    await persistIssues(prisma, runA.id, [issue]);
    const afterRun1 = await prisma.pipelineIssue.findMany({ where: { entityId: issue.entityId } });
    assert.equal(afterRun1.length, 1);
    assert.equal(afterRun1[0]?.reobservedRunCount, 1);
    assert.equal(afterRun1[0]?.pipelineRunId, runA.id, "first-seen run is recorded");

    // Run 2 re-derives the exact same issue (unchanged dataset).
    await persistIssues(prisma, runB.id, [issue]);
    const afterRun2 = await prisma.pipelineIssue.findMany({ where: { entityId: issue.entityId } });
    assert.equal(afterRun2.length, 1, "no duplicate row for the same fingerprint");
    assert.equal(afterRun2[0]?.reobservedRunCount, 2);
    assert.equal(afterRun2[0]?.pipelineRunId, runA.id, "first-seen run is unchanged");
    assert.equal(afterRun2[0]?.lastSeenPipelineRunId, runB.id, "last-seen run is updated");
  } finally {
    await prisma.pipelineIssue.deleteMany({ where: { entityId: issue.entityId } });
    await prisma.pipelineRun.deleteMany({ where: { id: { in: [runA.id, runB.id] } } });
  }
});
