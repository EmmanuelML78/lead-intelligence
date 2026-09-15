import type { LeadChannel, Prisma, PrismaClient, PriorityBand } from "@prisma/client";
import {
  assignmentClockFromEnv,
  formatBusinessDate,
  resolveBusinessDate
} from "../assignment/business-date";
import {
  ASSIGNABLE_LEAD_STATUSES,
  ASSIGNMENT_SCORE_VERSION,
  compareAssignableLeads,
  selectCurrentScore
} from "../assignment/eligibility";
import { isEligibleAssignmentLead, type AssignmentLead } from "../assignment/engine";
import { PRIORITY_SCORE_VERSION } from "../scoring/hybrid";
import { computeCapacityPools, type CapacitySnapshot } from "./capacity";
import type { IssueTypeCount } from "./issues";
import {
  customerLabel,
  motorcycleLabel,
  parseScoreExplanation,
  presentAiExtraction,
  presentAssignment,
  presentConversationMessage,
  presentScoreComponents,
  presentSla,
  type AiExtractionView,
  type AssignmentView,
  type ConversationMessageView,
  type ScoreComponentView,
  type SlaView
} from "./present";
import { displayCompanyName, requireCompanyId, type DemoCompany } from "./tenant";

export const QUEUE_PAGE_SIZE = 75;

export type LeadQueueFilters = {
  salesPointId?: string;
  priorityBand?: PriorityBand;
  assignmentState?: "ASSIGNED" | "WAITING" | "UNASSIGNED";
  channel?: LeadChannel;
  page?: number;
};

export type QueueLeadRow = {
  leadId: string;
  customerName: string;
  companyId: string;
  salesPointId: string;
  channel: string;
  motorcycle: string;
  sla: SlaView;
  aiIntent: string | null;
  assignment: AssignmentView;
  totalScore: number;
  priorityBand: PriorityBand;
};

export type OverviewKpis = {
  companyId: string;
  companyName: string;
  businessDate: string;
  eligibleLeads: number;
  criticalLeads: number;
  assignedToday: number;
  waitingDueToCapacity: number;
  activeAdvisors: number;
  dailyCapacity: number;
  saturatedPoolCount: number;
  poolCount: number;
};

export type OverviewData = {
  kpis: OverviewKpis;
  attentionLeads: QueueLeadRow[];
  latestPipeline: LatestPipelineRun | null;
};

export type LeadQueueResult = {
  companyId: string;
  businessDate: string;
  rows: QueueLeadRow[];
  total: number;
  page: number;
  pageSize: number;
  salesPoints: string[];
};

export type LeadDetail = {
  leadId: string;
  companyId: string;
  companyName: string;
  salesPointId: string;
  customerName: string;
  channel: string;
  status: string;
  motorcycle: string;
  registeredAt: string | null;
  firstContactAt: string | null;
  sla: SlaView;
  score: {
    totalScore: number;
    priorityBand: PriorityBand;
    scoreVersion: string;
    summary: string;
    components: ScoreComponentView[];
  } | null;
  assignment: AssignmentView;
  aiExtraction: AiExtractionView | null;
  conversation: ConversationMessageView[];
};

export type LatestPipelineRun = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  leadsPersisted: number;
  customersPersisted: number;
  conversationsPersisted: number;
  messagesPersisted: number;
};

export type DataQualityData = {
  latestRun: LatestPipelineRun | null;
  issueCounts: IssueTypeCount[];
};

const currentScoreSelect = {
  where: { scoreVersion: PRIORITY_SCORE_VERSION },
  orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
  take: 1,
  select: {
    id: true,
    scoreVersion: true,
    totalScore: true,
    priorityBand: true,
    propensityComponent: true,
    intentComponent: true,
    urgencyComponent: true,
    inventoryComponent: true,
    explanation: true,
    createdAt: true
  }
};

export function leadScopeWhere(
  companyId: string,
  extra: Prisma.LeadWhereInput = {}
): Prisma.LeadWhereInput {
  return { companyId: requireCompanyId(companyId), ...extra };
}

export async function listDemoCompanies(db: PrismaClient): Promise<DemoCompany[]> {
  const rows = await db.company.findMany({
    select: { id: true, name: true },
    orderBy: { id: "asc" }
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? row.id
  }));
}

export async function resolveDemoCompany(
  db: PrismaClient,
  requestedId: string | null | undefined
): Promise<DemoCompany | null> {
  const companies = await listDemoCompanies(db);
  if (companies.length === 0) return null;
  const requested = requestedId?.trim();
  return companies.find((company) => company.id === requested) ?? companies[0] ?? null;
}

