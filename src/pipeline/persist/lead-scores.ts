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

export type CurrentScoreRef = {
  leadId: string;
  scoreVersion: string;
  leadScoreId: string;
};

/**
 * Two separate concerns:
 * - history: one immutable-identity row per (lead, version, input
 *   fingerprint), found or created, never deleted;
 * - current: which history row is the lead's current score for a version.
 *
 * The current score is whatever the latest evaluation produced, even when
 * that evaluation reuses an older history row.
 */
export type LeadScoreStore = {
  findByIdentity(identity: LeadScoreIdentity): Promise<{ id: string; isCurrent: boolean } | null>;
  /** Inserts a history row and makes it the current score atomically. */
  createAsCurrent(input: LeadScoreCreate): Promise<{ id: string }>;
  refresh?(id: string, input: LeadScoreCreate): Promise<void>;
  /** Points the lead's current score for the version at an existing history row. */
  setCurrent(ref: CurrentScoreRef): Promise<void>;
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

function upsertCurrent(db: Pick<PrismaClient, "leadCurrentScore">, ref: CurrentScoreRef) {
  return db.leadCurrentScore.upsert({
    where: { leadId_scoreVersion: { leadId: ref.leadId, scoreVersion: ref.scoreVersion } },
    create: ref,
    update: { leadScoreId: ref.leadScoreId }
  });
}

export function createPrismaLeadScoreStore(db: PrismaClient): LeadScoreStore {
  return {
    async findByIdentity(identity) {
      const row = await db.leadScore.findUnique({
        where: {
          leadId_scoreVersion_inputFingerprint: identity
        },
        select: { id: true, currentFor: { select: { leadId: true }, take: 1 } }
      });
      return row ? { id: row.id, isCurrent: row.currentFor.length > 0 } : null;
    },
    createAsCurrent(input) {
      return db.$transaction(async (tx) => {
        const created = await tx.leadScore.create({
          data: scoreRow(input),
          select: { id: true }
        });
        await upsertCurrent(tx, {
          leadId: input.leadId,
          scoreVersion: input.scoreVersion,
          leadScoreId: created.id
        });
        return created;
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
    },
    async setCurrent(ref) {
      await upsertCurrent(db, ref);
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

  // Reusing a history row still makes it the current score: this evaluation
  // is the latest one, whatever the row's createdAt says. Skipping the write
  // when it already is current keeps unchanged re-runs free of writes.
  const reuse = async (existing: { id: string; isCurrent: boolean }): Promise<PersistLeadScoreResult> => {
    await store.refresh?.(existing.id, payload);
    if (!existing.isCurrent) {
      await store.setCurrent({
        leadId: identity.leadId,
        scoreVersion: identity.scoreVersion,
        leadScoreId: existing.id
      });
    }
    return { id: existing.id, outcome: "reused" };
  };

  const existing = await store.findByIdentity(identity);
  if (existing) return reuse(existing);

  try {
    const created = await store.createAsCurrent(payload);
    return { id: created.id, outcome: "created" };
  } catch (error) {
    const raced = await store.findByIdentity(identity);
    if (raced) return reuse(raced);
    throw error;
  }
}
