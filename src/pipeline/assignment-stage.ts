import type { PrismaClient } from "@prisma/client";
import { analyzeAssignments, type AssignmentAnalysisReport } from "../lib/assignment/analyze";
import {
  assignmentClockFromEnv,
  formatBusinessDate,
  resolveBusinessDate,
  type AssignmentClock
} from "../lib/assignment/business-date";
import { ASSIGNMENT_SCORE_VERSION, selectCurrentScore } from "../lib/assignment/eligibility";
import { assignLeads, type AssignmentAdvisor, type AssignmentLead } from "../lib/assignment/engine";
import type { PersistAssignmentResult } from "./persist/assignments";
import { persistAssignmentDecisions } from "./persist/assignments";
import type { PipelineIssueInput } from "./persist/pipeline-issue";

export type AssignmentStageReport = AssignmentAnalysisReport & {
  persist: PersistAssignmentResult;
};

export type AssignmentStageResult = {
  report: AssignmentStageReport;
  issues: PipelineIssueInput[];
};

export type AssignmentStageOptions = AssignmentClock & {
  companyId?: string;
  persist?: boolean;
};

export async function runAssignmentStage(
  db: PrismaClient,
  options: AssignmentStageOptions = {}
): Promise<AssignmentStageResult> {
  const clock = {
    businessDate: options.businessDate,
    now: options.now,
    timeZone: options.timeZone
  };
  const resolvedClock =
    options.businessDate || options.now || options.timeZone
      ? clock
      : assignmentClockFromEnv();
  const businessDate = resolveBusinessDate(resolvedClock);
  const timeZone = resolvedClock.timeZone ?? assignmentClockFromEnv().timeZone ?? "America/Bogota";
  const companyWhere = options.companyId ? { companyId: options.companyId } : undefined;
  const persist = options.persist ?? true;

  const [advisorRows, leadRows, existingRows] = await Promise.all([
    db.advisor.findMany({
      where: companyWhere,
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        companyId: true,
        salesPointId: true,
        dailyCapacity: true,
        active: true
      }
    }),
    db.lead.findMany({
      where: companyWhere,
      orderBy: { id: "asc" },
      select: {
        id: true,
        companyId: true,
        salesPointId: true,
        status: true,
        registeredAt: true,
        registeredAtAmbiguous: true,
        scores: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            scoreVersion: true,
            totalScore: true,
            createdAt: true
          }
        }
      }
    }),
    db.assignment.findMany({
      where: {
        assignedFor: businessDate,
        ...(options.companyId ? { lead: { companyId: options.companyId } } : {})
      },
      select: {
        id: true,
        leadId: true,
        advisorId: true,
        reasonCode: true
      }
    })
  ]);

  const advisors: AssignmentAdvisor[] = advisorRows.map((advisor) => ({
    advisorId: advisor.id,
    name: advisor.name,
    companyId: advisor.companyId,
    salesPointId: advisor.salesPointId,
    dailyCapacity: advisor.dailyCapacity,
    assignedToday: 0,
    active: advisor.active
  }));

  const leads: AssignmentLead[] = leadRows.map((lead) => {
    const currentScore = selectCurrentScore(lead.scores);
    return {
      leadId: lead.id,
      companyId: lead.companyId,
      salesPointId: lead.salesPointId,
      status: lead.status,
      registeredAt: lead.registeredAt,
      registeredAtAmbiguous: lead.registeredAtAmbiguous,
      currentScore
    };
  });

  const decisions = assignLeads({
    leads,
    advisors,
    existing: existingRows.map((row) => ({
      id: row.id,
      leadId: row.leadId,
      advisorId: row.advisorId,
      reasonCode: row.reasonCode
    })),
    businessDate
  });

  let persistResult: PersistAssignmentResult = { created: 0, reused: 0, updated: 0 };
  const issues: PipelineIssueInput[] = [];
  if (persist) {
    try {
      persistResult = await persistAssignmentDecisions(db, decisions);
    } catch (error) {
      issues.push({
        type: "ASSIGNMENT_PERSIST_FAILED",
        severity: "ERROR",
        message: `Assignment persistence failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  const analysis = analyzeAssignments({
    businessDate: formatBusinessDate(businessDate),
    timeZone,
    scoreVersion: ASSIGNMENT_SCORE_VERSION,
    leads,
    advisors,
    decisions
  });

  return {
    issues,
    report: {
      ...analysis,
      persist: persistResult
    }
  };
}
