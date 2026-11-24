/**
 * Read-only status report of a database before or after a deployment.
 *
 * Reports which migrations are applied, pending or failed (comparing the
 * `_prisma_migrations` table with the migration folders of this checkout),
 * row counts, pipeline runs and the facts needed to choose a scoring
 * evaluation instant. It never writes and never prints credentials or row
 * contents.
 *
 * Usage: bun run ops:db-status --expect-host <host>
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../src/lib/db/client";
import { assertTarget, formatTarget, parseArgs, stringFlag, TargetError } from "./target";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prisma/migrations");

type AppliedMigration = {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
};

async function localMigrations(): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function appliedMigrations(): Promise<AppliedMigration[] | null> {
  const exists = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass(format('%I.%I', current_schema(), '_prisma_migrations')) IS NOT NULL AS present
  `;
  if (!exists[0]?.present) return null;
  return prisma.$queryRaw<AppliedMigration[]>`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    ORDER BY started_at, migration_name
  `;
}

async function tableCounts(): Promise<Record<string, number>> {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
    ORDER BY table_name
  `;
  const counts: Record<string, number> = {};
  for (const { table_name: table } of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM "${table.replaceAll('"', '""')}"`
    );
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const target = assertTarget(process.env.DATABASE_URL, stringFlag(flags, "expect-host"));
  console.log(`Target: ${formatTarget(target)}`);
  if (target.pooled) {
    console.log("Note: this is a pooled connection. Use the direct connection string for `prisma migrate deploy`.");
  }

  const local = await localMigrations();
  const applied = await appliedMigrations();
  console.log("\nMigrations");
  if (applied === null) {
    console.log("  _prisma_migrations does not exist: no migration has been applied to this database.");
    console.log(`  Pending (${local.length}): ${local.join(", ")}`);
  } else {
    const finished = new Set(
      applied.filter((row) => row.finished_at !== null && row.rolled_back_at === null).map((row) => row.migration_name)
    );
    const failed = applied
      .filter((row) => row.finished_at === null && row.rolled_back_at === null)
      .map((row) => row.migration_name);
    const pending = local.filter((name) => !finished.has(name));
    const unknown = [...finished].filter((name) => !local.includes(name));
    console.log(`  Applied (${finished.size}): ${[...finished].join(", ") || "none"}`);
    console.log(`  Pending in this checkout (${pending.length}): ${pending.join(", ") || "none"}`);
    console.log(`  Failed, blocking further deploys (${failed.length}): ${failed.join(", ") || "none"}`);
    console.log(`  Applied but missing from this checkout (${unknown.length}): ${unknown.join(", ") || "none"}`);
  }

  const counts = await tableCounts();
  console.log("\nRow counts");
  console.table(counts);

  if ("PipelineRun" in counts) {
    const byStatus = await prisma.pipelineRun.groupBy({ by: ["status"], _count: { _all: true } });
    console.log("Pipeline runs by status:", JSON.stringify(Object.fromEntries(byStatus.map((row) => [row.status, row._count._all]))));
    const running = await prisma.pipelineRun.count({ where: { status: "RUNNING" } });
    console.log(`Pipeline runs currently RUNNING: ${running}${running > 0 ? "  <-- do not proceed until this is understood" : ""}`);
    const latest = await prisma.pipelineRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 5,
      select: { id: true, status: true, startedAt: true, metadata: true }
    });
    console.log("Latest pipeline runs (scoringDecisionAt is the evaluation instant recorded by that run):");
    console.table(
      latest.map((run) => {
        const scoring = (run.metadata as { scoring?: { decisionAt?: unknown } } | null)?.scoring;
        return {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          scoringDecisionAt: typeof scoring?.decisionAt === "string" ? scoring.decisionAt : "not recorded"
        };
      })
    );
  }

  if ("Lead" in counts) {
    const latestTrusted = await prisma.lead.aggregate({
      where: { registeredAtAmbiguous: false, firstContactAt: null, registeredAt: { not: null } },
      _max: { registeredAt: true }
    });
    const newest = latestTrusted._max.registeredAt;
    console.log("\nScoring reproducibility");
    if (newest) {
      const stableFrom = new Date(newest.getTime() + 24 * 60 * 60 * 1000);
      console.log(`  Newest trusted registration of an uncontacted lead: ${newest.toISOString()}`);
      console.log(`  Any evaluation instant at or after ${stableFrom.toISOString()} yields the same scores (every such lead is already in the 24h+ urgency bucket).`);
    } else {
      console.log("  No uncontacted lead has a trusted registration time; scores do not depend on the evaluation instant.");
    }
  }

  if ("LeadScore" in counts && "LeadCurrentScore" in counts) {
    const expected = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM (SELECT DISTINCT "leadId", "scoreVersion" FROM "LeadScore") pairs
    `;
    console.log(`\nCurrent scores: ${counts.LeadCurrentScore} recorded for ${Number(expected[0]?.count ?? 0)} lead/version pairs with history.`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof TargetError ? error.message : error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