export async function resolveDashboardBusinessDate(
  db: PrismaClient,
  companyId: string
): Promise<Date> {
  const scopedCompanyId = requireCompanyId(companyId);
  const clockDate = resolveBusinessDate(assignmentClockFromEnv());
  const forClock = await db.assignment.count({
    where: { assignedFor: clockDate, lead: { companyId: scopedCompanyId } }
  });
  if (forClock > 0) return clockDate;
  const latest = await db.assignment.findFirst({
    where: { lead: { companyId: scopedCompanyId } },
    orderBy: { assignedFor: "desc" },
    select: { assignedFor: true }
  });
  return latest?.assignedFor ?? clockDate;
}

type OperationalLeadRow = {
  id: string;
  companyId: string;
  salesPointId: string;
  channel: string;
  status: string;
  registeredAt: Date | null;
  registeredAtAmbiguous: boolean;
  firstContactAt: Date | null;
  customerNameRaw: string | null;
  normalizedName: string | null;
  motorcycleTextRaw: string | null;
  motorcycleSku: string | null;
  customer: { companyId: string; normalizedName: string | null } | null;
  motorcycle: { sku: string; brand: string; line: string } | null;
  scores: Array<{
    id: string;
    scoreVersion: string;
    totalScore: number;
    priorityBand: PriorityBand;
    explanation: Prisma.JsonValue;
    createdAt: Date;
  }>;
  assignments: Array<{
    reasonCode: AssignmentReasonFromRow;
    explanation: string;
    advisorId: string | null;
    assignedFor: Date;
    advisor: { id: string; name: string; companyId: string } | null;
  }>;
  aiExtractions: Array<{ purchaseIntent: string }>;
};

type AssignmentReasonFromRow = "ASSIGNED" | "NO_ACTIVE_ADVISOR" | "CAPACITY_EXHAUSTED" | "NO_ELIGIBLE_ADVISOR";

async function fetchOperationalLeads(
  db: PrismaClient,
  companyId: string,
  businessDate: Date,
  extra: Prisma.LeadWhereInput = {}
): Promise<OperationalLeadRow[]> {
  return db.lead.findMany({
    where: leadScopeWhere(companyId, extra),
    orderBy: { id: "asc" },
    select: {
      id: true,
      companyId: true,
      salesPointId: true,
      channel: true,
      status: true,
      registeredAt: true,
      registeredAtAmbiguous: true,
      firstContactAt: true,
      customerNameRaw: true,
      normalizedName: true,
      motorcycleTextRaw: true,
      motorcycleSku: true,
      customer: { select: { companyId: true, normalizedName: true } },
      motorcycle: { select: { sku: true, brand: true, line: true } },
      scores: currentScoreSelect,
      assignments: {
        where: { assignedFor: businessDate },
        take: 1,
        select: {
          reasonCode: true,
          explanation: true,
          advisorId: true,
          assignedFor: true,
          advisor: { select: { id: true, name: true, companyId: true } }
        }
      },
      aiExtractions: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { purchaseIntent: true }
      }
    }
  });
}

function toAssignmentLead(row: OperationalLeadRow): AssignmentLead {
  const currentScore = selectCurrentScore(row.scores);
  return {
    leadId: row.id,
    companyId: row.companyId,
    salesPointId: row.salesPointId,
    status: row.status,
    registeredAt: row.registeredAt,
    registeredAtAmbiguous: row.registeredAtAmbiguous,
    currentScore
  };
}

function toQueueRow(row: OperationalLeadRow): QueueLeadRow | null {
  const currentScore = selectCurrentScore(row.scores);
  if (!currentScore) return null;
  const explanation = parseScoreExplanation(currentScore.explanation);
  const customer =
    row.customer && row.customer.companyId === row.companyId ? row.customer : null;
  const assignmentRow = row.assignments[0];
  const advisor =
    assignmentRow?.advisor && assignmentRow.advisor.companyId === row.companyId
      ? assignmentRow.advisor
      : null;
  return {
    leadId: row.id,
    customerName: customerLabel({
      normalizedName: customer?.normalizedName ?? row.normalizedName,
      customerNameRaw: row.customerNameRaw,
      leadId: row.id
    }),
    companyId: row.companyId,
    salesPointId: row.salesPointId,
    channel: row.channel,
    motorcycle: motorcycleLabel({
      brand: row.motorcycle?.brand,
      line: row.motorcycle?.line,
      sku: row.motorcycleSku,
      raw: row.motorcycleTextRaw
    }),
    sla: presentSla({
      bucket: explanation?.urgency.bucket,
      contacted: explanation?.urgency.contacted ?? row.firstContactAt !== null,
      leadAgeMinutes: explanation?.urgency.leadAgeMinutes,
      registeredAtAmbiguous: row.registeredAtAmbiguous
    }),
    aiIntent: row.aiExtractions[0]?.purchaseIntent ?? null,
    assignment: presentAssignment(
      assignmentRow
        ? {
            reasonCode: assignmentRow.reasonCode,
            explanation: assignmentRow.explanation,
            advisorId: advisor?.id ?? assignmentRow.advisorId,
            advisorName: advisor?.name ?? null,
            assignedFor: assignmentRow.assignedFor
          }
        : null
    ),
    totalScore: currentScore.totalScore,
    priorityBand: currentScore.priorityBand
  };
}

