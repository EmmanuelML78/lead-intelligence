-- Track the current score of a lead explicitly, separate from the
-- append-only "LeadScore" history.
--
-- Until now "current" meant "the LeadScore row with the latest createdAt".
-- When a lead's data changed from A to B and back to A, row A was reused
-- (its createdAt is older), so B kept being selected as current.
--
-- "LeadCurrentScore" holds one row per (lead, score version) pointing at the
-- current "LeadScore" row. The composite foreign key guarantees the pointed
-- score belongs to the same lead and version.
--
-- This migration only adds objects and backfills the new table; it does not
-- modify or delete any existing row.

-- CreateTable
CREATE TABLE "LeadCurrentScore" (
    "leadId" TEXT NOT NULL,
    "scoreVersion" TEXT NOT NULL,
    "leadScoreId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadCurrentScore_pkey" PRIMARY KEY ("leadId","scoreVersion")
);

-- CreateIndex
CREATE INDEX "LeadCurrentScore_leadScoreId_idx" ON "LeadCurrentScore"("leadScoreId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadScore_id_leadId_scoreVersion_key" ON "LeadScore"("id", "leadId", "scoreVersion");

-- AddForeignKey
ALTER TABLE "LeadCurrentScore" ADD CONSTRAINT "LeadCurrentScore_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadCurrentScore" ADD CONSTRAINT "LeadCurrentScore_leadScoreId_leadId_scoreVersion_fkey" FOREIGN KEY ("leadScoreId", "leadId", "scoreVersion") REFERENCES "LeadScore"("id", "leadId", "scoreVersion") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: keep exactly what every reader selected before this migration
-- (latest createdAt, then id, per lead and score version), so applying it
-- changes nothing that is displayed or assigned. The next scoring run sets
-- each row from the actual evaluation, which is what corrects any lead
-- affected by the A -> B -> A defect.
INSERT INTO "LeadCurrentScore" ("leadId", "scoreVersion", "leadScoreId", "updatedAt")
SELECT DISTINCT ON (s."leadId", s."scoreVersion")
    s."leadId", s."scoreVersion", s."id", CURRENT_TIMESTAMP
FROM "LeadScore" s
ORDER BY s."leadId", s."scoreVersion", s."createdAt" DESC, s."id" DESC;
