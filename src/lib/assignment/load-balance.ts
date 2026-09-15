export type AdvisorCapacity = {
  advisorId: string;
  companyId: string;
  salesPointId: string;
  dailyCapacity: number;
  assignedToday: number;
  active: boolean;
};

export function remainingCapacity(advisor: Pick<AdvisorCapacity, "dailyCapacity" | "assignedToday">): number {
  return Math.max(0, advisor.dailyCapacity - advisor.assignedToday);
}

export function normalizedLoad(assignedToday: number, dailyCapacity: number): number {
  if (dailyCapacity <= 0) return Number.POSITIVE_INFINITY;
  return assignedToday / dailyCapacity;
}

export function isEligibleAdvisor(
  advisor: AdvisorCapacity,
  companyId: string,
  salesPointId: string
): boolean {
  return (
    advisor.active &&
    advisor.companyId === companyId &&
    advisor.salesPointId === salesPointId &&
    remainingCapacity(advisor) > 0
  );
}

/**
 * Lowest normalized utilization wins.
 * Ties: assignmentsToday ASC, then advisorId ASC.
 */
export function compareAdvisorLoad(a: AdvisorCapacity, b: AdvisorCapacity): number {
  const load = normalizedLoad(a.assignedToday, a.dailyCapacity) - normalizedLoad(b.assignedToday, b.dailyCapacity);
  if (load !== 0) return load;
  if (a.assignedToday !== b.assignedToday) return a.assignedToday - b.assignedToday;
  return a.advisorId.localeCompare(b.advisorId);
}

export function chooseAdvisor(
  advisors: readonly AdvisorCapacity[],
  companyId: string,
  salesPointId: string
): AdvisorCapacity | null {
  const candidates = advisors.filter((advisor) => isEligibleAdvisor(advisor, companyId, salesPointId));
  if (candidates.length === 0) return null;
  return [...candidates].sort(compareAdvisorLoad)[0] ?? null;
}