function matchesAssignmentFilter(
  row: QueueLeadRow,
  assignmentState: LeadQueueFilters["assignmentState"]
): boolean {
  if (!assignmentState) return true;
  return row.assignment.state === assignmentState;
}

export async function getOverview(
  db: PrismaClient,
  companyId: string
): Promise<OverviewData> {
  const scopedCompanyId = requireCompanyId(companyId);
  const company = await db.company.findUnique({
    where: { id: scopedCompanyId },
    select: { id: true, name: true }
  });
  if (!company) {
    throw new Error(`Company ${scopedCompanyId} was not found`);
  }
  const businessDate = await resolveDashboardBusinessDate(db, scopedCompanyId);
  const [leadRows, advisorRows, salesPoints, latestPipeline] = await Promise.all([
    fetchOperationalLeads(db, scopedCompanyId, businessDate),
    db.advisor.findMany({
      where: { companyId: scopedCompanyId },
      select: {
        id: true,
        name: true,
        salesPointId: true,
        active: true,
        dailyCapacity: true
      }
    }),
    db.salesPoint.findMany({
      where: { companyId: scopedCompanyId },
      select: { id: true }
    }),
    getLatestPipelineRun(db)
  ]);

  const eligibleLeads = leadRows.filter((row) => isEligibleAssignmentLead(toAssignmentLead(row)));
  const capacity = computeCapacityPools({
    salesPointIds: salesPoints.map((row) => row.id),
    advisors: advisorRows.map((advisor) => ({
      advisorId: advisor.id,
      name: advisor.name,
      salesPointId: advisor.salesPointId,
      active: advisor.active,
      dailyCapacity: advisor.dailyCapacity
    })),
    leads: leadRows.map((row) => ({
      leadId: row.id,
      salesPointId: row.salesPointId,
      eligible: isEligibleAssignmentLead(toAssignmentLead(row))
    })),
    assignments: leadRows.flatMap((row) =>
      row.assignments.map((assignment) => ({
        leadId: row.id,
        salesPointId: row.salesPointId,
        advisorId:
          assignment.advisor && assignment.advisor.companyId === scopedCompanyId
            ? assignment.advisorId
            : null,
        reasonCode: assignment.reasonCode
      }))
    )
  });

  const criticalLeads = eligibleLeads.filter((row) => {
    const score = selectCurrentScore(row.scores);
    return score?.priorityBand === "CRITICAL";
  });

  const attentionLeads = [...eligibleLeads]
    .sort((a, b) => compareAssignableLeads(toAssignmentLead(a), toAssignmentLead(b)))
    .map(toQueueRow)
    .filter((row): row is QueueLeadRow => row !== null && row.priorityBand === "CRITICAL")
    .slice(0, 8);

  return {
    kpis: {
      companyId: company.id,
      companyName: displayCompanyName(company),
      businessDate: formatBusinessDate(businessDate),
      eligibleLeads: eligibleLeads.length,
      criticalLeads: criticalLeads.length,
      assignedToday: capacity.assigned,
      waitingDueToCapacity: capacity.waitingDueToCapacity,
      activeAdvisors: capacity.activeAdvisors,
      dailyCapacity: capacity.dailyCapacity,
      saturatedPoolCount: capacity.saturatedPoolCount,
      poolCount: capacity.poolCount
    },
    attentionLeads,
    latestPipeline
  };
}

