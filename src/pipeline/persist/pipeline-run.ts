import type { Prisma, PrismaClient } from "@prisma/client";

export type PipelineRunCounters = {
  leadsReceived: number;
  leadsPersisted: number;
  customersPersisted: number;
  conversationsPersisted: number;
  messagesPersisted: number;
  duplicateLeadIds: number;
  duplicateCustomerGroups: number;
  /** Field-occurrence count: a lead ambiguous on both date fields counts as 2. */
  ambiguousDateFields: number;
  /** Distinct canonical leads with >=1 ambiguous date field (<= ambiguousDateFields). */
  leadsWithAmbiguousDates: number;
  missingCities: number;
  /** Non-empty motorcycle-interest text that couldn't be safely matched to the catalog. */
  unresolvedMotorcycles: number;
  /** Motorcycle-interest text that was null/empty/whitespace -- not "unresolved". */
  missingMotorcycleInterest: number;
  orphanConversations: number;
  sourceRecordChanged: number;
  warnings: number;
  errors: number;
};

export const emptyCounters: PipelineRunCounters = {
  leadsReceived: 0,
  leadsPersisted: 0,
  customersPersisted: 0,
  conversationsPersisted: 0,
  messagesPersisted: 0,
  duplicateLeadIds: 0,
  duplicateCustomerGroups: 0,
  ambiguousDateFields: 0,
  leadsWithAmbiguousDates: 0,
  missingCities: 0,
  unresolvedMotorcycles: 0,
  missingMotorcycleInterest: 0,
  orphanConversations: 0,
  sourceRecordChanged: 0,
  warnings: 0,
  errors: 0
};

// A new row every execution is intentional: PipelineRun is operational
// history, not a deduplicated entity.
export async function createPipelineRun(db: PrismaClient) {
  return db.pipelineRun.create({ data: { status: "RUNNING" } });
}

export const INTERRUPTED_RUN_REASON =
  "Interrupted: the process ended before the run was finalized.";

/**
 * Closes runs left in RUNNING by a process that died before finalizing.
 *
 * Call it only while holding the pipeline's exclusive lock: under the lock
 * no other run can be in progress, so every RUNNING row is a leftover.
 */
export async function failInterruptedRuns(db: PrismaClient): Promise<number> {
  const result = await db.pipelineRun.updateMany({
    where: { status: "RUNNING" },
    data: { status: "FAILED", finishedAt: new Date(), failureReason: INTERRUPTED_RUN_REASON }
  });
  return result.count;
}

export async function finalizePipelineRun(
  db: PrismaClient,
  id: string,
  status: "SUCCESS" | "FAILED",
  counters: PipelineRunCounters,
  failureReason?: string | null,
  metadata?: Record<string, unknown> | null
) {
  return db.pipelineRun.update({
    where: { id },
    data: {
      status,
      finishedAt: new Date(),
      failureReason: failureReason ?? null,
      metadata: metadata ? (metadata as Prisma.InputJsonValue) : undefined,
      ...counters
    }
  });
}
