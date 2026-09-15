import type { AssignmentAdvisor, AssignmentDecision, AssignmentLead } from "./engine";
import { isEligibleAssignmentLead } from "./engine";
import { remainingCapacity } from "./load-balance";
import type { UnassignedReasonCode } from "./types";

export type AssignmentPoolKey = {
  companyId: string;
  salesPointId: string;
};

export type OverloadedPool = AssignmentPoolKey & {
  eligibleLeads: number;
  waitingLeads: number;
  activeAdvisors: number;
  dailyCapacity: number;
  remainingCapacity: number;
  assigned: number;
  unassignedCapacity: number;
};

export type AssignmentAnalysisReport = {
  businessDate: string;
  timeZone: string;
  scoreVersion: string;
  eligibleLeads: number;
  assigned: number;
  reused: number;
  unassigned: number;
  unassignedReasons: Record<UnassignedReasonCode, number>;
  assignmentsByCompany: Record<string, number>;
  assignmentsBySalesPoint: Record<string, number>;
  assignmentsByAdvisor: Record<string, number>;
  utilizationPerAdvisor: Array<{
    advisorId: string;
    companyId: string;
    salesPointId: string;
    active: boolean;
    dailyCapacity: number;
    assignedToday: number;
    remainingCapacity: number;
    normalizedLoad: number | null;
  }>;
  capacityExhaustedPools: OverloadedPool[];
  overloadedPools: OverloadedPool[];
  inactiveAdvisorsReceivingAssignments: number;
  crossCompanyAssignments: number;
  crossSalesPointAssignments: number;
  activeAdvisorCount: number;
  totalDailyCapacity: number;
  unassignedDueToCapacity: number;
};

function poolKey(companyId: string, salesPointId: string): string {
  return `${companyId}|${salesPointId}`;
}

function parsePoolKey(key: string): AssignmentPoolKey {
  const separator = key.indexOf("|");
  return { companyId: key.slice(0, separator), salesPointId: key.slice(separator + 1) };
}

