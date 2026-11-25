import type { PrismaClient } from "@prisma/client";
import { inspectSchema, type SchemaInspection } from "./schema";

/**
 * Health of the application as seen by a client.
 *
 * The body carries three fixed words and nothing else: no versions, no
 * names, no counts, no error text. What exactly is wrong goes to the server
 * log.
 */
export type HealthBody =
  | { status: "ok"; database: "reachable"; schema: "compatible" }
  | { status: "error"; database: "reachable"; schema: "incompatible" }
  | { status: "error"; database: "unreachable"; schema: "unknown" };

export type HealthResult = {
  httpStatus: 200 | 503;
  body: HealthBody;
};

export type HealthProbes = {
  /** Cheap reachability check; rejects when the database cannot be reached. */
  ping(): Promise<void>;
  /** Schema compatibility; may run several catalog queries. */
  inspectSchema(): Promise<SchemaInspection>;
};

export type HealthCheckerOptions = {
  /** How long a "compatible" answer is reused. */
  compatibleTtlMs?: number;
  /** How long an "incompatible" answer is reused. Short, so a fix shows up quickly. */
  incompatibleTtlMs?: number;
  /** A database that has not answered within this time is reported as unreachable. */
  pingTimeoutMs?: number;
  inspectTimeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
};

const DEFAULT_COMPATIBLE_TTL_MS = 30_000;
const DEFAULT_INCOMPATIBLE_TTL_MS = 5_000;
const DEFAULT_PING_TIMEOUT_MS = 3_000;
const DEFAULT_INSPECT_TIMEOUT_MS = 5_000;

class ProbeTimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
  });
  // The slow query is left to finish or fail on its own; its result is ignored.
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const OK: HealthResult = { httpStatus: 200, body: { status: "ok", database: "reachable", schema: "compatible" } };
const INCOMPATIBLE: HealthResult = {
  httpStatus: 503,
  body: { status: "error", database: "reachable", schema: "incompatible" }
};
const UNREACHABLE: HealthResult = {
  httpStatus: 503,
  body: { status: "error", database: "unreachable", schema: "unknown" }
};

/**
 * Builds the health check.
 *
 * Reachability is checked on every call with one trivial query, bounded by
 * a timeout so a database that hangs is reported instead of awaited. The schema
 * inspection, which is several catalog queries, is cached: a deployed
 * schema does not change between requests, only across deployments and
 * migrations. The check never writes.
 */
export function createHealthChecker(probes: HealthProbes, options: HealthCheckerOptions = {}) {
  const compatibleTtlMs = options.compatibleTtlMs ?? DEFAULT_COMPATIBLE_TTL_MS;
  const incompatibleTtlMs = options.incompatibleTtlMs ?? DEFAULT_INCOMPATIBLE_TTL_MS;
  const pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const inspectTimeoutMs = options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));

  let cached: { compatible: boolean; expiresAt: number } | null = null;
  let lastLogged: string | null = null;

  return async function check(): Promise<HealthResult> {
    try {
      await withTimeout(probes.ping(), pingTimeoutMs);
    } catch {
      // Do not trust an earlier schema answer once the database is back.
      cached = null;
      return UNREACHABLE;
    }

    if (cached && now() < cached.expiresAt) {
      return cached.compatible ? OK : INCOMPATIBLE;
    }

    let inspection: SchemaInspection;
    try {
      inspection = await withTimeout(probes.inspectSchema(), inspectTimeoutMs);
    } catch (error) {
      // Not answering is a reachability problem, and says nothing about the schema.
      if (error instanceof ProbeTimeoutError) return UNREACHABLE;
      inspection = { compatible: false, problems: ["the schema could not be inspected"] };
    }

    cached = {
      compatible: inspection.compatible,
      expiresAt: now() + (inspection.compatible ? compatibleTtlMs : incompatibleTtlMs)
    };

    // One log line per distinct state, not one per request.
    const summary = inspection.compatible ? "compatible" : inspection.problems.join("; ");
    if (summary !== lastLogged) {
      lastLogged = summary;
      if (!inspection.compatible) {
        log(`[health] database schema is not compatible with this build: ${summary}`);
      }
    }

    return inspection.compatible ? OK : INCOMPATIBLE;
  };
}

export function prismaHealthProbes(db: PrismaClient): HealthProbes {
  return {
    async ping() {
      await db.$queryRaw`SELECT 1`;
    },
    inspectSchema() {
      return inspectSchema(db);
    }
  };
}
