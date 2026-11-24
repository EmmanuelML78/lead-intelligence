/**
 * Content fingerprints of every table, to prove that an operation left
 * existing data untouched.
 *
 * `snapshot <file>` stores, per table, the row count and an MD5 of the full
 * contents of every row (order-independent).
 * `compare <file>` recomputes them and reports each table as unchanged,
 * changed, new or removed. With `--must-match` the command fails when one of
 * the named tables differs; `--must-match all` covers every table that was
 * in the snapshot.
 *
 * The files contain only table names, counts and hashes: no row contents.
 *
 * Usage:
 *   bun run ops:fingerprint snapshot before.json --expect-host <host>
 *   bun run ops:fingerprint compare before.json --expect-host <host> --must-match Assignment,Lead
 */
import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "../../src/lib/db/client";
import { assertTarget, formatTarget, parseArgs, stringFlag, TargetError } from "./target";

type Fingerprint = { rows: number; md5: string };
type Snapshot = { takenAt: string; targetFingerprint: string; tables: Record<string, Fingerprint> };

async function fingerprintTables(): Promise<Record<string, Fingerprint>> {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
    ORDER BY table_name
  `;
  const result: Record<string, Fingerprint> = {};
  for (const { table_name: table } of tables) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const rows = await prisma.$queryRawUnsafe<Array<{ rows: bigint; md5: string }>>(
      `SELECT count(*) AS rows, coalesce(md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))), 'empty') AS md5 FROM ${quoted} t`
    );
    result[table] = { rows: Number(rows[0]?.rows ?? 0), md5: rows[0]?.md5 ?? "empty" };
  }
  return result;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [mode, file] = positional;
  if ((mode !== "snapshot" && mode !== "compare") || !file) {
    throw new TargetError("Usage: table-fingerprints.ts <snapshot|compare> <file> --expect-host <host> [--must-match <tables|all>]");
  }
  const target = assertTarget(process.env.DATABASE_URL, stringFlag(flags, "expect-host"));
  console.log(`Target: ${formatTarget(target)}`);

  const current = await fingerprintTables();
  if (mode === "snapshot") {
    const snapshot: Snapshot = { takenAt: new Date().toISOString(), targetFingerprint: target.fingerprint, tables: current };
    await writeFile(file, JSON.stringify(snapshot, null, 2));
    console.table(current);
    console.log(`Snapshot written to ${file}`);
    return;
  }

  const before = JSON.parse(await readFile(file, "utf8")) as Snapshot;
  if (before.targetFingerprint !== target.fingerprint) {
    console.log("Note: the snapshot was taken with a different DATABASE_URL than the current one.");
  }
  const mustMatchFlag = stringFlag(flags, "must-match");
  const mustMatch = new Set(
    mustMatchFlag === "all"
      ? Object.keys(before.tables)
      : (mustMatchFlag ?? "").split(",").map((name) => name.trim()).filter(Boolean)
  );

  const report: Record<string, { rowsBefore: number | null; rowsAfter: number | null; state: string; required: string }> = {};
  const failures: string[] = [];
  for (const table of new Set([...Object.keys(before.tables), ...Object.keys(current)])) {
    const previous = before.tables[table];
    const now = current[table];
    const state = !previous ? "new" : !now ? "removed" : previous.rows === now.rows && previous.md5 === now.md5 ? "unchanged" : "CHANGED";
    report[table] = {
      rowsBefore: previous?.rows ?? null,
      rowsAfter: now?.rows ?? null,
      state,
      required: mustMatch.has(table) ? "must match" : ""
    };
    if (mustMatch.has(table) && state !== "unchanged") failures.push(`${table} is ${state.toLowerCase()}`);
  }
  for (const table of mustMatch) {
    if (!(table in report)) failures.push(`${table} is not a table in the snapshot or the database`);
  }
  console.table(report);

  if (failures.length > 0) {
    console.error("Fingerprint check FAILED:");
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(mustMatch.size > 0 ? `Fingerprint check passed for: ${[...mustMatch].join(", ")}` : "Comparison complete (no table was required to match).");
}

main()
  .catch((error) => {
    console.error(error instanceof TargetError ? error.message : error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