function increment(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export function analyzeAssignments(input: {
  businessDate: string;
  timeZone: string;
  scoreVersion: string;
  leads: readonly AssignmentLead[];
  advisors: readonly AssignmentAdvisor[];
  decisions: readonly AssignmentDecision[];
}): AssignmentAnalysisReport {
  const eligibleLeads = input.leads.filter(isEligibleAssignmentLead);
  const advisorsById = new Map(input.advisors.map((advisor) => [advisor.advisorId, advisor]));
  const assignedCounts = new Map<string, number>();
  const assignmentsByCompany: Record<string, number> = {};
  const assignmentsBySalesPoint: Record<string, number> = {};
  const assignmentsByAdvisor: Record<string, number> = {};
  const unassignedReasons: Record<UnassignedReasonCode, number> = {
    NO_ACTIVE_ADVISOR: 0,
    CAPACITY_EXHAUSTED: 0,
    NO_ELIGIBLE_ADVISOR: 0
  };

  let assigned = 0;
  let reused = 0;
  let unassigned = 0;
  let inactiveAdvisorsReceivingAssignments = 0;
  let crossCompanyAssignments = 0;
  let crossSalesPointAssignments = 0;

  for (const decision of input.decisions) {
    if (decision.reasonCode === "ASSIGNED" && decision.advisorId) {
      assigned += 1;
      if (decision.outcome === "reused") reused += 1;
      increment(assignmentsByCompany, decision.companyId);
      increment(assignmentsBySalesPoint, decision.salesPointId);
      increment(assignmentsByAdvisor, decision.advisorId);
      assignedCounts.set(decision.advisorId, (assignedCounts.get(decision.advisorId) ?? 0) + 1);
      const advisor = advisorsById.get(decision.advisorId);
      if (advisor && !advisor.active) inactiveAdvisorsReceivingAssignments += 1;
      if (advisor && advisor.companyId !== decision.companyId) crossCompanyAssignments += 1;
      if (advisor && advisor.salesPointId !== decision.salesPointId) crossSalesPointAssignments += 1;
    } else if (decision.reasonCode !== "ASSIGNED") {
      unassigned += 1;
      unassignedReasons[decision.reasonCode] += 1;
    }
  }

  const utilizationPerAdvisor = [...input.advisors]
    .sort((a, b) => a.advisorId.localeCompare(b.advisorId))
    .map((advisor) => {
      const assignedToday = assignedCounts.get(advisor.advisorId) ?? 0;
      return {
        advisorId: advisor.advisorId,
        companyId: advisor.companyId,
        salesPointId: advisor.salesPointId,
        active: advisor.active,
        dailyCapacity: advisor.dailyCapacity,
        assignedToday,
        remainingCapacity: remainingCapacity({ dailyCapacity: advisor.dailyCapacity, assignedToday }),
        normalizedLoad: advisor.dailyCapacity > 0 ? assignedToday / advisor.dailyCapacity : null
      };
    });

  const leadsByPool = new Map<string, AssignmentLead[]>();
  for (const lead of eligibleLeads) {
    const key = poolKey(lead.companyId, lead.salesPointId);
    const list = leadsByPool.get(key) ?? [];
    list.push(lead);
    leadsByPool.set(key, list);
  }

  const advisorsByPool = new Map<string, AssignmentAdvisor[]>();
  for (const advisor of input.advisors) {
    const key = poolKey(advisor.companyId, advisor.salesPointId);
    const list = advisorsByPool.get(key) ?? [];
    list.push(advisor);
    advisorsByPool.set(key, list);
  }

  const decisionsByPool = new Map<string, AssignmentDecision[]>();
  for (const decision of input.decisions) {
    const key = poolKey(decision.companyId, decision.salesPointId);
    const list = decisionsByPool.get(key) ?? [];
    list.push(decision);
    decisionsByPool.set(key, list);
  }

  const allPoolKeys = new Set([...leadsByPool.keys(), ...advisorsByPool.keys()]);
  const overloadedPools: OverloadedPool[] = [];
  const capacityExhaustedPools: OverloadedPool[] = [];

  for (const key of [...allPoolKeys].sort()) {
    const { companyId, salesPointId } = parsePoolKey(key);
    const poolAdvisors = advisorsByPool.get(key) ?? [];
    const activeAdvisors = poolAdvisors.filter((advisor) => advisor.active);
    const dailyCapacity = activeAdvisors.reduce((sum, advisor) => sum + advisor.dailyCapacity, 0);
    const poolDecisions = decisionsByPool.get(key) ?? [];
    const assignedInPool = poolDecisions.filter((decision) => decision.reasonCode === "ASSIGNED").length;
    const unassignedCapacity = poolDecisions.filter((decision) => decision.reasonCode === "CAPACITY_EXHAUSTED").length;
    const waitingLeads = poolDecisions.filter((decision) => decision.reasonCode !== "ASSIGNED").length;
    const eligibleInPool = (leadsByPool.get(key) ?? []).length;
    const remaining = Math.max(0, dailyCapacity - assignedInPool);
    const snapshot: OverloadedPool = {
      companyId,
      salesPointId,
      eligibleLeads: eligibleInPool,
      waitingLeads,
      activeAdvisors: activeAdvisors.length,
      dailyCapacity,
      remainingCapacity: remaining,
      assigned: assignedInPool,
      unassignedCapacity
    };
    // Waiting leads that still need a slot vs remaining capacity at start of
    // the run: eligible > active daily capacity, using the cold-start remaining
    // equal to dailyCapacity because analysis counts today's assignments as
    // occupying that capacity. Equivalent: waiting due to capacity > 0 after
    // filling the pool, or eligibleLeads > dailyCapacity.
    if (eligibleInPool > dailyCapacity) overloadedPools.push(snapshot);
    if (unassignedCapacity > 0) capacityExhaustedPools.push(snapshot);
  }

  const activeAdvisors = input.advisors.filter((advisor) => advisor.active);
  return {
    businessDate: input.businessDate,
    timeZone: input.timeZone,
    scoreVersion: input.scoreVersion,
    eligibleLeads: eligibleLeads.length,
    assigned,
    reused,
    unassigned,
    unassignedReasons,
    assignmentsByCompany,
    assignmentsBySalesPoint,
    assignmentsByAdvisor,
    utilizationPerAdvisor,
    capacityExhaustedPools,
    overloadedPools,
    inactiveAdvisorsReceivingAssignments,
    crossCompanyAssignments,
    crossSalesPointAssignments,
    activeAdvisorCount: activeAdvisors.length,
    totalDailyCapacity: activeAdvisors.reduce((sum, advisor) => sum + advisor.dailyCapacity, 0),
    unassignedDueToCapacity: unassignedReasons.CAPACITY_EXHAUSTED
  };
}
