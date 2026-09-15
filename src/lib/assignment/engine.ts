import { formatAssignedExplanation, formatUnassignedExplanation } from "./explain";
import { compareAssignableLeads, isAssignableStatus } from "./eligibility";
import {
  chooseAdvisor,
  type AdvisorCapacity
} from "./load-balance";
import type { AssignmentReasonCode, UnassignedReasonCode } from "./types";

export type AssignmentAdvisor = AdvisorCapacity & {
  name: string;
};

export type AssignmentLead = {
  leadId: string;
  companyId: string;
  salesPointId: string;
  status: string;
  registeredAt: Date | null;
  registeredAtAmbiguous: boolean;
  currentScore: {
    id: string;
    scoreVersion: string;
    totalScore: number;
    createdAt: Date;
  } | null;
};

export type ExistingAssignment = {
  id: string;
  leadId: string;
  advisorId: string | null;
  reasonCode: AssignmentReasonCode;
};

export type AssignmentDecision = {
  leadId: string;
  companyId: string;
  salesPointId: string;
  advisorId: string | null;
  leadScoreId: string | null;
  assignedFor: Date;
  reasonCode: AssignmentReasonCode;
  explanation: string;
  outcome: "assigned" | "reused" | "unassigned";
  totalScore: number;
};

export type AssignLeadsInput = {
  leads: readonly AssignmentLead[];
  advisors: readonly AssignmentAdvisor[];
  existing: readonly ExistingAssignment[];
  businessDate: Date;
};

function poolKey(companyId: string, salesPointId: string): string {
  return `${companyId}|${salesPointId}`;
}

function unassignedReason(pool: readonly AssignmentAdvisor[]): UnassignedReasonCode {
  if (pool.length === 0) return "NO_ELIGIBLE_ADVISOR";
  if (!pool.some((advisor) => advisor.active)) return "NO_ACTIVE_ADVISOR";
  return "CAPACITY_EXHAUSTED";
}

export type EligibleAssignmentLead = AssignmentLead & {
  currentScore: NonNullable<AssignmentLead["currentScore"]>;
};

export function isEligibleAssignmentLead(lead: AssignmentLead): lead is EligibleAssignmentLead {
  return isAssignableStatus(lead.status) && lead.currentScore !== null;
}

export function assignLeads(input: AssignLeadsInput): AssignmentDecision[] {
  const advisors: AssignmentAdvisor[] = input.advisors.map((advisor) => ({
    ...advisor,
    assignedToday: 0
  }));
  const advisorsById = new Map(advisors.map((advisor) => [advisor.advisorId, advisor]));
  const pools = new Map<string, AssignmentAdvisor[]>();
  for (const advisor of advisors) {
    const key = poolKey(advisor.companyId, advisor.salesPointId);
    const pool = pools.get(key) ?? [];
    pool.push(advisor);
    pools.set(key, pool);
  }

  const existingByLeadId = new Map(input.existing.map((row) => [row.leadId, row]));
  for (const row of input.existing) {
    if (!row.advisorId) continue;
    const advisor = advisorsById.get(row.advisorId);
    if (advisor) advisor.assignedToday += 1;
  }

  const eligible = input.leads.filter(isEligibleAssignmentLead).sort(compareAssignableLeads);
  const decisions: AssignmentDecision[] = [];

  for (const lead of eligible) {
    const score = lead.currentScore;
    if (!score) continue;
    const existing = existingByLeadId.get(lead.leadId);
    if (existing?.advisorId) {
      const assignedAdvisor = advisorsById.get(existing.advisorId);
      decisions.push({
        leadId: lead.leadId,
        companyId: lead.companyId,
        salesPointId: lead.salesPointId,
        advisorId: existing.advisorId,
        leadScoreId: score.id,
        assignedFor: input.businessDate,
        reasonCode: "ASSIGNED",
        explanation: assignedAdvisor
          ? formatAssignedExplanation({
              advisorId: assignedAdvisor.advisorId,
              companyId: assignedAdvisor.companyId,
              salesPointId: assignedAdvisor.salesPointId,
              assignedToday: Math.max(0, assignedAdvisor.assignedToday - 1),
              dailyCapacity: assignedAdvisor.dailyCapacity
            })
          : `Asignado a ${existing.advisorId}: asignación activa reutilizada.`,
        outcome: "reused",
        totalScore: score.totalScore
      });
      continue;
    }

    const key = poolKey(lead.companyId, lead.salesPointId);
    const pool = pools.get(key) ?? [];
    const chosen = chooseAdvisor(pool, lead.companyId, lead.salesPointId);
    if (!chosen) {
      const reasonCode = unassignedReason(pool);
      decisions.push({
        leadId: lead.leadId,
        companyId: lead.companyId,
        salesPointId: lead.salesPointId,
        advisorId: null,
        leadScoreId: score.id,
        assignedFor: input.businessDate,
        reasonCode,
        explanation: formatUnassignedExplanation(reasonCode, lead.companyId, lead.salesPointId),
        outcome: "unassigned",
        totalScore: score.totalScore
      });
      continue;
    }

    const explanation = formatAssignedExplanation({
      advisorId: chosen.advisorId,
      companyId: chosen.companyId,
      salesPointId: chosen.salesPointId,
      assignedToday: chosen.assignedToday,
      dailyCapacity: chosen.dailyCapacity
    });
    chosen.assignedToday += 1;
    decisions.push({
      leadId: lead.leadId,
      companyId: lead.companyId,
      salesPointId: lead.salesPointId,
      advisorId: chosen.advisorId,
      leadScoreId: score.id,
      assignedFor: input.businessDate,
      reasonCode: "ASSIGNED",
      explanation,
      outcome: "assigned",
      totalScore: score.totalScore
    });
  }

  return decisions;
}
