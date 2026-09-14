-- Data-quality semantics cleanup: rename columns to match their true
-- semantics (see prisma/schema.prisma comments), preserving any existing
-- values via RENAME instead of Prisma's default drop+recreate.

-- PipelineIssue.occurrenceCount actually counts pipeline EXECUTIONS that
-- re-detected the same issue fingerprint, not source-row occurrences.
ALTER TABLE "PipelineIssue" RENAME COLUMN "occurrenceCount" TO "reobservedRunCount";

-- PipelineRun.ambiguousDates was a field-occurrence count across two date
-- fields (fecha_registro + fecha_primer_contacto), which the old name
-- obscured.
ALTER TABLE "PipelineRun" RENAME COLUMN "ambiguousDates" TO "ambiguousDateFields";

-- New: distinct-lead view of date ambiguity, complementing ambiguousDateFields.
ALTER TABLE "PipelineRun" ADD COLUMN "leadsWithAmbiguousDates" INTEGER NOT NULL DEFAULT 0;

-- New: leads with no stated motorcycle interest at all, tracked separately
-- from unresolvedMotorcycles (non-empty text that couldn't be matched).
ALTER TABLE "PipelineRun" ADD COLUMN "missingMotorcycleInterest" INTEGER NOT NULL DEFAULT 0;
