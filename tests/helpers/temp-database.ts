/**
 * Disposable PostgreSQL databases for tests that need a specific migration
 * level, built with the real `prisma migrate deploy`.
 *
 * Each database is created next to the one in DATABASE_URL (the role needs
 * CREATEDB) and dropped by the test that created it.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const prismaDir = path.join(repoRoot, "prisma");
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");

export type TempDatabase = {
  name: string;
  url: string;
  drop(): Promise<void>;
};

export type ExtraMigration = { name: string; sql: string };

/** Names of the migrations in the repository, oldest first. */
export function repositoryMigrations(): string[] {
  return readdirSync(path.join(prismaDir, "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function adminUrl(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required to create a temporary database.");
  return value;
}

export async function createTempDatabase(label: string): Promise<TempDatabase> {
  const name = `tmp_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`.toLowerCase();
  const admin = new PrismaClient({ datasourceUrl: adminUrl() });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.$disconnect();
  }
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    async drop() {
      const client = new PrismaClient({ datasourceUrl: adminUrl() });
      try {
        await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.$disconnect();
      }
    }
  };
}

/**
 * Applies migrations with `prisma migrate deploy`.
 *
 * `include` selects which repository migrations to apply (default: all).
 * `extra` adds migrations that do not exist in the repository, to model a
 * database that is ahead of the code.
 */
export function deployMigrations(
  database: TempDatabase,
  options: { include?: (name: string) => boolean; extra?: ExtraMigration[] } = {}
): void {
  const workDir = mkdtempSync(path.join(tmpdir(), "li-migrations-"));
  try {
    cpSync(path.join(prismaDir, "schema.prisma"), path.join(workDir, "schema.prisma"));
    const target = path.join(workDir, "migrations");
    mkdirSync(target);
    cpSync(path.join(prismaDir, "migrations", "migration_lock.toml"), path.join(target, "migration_lock.toml"));
    for (const name of repositoryMigrations()) {
      if (options.include && !options.include(name)) continue;
      cpSync(path.join(prismaDir, "migrations", name), path.join(target, name), { recursive: true });
    }
    for (const migration of options.extra ?? []) {
      mkdirSync(path.join(target, migration.name));
      writeFileSync(path.join(target, migration.name, "migration.sql"), migration.sql);
    }
    const result = spawnSync(
      process.execPath,
      [prismaCli, "migrate", "deploy", "--schema", path.join(workDir, "schema.prisma")],
      { env: { ...process.env, DATABASE_URL: database.url }, encoding: "utf8" }
    );
    if (result.status !== 0) {
      throw new Error(`prisma migrate deploy failed for ${database.name}:\n${result.stdout}\n${result.stderr}`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