export async function listLeadQueue(
  db: PrismaClient,
  companyId: string,
  filters: LeadQueueFilters = {}
): Promise<LeadQueueResult> {
  const scopedCompanyId = requireCompanyId(companyId);
  const businessDate = await resolveDashboardBusinessDate(db, scopedCompanyId);
  const extra: Prisma.LeadWhereInput = {
    status: { in: [...ASSIGNABLE_LEAD_STATUSES] },
    ...(filters.salesPointId ? { salesPointId: filters.salesPointId } : {}),
    ...(filters.channel ? { channel: filters.channel } : {})
  };
  const [leadRows, salesPointRows] = await Promise.all([
    fetchOperationalLeads(db, scopedCompanyId, businessDate, extra),
    db.salesPoint.findMany({
      where: { companyId: scopedCompanyId },
      select: { id: true },
      orderBy: { id: "asc" }
    })
  ]);

  const sortedLeads = [...leadRows].sort((a, b) =>
    compareAssignableLeads(
      {
        leadId: a.id,
        registeredAt: a.registeredAt,
        registeredAtAmbiguous: a.registeredAtAmbiguous,
        currentScore: selectCurrentScore(a.scores)
      },
      {
        leadId: b.id,
        registeredAt: b.registeredAt,
        registeredAtAmbiguous: b.registeredAtAmbiguous,
        currentScore: selectCurrentScore(b.scores)
      }
    )
  );

  const rows = sortedLeads
    .map(toQueueRow)
    .filter((row): row is QueueLeadRow => row !== null)
    .filter((row) => (filters.priorityBand ? row.priorityBand === filters.priorityBand : true))
    .filter((row) => matchesAssignmentFilter(row, filters.assignmentState));

  const page = Math.max(1, filters.page ?? 1);
  const start = (page - 1) * QUEUE_PAGE_SIZE;

  return {
    companyId: scopedCompanyId,
    businessDate: formatBusinessDate(businessDate),
    rows: rows.slice(start, start + QUEUE_PAGE_SIZE),
    total: rows.length,
    page,
    pageSize: QUEUE_PAGE_SIZE,
    salesPoints: salesPointRows.map((row) => row.id)
  };
}

export async function getLeadDetail(
  db: PrismaClient,
  companyId: string,
  leadId: string
): Promise<LeadDetail | null> {
  const scopedCompanyId = requireCompanyId(companyId);
  const businessDate = await resolveDashboardBusinessDate(db, scopedCompanyId);
  const lead = await db.lead.findFirst({
    where: leadScopeWhere(scopedCompanyId, { id: leadId }),
    select: {
      id: true,
      companyId: true,
      salesPointId: true,
      channel: true,
      status: true,
      registeredAt: true,
      registeredAtAmbiguous: true,
      firstContactAt: true,
      customerNameRaw: true,
      normalizedName: true,
      motorcycleTextRaw: true,
      motorcycleSku: true,
      company: { select: { id: true, name: true } },
      customer: { select: { companyId: true, normalizedName: true } },
      motorcycle: { select: { sku: true, brand: true, line: true } },
      scores: {
        where: { scoreVersion: PRIORITY_SCORE_VERSION },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          scoreVersion: true,
          totalScore: true,
          priorityBand: true,
          explanation: true,
          createdAt: true
        }
      },
      assignments: {
        where: { assignedFor: businessDate },
        take: 1,
        select: {
          reasonCode: true,
          explanation: true,
          advisorId: true,
          assignedFor: true,
          advisor: { select: { id: true, name: true, companyId: true } }
        }
      },
      aiExtractions: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          motorcycleInterest: true,
          budget: true,
          downPayment: true,
          paymentMethod: true,
          purchaseIntent: true,
          mainObjection: true,
          requestedAppointment: true,
          requestedQuote: true,
          evidence: true
        }
      },
      conversations: {
        where: { isOrphan: false },
        orderBy: { startedAt: "asc" },
        take: 1,
        select: {
          messages: {
            orderBy: { index: "asc" },
            select: {
              id: true,
              index: true,
              sender: true,
              sentTime: true,
              text: true
            }
          }
        }
      }
    }
  });

  if (!lead || lead.companyId !== scopedCompanyId) return null;

  const currentScore = selectCurrentScore(lead.scores);
  const explanation = currentScore ? parseScoreExplanation(currentScore.explanation) : null;
  const customer =
    lead.customer && lead.customer.companyId === scopedCompanyId ? lead.customer : null;
  const assignmentRow = lead.assignments[0];
  const advisor =
    assignmentRow?.advisor && assignmentRow.advisor.companyId === scopedCompanyId
      ? assignmentRow.advisor
      : null;

  return {
    leadId: lead.id,
    companyId: lead.companyId,
    companyName: displayCompanyName(lead.company),
    salesPointId: lead.salesPointId,
    customerName: customerLabel({
      normalizedName: customer?.normalizedName ?? lead.normalizedName,
      customerNameRaw: lead.customerNameRaw,
      leadId: lead.id
    }),
    channel: lead.channel,
    status: lead.status,
    motorcycle: motorcycleLabel({
      brand: lead.motorcycle?.brand,
      line: lead.motorcycle?.line,
      sku: lead.motorcycleSku,
      raw: lead.motorcycleTextRaw
    }),
    registeredAt: lead.registeredAt?.toISOString() ?? null,
    firstContactAt: lead.firstContactAt?.toISOString() ?? null,
    sla: presentSla({
      bucket: explanation?.urgency.bucket,
      contacted: explanation?.urgency.contacted ?? lead.firstContactAt !== null,
      leadAgeMinutes: explanation?.urgency.leadAgeMinutes,
      registeredAtAmbiguous: lead.registeredAtAmbiguous
    }),
    score: currentScore
      ? {
          totalScore: currentScore.totalScore,
          priorityBand: currentScore.priorityBand,
          scoreVersion: currentScore.scoreVersion,
          summary: explanation?.summary ?? "",
          components: presentScoreComponents(explanation)
        }
      : null,
    assignment: presentAssignment(
      assignmentRow
        ? {
            reasonCode: assignmentRow.reasonCode,
            explanation: assignmentRow.explanation,
            advisorId: advisor?.id ?? assignmentRow.advisorId,
            advisorName: advisor?.name ?? null,
            assignedFor: assignmentRow.assignedFor
          }
        : null
    ),
    aiExtraction: presentAiExtraction(lead.aiExtractions[0] ?? null),
    conversation: (lead.conversations[0]?.messages ?? []).map(presentConversationMessage)
  };
}

