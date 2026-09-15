export type CapacityAdvisorInput = {
  advisorId: string;
  name: string;
  salesPointId: string;
  active: boolean;
  dailyCapacity: number;
};

export type CapacityLeadInput = {
  leadId: string;
  salesPointId: string;
  eligible: boolean;
};

export type CapacityAssignmentInput = {
  leadId: string;
  salesPointId: string;
  advisorId: string | null;
  reasonCode: string;
};

export type AdvisorUtilization = {
  advisorId: string;
  name: string;
  assignedToday: number;
  dailyCapacity: number;
  utilization: number | null;
};

export type SalesPointCapacity = {
  salesPointId: string;
  eligibleLeads: number;
  activeAdvisors: number;
  dailyCapacity: number;
  assigned: number;
  waiting: number;
  waitingDueToCapacity: number;
  utilization: number | null;
  saturated: boolean;
  advisors: AdvisorUtilization[];
};

export type CapacitySnapshot = {
  pools: SalesPointCapacity[];
  poolCount: number;
  saturatedPoolCount: number;
  eligibleLeads: number;
  assigned: number;
  waiting: number;
  waitingDueToCapacity: number;
  activeAdvisors: number;
  dailyCapacity: number;
};

function utilization(assigned: number, capacity: number): number | null {
  if (capacity <= 0) return null;
  return assigned / capacity;
}

/**
 * Operational capacity by sales point.
 *
 * Inactive advisors never contribute daily capacity and are omitted from
 * the advisor list. Saturation is eligible leads vs active daily capacity
 * (same meaning as Milestone 6 overloaded pools).
 */
export function computeCapacityPools(input: {
  salesPointIds: readonly string[];
  advisors: readonly CapacityAdvisorInput[];
  leads: readonly CapacityLeadInput[];
  assignments: readonly CapacityAssignmentInput[];
}): CapacitySnapshot {
  const assignedByAdvisor = new Map<string, number>();
  for (const assignment of input.assignments) {
    if (assignment.reasonCode === "ASSIGNED" && assignment.advisorId) {
      assignedByAdvisor.set(
        assignment.advisorId,
        (assignedByAdvisor.get(assignment.advisorId) ?? 0) + 1
      );
    }
  }

  const advisorsByPoint = new Map<string, CapacityAdvisorInput[]>();
  for (const advisor of input.advisors) {
    const list = advisorsByPoint.get(advisor.salesPointId) ?? [];
    list.push(advisor);
    advisorsByPoint.set(advisor.salesPointId, list);
  }

  const eligibleByPoint = new Map<string, number>();
  for (const lead of input.leads) {
    if (!lead.eligible) continue;
    eligibleByPoint.set(lead.salesPointId, (eligibleByPoint.get(lead.salesPointId) ?? 0) + 1);
  }

  const assignmentsByPoint = new Map<string, CapacityAssignmentInput[]>();
  for (const assignment of input.assignments) {
    const list = assignmentsByPoint.get(assignment.salesPointId) ?? [];
    list.push(assignment);
    assignmentsByPoint.set(assignment.salesPointId, list);
  }

  const salesPointIds = [...new Set(input.salesPointIds)].sort((a, b) => a.localeCompare(b));
  const pools: SalesPointCapacity[] = salesPointIds.map((salesPointId) => {
    const pointAdvisors = (advisorsByPoint.get(salesPointId) ?? []).filter((advisor) => advisor.active);
    const dailyCapacity = pointAdvisors.reduce((sum, advisor) => sum + advisor.dailyCapacity, 0);
    const pointAssignments = assignmentsByPoint.get(salesPointId) ?? [];
    const assigned = pointAssignments.filter(
      (assignment) => assignment.reasonCode === "ASSIGNED" && assignment.advisorId
    ).length;
    const waitingDueToCapacity = pointAssignments.filter(
      (assignment) => assignment.reasonCode === "CAPACITY_EXHAUSTED"
    ).length;
    const waiting = pointAssignments.filter((assignment) => assignment.reasonCode !== "ASSIGNED").length;
    const eligibleLeads = eligibleByPoint.get(salesPointId) ?? 0;
    const advisors: AdvisorUtilization[] = [...pointAdvisors]
      .sort((a, b) => a.name.localeCompare(b.name) || a.advisorId.localeCompare(b.advisorId))
      .map((advisor) => {
        const assignedToday = assignedByAdvisor.get(advisor.advisorId) ?? 0;
        return {
          advisorId: advisor.advisorId,
          name: advisor.name,
          assignedToday,
          dailyCapacity: advisor.dailyCapacity,
          utilization: utilization(assignedToday, advisor.dailyCapacity)
        };
      });

    return {
      salesPointId,
      eligibleLeads,
      activeAdvisors: pointAdvisors.length,
      dailyCapacity,
      assigned,
      waiting,
      waitingDueToCapacity,
      utilization: utilization(assigned, dailyCapacity),
      saturated: eligibleLeads > dailyCapacity,
      advisors
    };
  });

  pools.sort((a, b) => {
    if (a.saturated !== b.saturated) return a.saturated ? -1 : 1;
    const load = (b.utilization ?? -1) - (a.utilization ?? -1);
    if (load !== 0) return load;
    return a.salesPointId.localeCompare(b.salesPointId);
  });

  return {
    pools,
    poolCount: pools.length,
    saturatedPoolCount: pools.filter((pool) => pool.saturated).length,
    eligibleLeads: pools.reduce((sum, pool) => sum + pool.eligibleLeads, 0),
    assigned: pools.reduce((sum, pool) => sum + pool.assigned, 0),
    waiting: pools.reduce((sum, pool) => sum + pool.waiting, 0),
    waitingDueToCapacity: pools.reduce((sum, pool) => sum + pool.waitingDueToCapacity, 0),
    activeAdvisors: pools.reduce((sum, pool) => sum + pool.activeAdvisors, 0),
    dailyCapacity: pools.reduce((sum, pool) => sum + pool.dailyCapacity, 0)
  };
}
