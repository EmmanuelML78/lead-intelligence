-- Milestone 6: persist assignment outcomes (including unassigned reasons)
-- so the dashboard can explain waiting leads. assignedFor remains a
-- date-only timestamp. advisorId is nullable for unassigned rows.

CREATE TYPE "AssignmentReason" AS ENUM ('ASSIGNED', 'NO_ACTIVE_ADVISOR', 'CAPACITY_EXHAUSTED', 'NO_ELIGIBLE_ADVISOR');

ALTER TABLE "Assignment" ALTER COLUMN "advisorId" DROP NOT NULL;

ALTER TABLE "Assignment" ADD COLUMN "leadScoreId" TEXT;
ALTER TABLE "Assignment" ADD COLUMN "reasonCode" "AssignmentReason" NOT NULL DEFAULT 'ASSIGNED';
ALTER TABLE "Assignment" ADD COLUMN "explanation" TEXT NOT NULL DEFAULT '';

ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_leadScoreId_fkey" FOREIGN KEY ("leadScoreId") REFERENCES "LeadScore"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Assignment_reasonCode_assignedFor_idx" ON "Assignment"("reasonCode", "assignedFor");