export async function getCapacity(
  db: PrismaClient,
  companyId: string
): Promise<{ companyId: string; businessDate: string; snapshot: CapacitySnapshot }> {
  const scopedCompanyId = requireCompanyId(companyId);
  const businessDate = await resolveDashboardBusinessDate(db, scopedCompanyId);
  const [salesPoints, advisors, leads] = await Promise.all([
    db.salesPoint.findMany({
      where: { companyId: scopedCompanyId },
      select: { id: true },
      orderBy: { id: "asc" }
    }),
    db.advisor.findMany({
      where: { companyId: scopedCompanyId },
      select: {
        id: true,
        name: true,
        salesPointId: true,
        active: true,
        dailyCapacity: true
      }
    }),
    fetchOperationalLeads(db, scopedCompanyId, businessDate)
  ]);

  return {
    companyId: scopedCompanyId,
    businessDate: formatBusinessDate(businessDate),
    snapshot: computeCapacityPools({
      salesPointIds: salesPoints.map((row) => row.id),
      advisors: advisors.map((advisor) => ({
        advisorId: advisor.id,
        name: advisor.name,
        salesPointId: advisor.salesPointId,
        active: advisor.active,
        dailyCapacity: advisor.dailyCapacity
      })),
      leads: leads.map((row) => ({
        leadId: row.id,
        salesPointId: row.salesPointId,
        eligible: isEligibleAssignmentLead(toAssignmentLead(row))
      })),
      assignments: leads.flatMap((row) =>
        row.assignments.map((assignment) => ({
          leadId: row.id,
          salesPointId: row.salesPointId,
          advisorId:
            assignment.advisor && assignment.advisor.companyId === scopedCompanyId
              ? assignment.advisorId
              : null,
          reasonCode: assignment.reasonCode
        }))
      )
    })
  };
}

export async function getLatestPipelineRun(db: PrismaClient): Promise<LatestPipelineRun | null> {
  const run = await db.pipelineRun.findFirst({
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      leadsPersisted: true,
      customersPersisted: true,
      conversationsPersisted: true,
      messagesPersisted: true
    }
  });
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs:
      run.finishedAt != null ? Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime()) : null,
    leadsPersisted: run.leadsPersisted,
    customersPersisted: run.customersPersisted,
    conversationsPersisted: run.conversationsPersisted,
    messagesPersisted: run.messagesPersisted
  };
}

export async function getDataQuality(db: PrismaClient): Promise<DataQualityData> {
  const [latestRun, grouped] = await Promise.all([
    getLatestPipelineRun(db),
    db.pipelineIssue.groupBy({
      by: ["type"],
      _count: { _all: true }
    })
  ]);

  return {
    latestRun,
    issueCounts: grouped
      .map((row) => ({ type: row.type, count: row._count._all }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  };
}

export { ASSIGNMENT_SCORE_VERSION, PRIORITY_SCORE_VERSION };
