/**
 * Pipeline idempotency check for CI.
 *
 * `snapshot <file>` records the row count of every application table.
 * `compare <file>` fails unless a later pipeline run left every table at the
 * same row count, with exactly one additional SUCCESS PipelineRun.
 * Never prints connection strings or row contents.
 *
 * Usage:
 *   bun run scripts/ci-idempotency-check.ts snapshot counts.json
 *   bun run scripts/ci-idempotency-check.ts compare counts.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "../src/lib/db/client";

const RUN_TABLE = "PipelineRun";
const IGNORED_TABLES = new Set(["_prisma_migrations"]);

type Counts = Record<string, number>;

async function countTables(): Promise<Counts> {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  const counts: Counts = {};
  for (const { table_name: table } of tables) {
    if (IGNORED_TABLES.has(table)) continue;
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM "${table.replaceAll('"', '""')}"`
    );
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if ((mode !== "snapshot" && mode !== "compare") || !file) {
    throw new Error("Usage: ci-idempotency-check.ts <snapshot|compare> <file>");
  }

  const current = await countTables();
  if (mode === "snapshot") {
    await writeFile(file, JSON.stringify(current, null, 2));
    console.table(current);
    return;
  }

  const before = JSON.parse(await readFile(file, "utf8")) as Counts;
  const failures: string[] = [];
  const report: Record<string, { before: number; after: number; expected: number }> = {};

  for (const table of new Set([...Object.keys(before), ...Object.keys(current)])) {
    const previous = before[table] ?? 0;
    const after = current[table] ?? 0;
    const expected = table === RUN_TABLE ? previous + 1 : previous;
    report[table] = { before: previous, after, expected };
    if (after !== expected) {
      failures.push(`${table}: expected ${expected} rows after the second run, found ${after}`);
    }
  }
  console.table(report);

  const emptyTables = Object.entries(current).filter(([, count]) => count === 0).map(([table]) => table);
  console.log("Tables with no rows (informational):", emptyTables.length > 0 ? emptyTables.join(", ") : "none");

  const runs = await prisma.pipelineRun.groupBy({ by: ["status"], _count: { _all: true } });
  const notSuccessful = runs.filter((row) => row.status !== "SUCCESS");
  if (notSuccessful.length > 0) {
    failures.push(`PipelineRun rows with a non-SUCCESS status: ${JSON.stringify(notSuccessful)}`);
  }

  if (failures.length > 0) {
    console.error("Idempotency check FAILED:");
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("Idempotency check passed: the second run created no additional rows.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
