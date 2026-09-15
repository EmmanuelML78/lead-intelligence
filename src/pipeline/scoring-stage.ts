import type { PrismaClient } from "@prisma/client";
import { PRIORITY_SCORE_VERSION } from "../lib/scoring/hybrid";
import {
  scoreLeadPriority,
  type InventoryCandidate,
  type LeadPriorityScore,
  type ScoringMotorcycle
} from "../lib/scoring/score-lead";
import { createPrismaLeadScoreStore, persistLeadScore } from "./persist/lead-scores";
import type { PipelineIssueInput } from "./persist/pipeline-issue";

export type ScoringStageReport = {
  scoreVersion: string;
  decisionAt: string;
  countScored: number;
  created: number;
  reused: number;
  failures: number;
  realAiExtraction: number;
  neutralAiFallback: number;
  resolvedInventory: number;
  unresolvedOrMissingInventory: number;
  contacted: number;
  uncontacted: number;
  neutralUrgencyFallback: number;
};

export type ScoringStageResult = {
  report: ScoringStageReport;
  scores: LeadPriorityScore[];
  issues: PipelineIssueInput[];
};

export async function runScoringStage(
  db: PrismaClient,
  options: { companyId?: string; decisionAt?: Date } = {}
): Promise<ScoringStageResult> {
  const decisionAt = options.decisionAt ?? new Date();
  const companyWhere = options.companyId ? { companyId: options.companyId } : undefined;
  const [leads, motorcycleRows, inventoryRows] = await Promise.all([
    db.lead.findMany({
      where: companyWhere,
      orderBy: { id: "asc" },
      select: {
        id: true,
        companyId: true,
        salesPointId: true,
        channel: true,
        registeredAt: true,
        registeredAtAmbiguous: true,
        firstContactAt: true,
        motorcycleSku: true,
        aiExtractions: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            purchaseIntent: true,
            requestedAppointment: true,
            requestedQuote: true,
            downPayment: true,
            paymentMethod: true,
            mainObjection: true,
            confidence: true,
            motorcycleSku: true
          }
        }
      }
    }),
    db.motorcycle.findMany({
      select: { sku: true, brand: true, line: true, listPrice: true }
    }),
    db.motorcycleInventory.findMany({
      select: {
        motorcycleSku: true,
        unitsGlobal: true
      }
    })
  ]);

  const motorcycles = new Map<string, ScoringMotorcycle>(
    motorcycleRows.map((motorcycle) => [motorcycle.sku, motorcycle])
  );
  const inventoryCandidates: InventoryCandidate[] = inventoryRows.map((inventory) => ({
    motorcycleSku: inventory.motorcycleSku,
    unitsGlobal: inventory.unitsGlobal
  }));
  const store = createPrismaLeadScoreStore(db);
  const scores: LeadPriorityScore[] = [];
  const issues: PipelineIssueInput[] = [];
  let created = 0;
  let reused = 0;

  for (const lead of leads) {
    try {
      const score = scoreLeadPriority({
        leadId: lead.id,
        companyId: lead.companyId,
        salesPointId: lead.salesPointId,
        channel: lead.channel,
        registeredAt: lead.registeredAt,
        registeredAtAmbiguous: lead.registeredAtAmbiguous,
        firstContactAt: lead.firstContactAt,
        leadMotorcycleSku: lead.motorcycleSku,
        aiExtraction: lead.aiExtractions[0] ?? null,
        motorcycles,
        inventoryCandidates,
        decisionAt
      });
      const persisted = await persistLeadScore(store, score);
      if (persisted.outcome === "created") created += 1;
      else reused += 1;
      scores.push(score);
    } catch (error) {
      issues.push({
        type: "LEAD_SCORING_FAILED",
        severity: "WARNING",
        entityType: "Lead",
        entityId: lead.id,
        message: `Lead scoring failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  const realAiExtraction = scores.filter(
    (score) => score.explanation.intent.usedAiExtraction
  ).length;
  const resolvedInventory = scores.filter(
    (score) => score.explanation.inventory.catalogStatus !== "UNKNOWN"
  ).length;
  const contacted = scores.filter((score) => score.explanation.urgency.contacted).length;
  const neutralUrgencyFallback = scores.filter(
    (score) => score.explanation.urgency.bucket === "UNKNOWN_REGISTRATION_TIME"
  ).length;
  return {
    scores,
    issues,
    report: {
      scoreVersion: PRIORITY_SCORE_VERSION,
      decisionAt: decisionAt.toISOString(),
      countScored: scores.length,
      created,
      reused,
      failures: issues.length,
      realAiExtraction,
      neutralAiFallback: scores.length - realAiExtraction,
      resolvedInventory,
      unresolvedOrMissingInventory: scores.length - resolvedInventory,
      contacted,
      uncontacted: scores.length - contacted,
      neutralUrgencyFallback
    }
  };
}
