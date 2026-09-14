export type AdvisorCapacity = {
  advisorId: string;
  companyId: string;
  salesPointId: string;
  dailyCapacity: number;
  assignedToday: number;
  active: boolean;
};

export function chooseAdvisor(advisors: AdvisorCapacity[], companyId: string, salesPointId: string): AdvisorCapacity | null {
  const candidates = advisors
    .filter((a) => a.active && a.companyId === companyId && a.salesPointId === salesPointId && a.assignedToday < a.dailyCapacity)
    .sort((a, b) => {
      const loadA = a.assignedToday / Math.max(1, a.dailyCapacity);
      const loadB = b.assignedToday / Math.max(1, b.dailyCapacity);
      return loadA - loadB || b.dailyCapacity - a.dailyCapacity || a.advisorId.localeCompare(b.advisorId);
    });
  return candidates[0] ?? null;
}
