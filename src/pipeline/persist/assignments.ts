import type { AssignmentReason, PrismaClient } from "@prisma/client";
import type { AssignmentDecision } from "../../lib/assignment/engine";

export type PersistAssignmentResult = {
  created: number;
  reused: number;
  updated: number;
};

export async function persistAssignmentDecisions(
  db: PrismaClient,
  decisions: readonly AssignmentDecision[]
): Promise<PersistAssignmentResult> {
  const result: PersistAssignmentResult = { created: 0, reused: 0, updated: 0 };
  if (decisions.length === 0) return result;

  const leadIds = decisions.map((decision) => decision.leadId);
  const assignedFor = decisions[0]?.assignedFor;
  if (!assignedFor) return result;

  await db.$transaction(
    async (tx) => {
      const existingRows = await tx.assignment.findMany({
        where: {
          assignedFor,
          leadId: { in: leadIds }
        },
        select: { id: true, leadId: true, advisorId: true }
      });
      const existingByLeadId = new Map(existingRows.map((row) => [row.leadId, row]));

      for (const decision of decisions) {
        const existing = existingByLeadId.get(decision.leadId);
        if (existing?.advisorId) {
          result.reused += 1;
          continue;
        }

        const data = {
          advisorId: decision.advisorId,
          leadScoreId: decision.leadScoreId,
          reasonCode: decision.reasonCode as AssignmentReason,
          explanation: decision.explanation
        };

        if (existing) {
          await tx.assignment.update({
            where: { id: existing.id },
            data
          });
          result.updated += 1;
          continue;
        }

        await tx.assignment.create({
          data: {
            leadId: decision.leadId,
            assignedFor: decision.assignedFor,
            ...data
          }
        });
        result.created += 1;
      }
    },
    { timeout: 30_000, maxWait: 15_000 }
  );

  return result;
}
