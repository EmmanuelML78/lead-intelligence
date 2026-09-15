import type { Prisma, PrismaClient } from "@prisma/client";
import type { LeadPriorityScore } from "../../lib/scoring/score-lead";

export type LeadScoreIdentity = {
  leadId: string;
  scoreVersion: string;
  inputFingerprint: string;
};

export type LeadScoreCreate = LeadScoreIdentity & {
  propensityComponent: number;
  intentComponent: number;
  urgencyComponent: number;
  inventoryComponent: number;
  totalScore: number;
  priorityBand: LeadPriorityScore["priorityBand"];
  explanation: LeadPriorityScore["explanation"];
};

export type LeadScoreStore = {
  findByIdentity(identity: LeadScoreIdentity): Promise<{ id: string } | null>;
  create(input: LeadScoreCreate): Promise<{ id: string }>;
  refresh?(id: string, input: LeadScoreCreate): Promise<void>;
};

export type PersistLeadScoreResult = {
  id: string;
  outcome: "created" | "reused";
};

function scoreRow(input: LeadScoreCreate) {
  return {
    leadId: input.leadId,
    propensityComponent: input.propensityComponent,
    intentComponent: input.intentComponent,
    urgencyComponent: input.urgencyComponent,
    inventoryComponent: input.inventoryComponent,
    totalScore: input.totalScore,
    priorityBand: input.priorityBand,
    explanation: input.explanation as unknown as Prisma.InputJsonValue,
    scoreVersion: input.scoreVersion,
    inputFingerprint: input.inputFingerprint
  };
}

export function createPrismaLeadScoreStore(db: PrismaClient): LeadScoreStore {
  return {
    findByIdentity(identity) {
      return db.leadScore.findUnique({
        where: {
          leadId_scoreVersion_inputFingerprint: identity
        },
        select: { id: true }
      });
    },
    create(input) {
      return db.leadScore.create({
        data: scoreRow(input),
        select: { id: true }
      });
    },
    async refresh(id, input) {
      await db.leadScore.update({
        where: { id },
        data: {
          propensityComponent: input.propensityComponent,
          intentComponent: input.intentComponent,
          urgencyComponent: input.urgencyComponent,
          inventoryComponent: input.inventoryComponent,
          totalScore: input.totalScore,
          priorityBand: input.priorityBand,
          explanation: input.explanation as unknown as Prisma.InputJsonValue
        }
      });
    }
  };
}

export async function persistLeadScore(
  store: LeadScoreStore,
  score: LeadPriorityScore
): Promise<PersistLeadScoreResult> {
  const identity = {
    leadId: score.leadId,
    scoreVersion: score.scoreVersion,
    inputFingerprint: score.inputFingerprint
  };
  const payload: LeadScoreCreate = {
    ...identity,
    propensityComponent: score.propensityComponent,
    intentComponent: score.intentComponent,
    urgencyComponent: score.urgencyComponent,
    inventoryComponent: score.inventoryComponent,
    totalScore: score.totalScore,
    priorityBand: score.priorityBand,
    explanation: score.explanation
  };
  const existing = await store.findByIdentity(identity);
  if (existing) {
    await store.refresh?.(existing.id, payload);
    return { id: existing.id, outcome: "reused" };
  }

  try {
    const created = await store.create(payload);
    return { id: created.id, outcome: "created" };
  } catch (error) {
    const raced = await store.findByIdentity(identity);
    if (raced) {
      await store.refresh?.(raced.id, payload);
      return { id: raced.id, outcome: "reused" };
    }
    throw error;
  }
}
