/**
 * Migrations this build of the application expects to find applied.
 *
 * The health check reports the schema as incompatible while any of these is
 * missing from the database. Migrations applied to the database that are not
 * listed here are ignored, so a database that is ahead of the code (an
 * additive migration applied before its code is deployed) stays healthy.
 *
 * The deployed bundle does not contain the `prisma/migrations` folder, so the
 * list is kept here. `tests/health.test.ts` fails when it differs from that
 * folder: add the new name in the same commit as the migration.
 */
export const REQUIRED_MIGRATIONS: readonly string[] = [
  "20260914000000_init",
  "20260914231554_data_quality_semantics_cleanup",
  "20260914235000_ai_conversation_intelligence",
  "20260915010000_hybrid_priority_engine",
  "20260915020000_advisor_assignment",
  "20261124000000_assignment_drop_residual_defaults",
  "20261124010000_lead_current_score"
];
