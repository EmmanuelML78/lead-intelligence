/**
 * Shared safety guard for operational scripts.
 *
 * Every ops script must name the database it expects to act on with
 * `--expect-host`. The script refuses to run when DATABASE_URL points
 * anywhere else, so a stale shell variable or a local `.env` file can never
 * silently redirect a command to the wrong database.
 *
 * Only the host, the database name and a short fingerprint are printed.
 * The user name, password and query string are never printed.
 */
import { createHash } from "node:crypto";

export type DatabaseTarget = {
  host: string;
  database: string;
  /** Neon pooled endpoints carry `-pooler` in the host name. */
  pooled: boolean;
  /** First 12 hex chars of sha256(DATABASE_URL): identifies a URL without revealing it. */
  fingerprint: string;
};

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export function describeTarget(databaseUrl: string | undefined): DatabaseTarget {
  const value = databaseUrl?.trim();
  if (!value) throw new TargetError("DATABASE_URL is not set.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TargetError("DATABASE_URL is not a valid URL.");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new TargetError("DATABASE_URL is not a PostgreSQL URL.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !database) {
    throw new TargetError("DATABASE_URL must include a host and a database name.");
  }
  return {
    host: url.hostname,
    database,
    pooled: url.hostname.includes("-pooler"),
    fingerprint: createHash("sha256").update(value).digest("hex").slice(0, 12)
  };
}

/** The expected host must be the full host name or a whole leading label sequence of it. */
export function hostMatches(host: string, expected: string): boolean {
  const wanted = expected.trim().toLowerCase();
  const actual = host.toLowerCase();
  if (!wanted) return false;
  return actual === wanted || actual.startsWith(`${wanted}.`);
}

export function assertTarget(databaseUrl: string | undefined, expectedHost: string | undefined): DatabaseTarget {
  const target = describeTarget(databaseUrl);
  if (!expectedHost?.trim()) {
    throw new TargetError(
      `--expect-host is required. DATABASE_URL currently points at host "${target.host}", database "${target.database}".`
    );
  }
  if (!hostMatches(target.host, expectedHost)) {
    throw new TargetError(
      `Refusing to run: DATABASE_URL points at host "${target.host}", but --expect-host is "${expectedHost.trim()}".`
    );
  }
  return target;
}

export function formatTarget(target: DatabaseTarget): string {
  return `host=${target.host} database=${target.database} connection=${target.pooled ? "pooled" : "direct"} url-fingerprint=${target.fingerprint}`;
}

/** Minimal `--flag value` / `--flag` parser; positional arguments keep their order. */
export function parseArgs(argv: readonly string[]): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { flags, positional };
}

export function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}
