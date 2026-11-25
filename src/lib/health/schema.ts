import { Prisma, type PrismaClient } from "@prisma/client";
import { REQUIRED_MIGRATIONS } from "./required-migrations";

/**
 * Read-only inspection of whether the database has what this build needs.
 *
 * Two independent questions, both answered with catalog queries only:
 *
 * 1. Are the migrations this build expects recorded as applied?
 * 2. Do the tables, columns and enum values the Prisma client was generated
 *    for exist?
 *
 * Both tolerate a database that is ahead of the code: extra migrations and
 * extra tables, columns or enum values are ignored.
 */

export type SchemaInspection = {
  compatible: boolean;
  /** Internal detail for server logs. Never send this to a client. */
  problems: string[];
};

export type RequiredObjects = {
  /** Table name -> column names the generated client reads or writes. */
  tables: Map<string, string[]>;
  /** Enum type name -> labels the generated client can send. */
  enums: Map<string, string[]>;
};

/** What the generated Prisma client requires, taken from its own datamodel. */
export function requiredObjectsFromClient(): RequiredObjects {
  const datamodel = Prisma.dmmf.datamodel;
  const tables = new Map<string, string[]>();
  for (const model of datamodel.models) {
    const columns = model.fields
      .filter((field) => field.kind !== "object")
      .map((field) => field.dbName ?? field.name);
    tables.set(model.dbName ?? model.name, columns);
  }
  const enums = new Map<string, string[]>();
  for (const definition of datamodel.enums) {
    enums.set(
      definition.dbName ?? definition.name,
      definition.values.map((value) => value.dbName ?? value.name)
    );
  }
  return { tables, enums };
}

async function appliedMigrations(db: PrismaClient): Promise<Set<string> | null> {
  const present = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass(format('%I.%I', current_schema(), '_prisma_migrations')) IS NOT NULL AS present
  `;
  if (!present[0]?.present) return null;
  const rows = await db.$queryRaw<Array<{ migration_name: string }>>`
    SELECT migration_name FROM "_prisma_migrations"
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
  `;
  return new Set(rows.map((row) => row.migration_name));
}

export async function inspectSchema(
  db: PrismaClient,
  options: { requiredMigrations?: readonly string[]; requiredObjects?: RequiredObjects } = {}
): Promise<SchemaInspection> {
  const requiredMigrations = options.requiredMigrations ?? REQUIRED_MIGRATIONS;
  const requiredObjects = options.requiredObjects ?? requiredObjectsFromClient();
  const problems: string[] = [];

  const applied = await appliedMigrations(db);
  if (applied === null) {
    problems.push("the migrations table does not exist");
  } else {
    for (const name of requiredMigrations) {
      if (!applied.has(name)) problems.push(`migration not applied: ${name}`);
    }
  }

  const [columnRows, enumRows] = await Promise.all([
    db.$queryRaw<Array<{ table_name: string; column_name: string }>>`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()
    `,
    db.$queryRaw<Array<{ enum_name: string; label: string }>>`
      SELECT t.typname AS enum_name, e.enumlabel AS label
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema()
    `
  ]);

  const existingColumns = new Map<string, Set<string>>();
  for (const row of columnRows) {
    const columns = existingColumns.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    existingColumns.set(row.table_name, columns);
  }
  for (const [table, columns] of requiredObjects.tables) {
    const existing = existingColumns.get(table);
    if (!existing) {
      problems.push(`table missing: ${table}`);
      continue;
    }
    for (const column of columns) {
      if (!existing.has(column)) problems.push(`column missing: ${table}.${column}`);
    }
  }

  const existingLabels = new Map<string, Set<string>>();
  for (const row of enumRows) {
    const labels = existingLabels.get(row.enum_name) ?? new Set<string>();
    labels.add(row.label);
    existingLabels.set(row.enum_name, labels);
  }
  for (const [name, labels] of requiredObjects.enums) {
    const existing = existingLabels.get(name);
    if (!existing) {
      problems.push(`enum missing: ${name}`);
      continue;
    }
    for (const label of labels) {
      if (!existing.has(label)) problems.push(`enum value missing: ${name}.${label}`);
    }
  }

  return { compatible: problems.length === 0, problems };
}
