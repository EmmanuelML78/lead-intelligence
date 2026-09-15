import { prisma } from "../src/lib/db/client";
import { assignmentClockFromEnv, formatBusinessDate, resolveBusinessDate } from "../src/lib/assignment/business-date";
import { runAssignmentStage } from "../src/pipeline/assignment-stage";

async function main() {
  const clock = assignmentClockFromEnv();
  const businessDate = resolveBusinessDate(clock);
  const { report, issues } = await runAssignmentStage(prisma, {
    businessDate: formatBusinessDate(businessDate),
    timeZone: clock.timeZone
  });

  const utilization = report.utilizationPerAdvisor.map((row) => ({
    advisorId: row.advisorId,
    companyId: row.companyId,
    salesPointId: row.salesPointId,
    active: row.active,
    assignedToday: row.assignedToday,
    dailyCapacity: row.dailyCapacity,
    remainingCapacity: row.remainingCapacity,
    normalizedLoad:
      row.normalizedLoad === null ? null : Number(row.normalizedLoad.toFixed(4))
  }));

  const output = {
    generatedAt: new Date().toISOString(),
    businessDate: report.businessDate,
    timeZone: report.timeZone,
    scoreVersion: report.scoreVersion,
    eligibleLeads: report.eligibleLeads,
    assigned: report.assigned,
    unassigned: report.unassigned,
    unassignedReasons: report.unassignedReasons,
    assignmentsByCompany: report.assignmentsByCompany,
    assignmentsBySalesPoint: report.assignmentsBySalesPoint,
    assignmentsByAdvisor: report.assignmentsByAdvisor,
    utilizationPerAdvisor: utilization,
    capacityExhaustedPools: report.capacityExhaustedPools,
    overloadedPools: report.overloadedPools,
    inactiveAdvisorsReceivingAssignments: report.inactiveAdvisorsReceivingAssignments,
    crossCompanyAssignments: report.crossCompanyAssignments,
    crossSalesPointAssignments: report.crossSalesPointAssignments,
    capacity: {
      activeAdvisors: report.activeAdvisorCount,
      totalDailyCapacity: report.totalDailyCapacity,
      eligibleLeads: report.eligibleLeads,
      assignedLeads: report.assigned,
      unassignedDueToCapacity: report.unassignedDueToCapacity
    },
    persist: report.persist,
    issues
  };

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
