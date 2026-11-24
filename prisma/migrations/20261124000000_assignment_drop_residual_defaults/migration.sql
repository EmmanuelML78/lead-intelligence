-- Align "Assignment" with prisma/schema.prisma.
--
-- Migration 20260915020000_advisor_assignment added "reasonCode" and
-- "explanation" as NOT NULL columns with defaults so existing rows could be
-- backfilled, and never removed those defaults. Every writer supplies both
-- values, so the defaults only allowed a write that bypasses the application
-- to record an assignment with a fabricated reason ('ASSIGNED') or an empty
-- explanation.
--
-- DROP DEFAULT is a catalog-only change: it does not rewrite the table and
-- does not read or modify existing rows.
--
-- The "Assignment_advisorId_fkey" constraint is intentionally left as
-- ON DELETE RESTRICT; schema.prisma now declares it explicitly.
ALTER TABLE "Assignment"
  ALTER COLUMN "reasonCode" DROP DEFAULT,
  ALTER COLUMN "explanation" DROP DEFAULT;
