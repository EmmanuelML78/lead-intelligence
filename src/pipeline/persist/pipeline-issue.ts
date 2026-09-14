import type { PrismaClient } from "@prisma/client";
import { issueFingerprint } from "./fingerprint";

export type PipelineIssueSeverity = "INFO" | "WARNING" | "ERROR";

export type PipelineIssueInput = {
  type: string;
  severity: PipelineIssueSeverity;
  entityType?: string | null;
  entityId?: string | null;
  field?: string | null;
  rawValue?: string | null;
  message: string;
};

/**
 * Upserts each issue by its content fingerprint. A rerun of the same
 * unchanged dataset re-derives the same fingerprints, so this increments
 * reobservedRunCount / lastSeenAt on the existing row instead of inserting
 * a new one. reobservedRunCount counts pipeline EXECUTIONS, not source
 * occurrences -- see the schema comment on PipelineIssue. Sequential on
 * purpose: fingerprint is a unique constraint and concurrent upserts for
 * the same fingerprint would race.
 */
export async function persistIssues(db: PrismaClient, pipelineRunId: string, issues: PipelineIssueInput[]): Promise<void> {
  for (const issue of issues) {
    const fingerprint = issueFingerprint(issue);
    await db.pipelineIssue.upsert({
      where: { fingerprint },
      update: {
        reobservedRunCount: { increment: 1 },
        lastSeenAt: new Date(),
        lastSeenPipelineRunId: pipelineRunId
      },
      create: {
        fingerprint,
        type: issue.type,
        severity: issue.severity,
        entityType: issue.entityType ?? null,
        entityId: issue.entityId ?? null,
        field: issue.field ?? null,
        rawValue: issue.rawValue ?? null,
        message: issue.message,
        pipelineRunId,
        lastSeenPipelineRunId: pipelineRunId
      }
    });
  }
}
