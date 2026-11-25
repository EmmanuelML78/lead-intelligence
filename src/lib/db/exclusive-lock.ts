import { PrismaClient } from "@prisma/client";

/**
 * Mutual exclusion for operations that write scores or assignments.
 *
 * Mechanism: a PostgreSQL session-level advisory lock, taken with
 * `pg_try_advisory_lock` on a dedicated connection that stays open for the
 * whole operation.
 *
 * - The lock belongs to the database session. When the process ends for any
 *   reason (exception, Ctrl+C, kill, crash) its connection closes and
 *   PostgreSQL releases the lock by itself. There is no lease to expire and
 *   nothing to clean up.
 * - No transaction is kept open: the session is idle between heartbeats.
 * - Prisma multiplexes queries over a pool and does not pin a connection, so
 *   the lock uses its own client limited to exactly one connection.
 * - A session lock does not survive a transaction-mode pooler (PgBouncer,
 *   Neon's `-pooler` endpoint), where consecutive statements may run on
 *   different server sessions. The lock therefore requires a direct
 *   connection and refuses a pooled one.
 * - If that one connection is ever replaced (network drop, server restart),
 *   the lock is gone. A heartbeat detects it and the operation fails instead
 *   of carrying on unprotected.
 *
 * The stages themselves take no lock, so they stay usable as a library and
 * in tests. Each command that writes wraps its work in `withExclusiveLock`.
 */

export type LockKey = {
  /** First int4 of the two-key advisory lock form. */
  classId: number;
  /** Second int4 of the two-key advisory lock form. */
  objectId: number;
};

/** One lock for every operation that writes scores or assignments: they are all mutually incompatible. */
export const PIPELINE_WRITE_LOCK: LockKey = { classId: 0x4c494855, objectId: 1 };

/** Exit code for "another operation is running" (EX_TEMPFAIL): retry later. */
export const LOCK_BUSY_EXIT_CODE = 75;

const DEFAULT_HEARTBEAT_MS = 15_000;
const APPLICATION_NAME_PREFIX = "lead-intelligence:";

export type LockHolder = {
  operation: string | null;
  since: Date | null;
  backendPid: number | null;
};

export class LockBusyError extends Error {
  readonly holder: LockHolder;
  constructor(operation: string, holder: LockHolder) {
    const who = holder.operation ? `"${holder.operation}"` : "another operation";
    const since = holder.since ? ` since ${holder.since.toISOString()}` : "";
    const pid = holder.backendPid !== null ? ` (database session ${holder.backendPid})` : "";
    super(
      `Cannot start "${operation}": ${who} is already running against this database${since}${pid}. ` +
        "Wait for it to finish and try again. If that process is no longer running, its lock is released " +
        "automatically as soon as its database connection closes."
    );
    this.name = "LockBusyError";
    this.holder = holder;
  }
}

export class LockLostError extends Error {
  constructor(operation: string, reason: string) {
    super(
      `The exclusive lock for "${operation}" was lost while it was running (${reason}). ` +
        "Another operation may have started in the meantime, so this one was stopped. Check the data and run it again."
    );
    this.name = "LockLostError";
  }
}

export class PooledConnectionError extends Error {
  constructor() {
    super(
      "The exclusive lock needs a direct database connection, but the configured one goes through a connection pooler. " +
        "A session lock is not reliable through a pooler. Set DIRECT_URL to the direct connection string " +
        "(for Neon, the host without \"-pooler\"), or use the direct string as DATABASE_URL for this command."
    );
    this.name = "PooledConnectionError";
  }
}

export type ExclusiveLock = {
  operation: string;
  backendPid: number;
  /** Verifies right now that the lock is still held by this session; throws LockLostError otherwise. */
  assertHeld(): Promise<void>;
};

export type ExclusiveLockOptions = {
  /** Short name shown to whoever finds the lock taken, e.g. "pipeline". */
  operation: string;
  key?: LockKey;
  /** Defaults to DIRECT_URL, then DATABASE_URL. */
  connectionUrl?: string;
  heartbeatMs?: number;
};

/** Recognizes the usual markers of a transaction-mode pooler in a connection URL. */
export function isPooledConnection(connectionUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(connectionUrl);
  } catch {
    return false;
  }
  return (
    url.hostname.includes("-pooler") ||
    url.searchParams.get("pgbouncer") === "true" ||
    url.port === "6543"
  );
}

function sanitizeOperation(operation: string): string {
  const cleaned = operation.toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "operation").slice(0, 40);
}

/** Connection URL for the dedicated lock session: one connection, never recycled while idle, tagged with the operation. */
export function buildLockConnectionUrl(connectionUrl: string, operation: string): string {
  if (isPooledConnection(connectionUrl)) throw new PooledConnectionError();
  const url = new URL(connectionUrl);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("max_idle_connection_lifetime", "0");
  url.searchParams.set("application_name", `${APPLICATION_NAME_PREFIX}${sanitizeOperation(operation)}`);
  return url.toString();
}

function resolveConnectionUrl(explicit: string | undefined): string {
  const value = explicit?.trim() || process.env.DIRECT_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("No database connection is configured: set DATABASE_URL.");
  return value;
}

async function findHolder(client: PrismaClient, key: LockKey): Promise<LockHolder> {
  try {
    const rows = await client.$queryRaw<Array<{ pid: number; application_name: string | null; backend_start: Date | null }>>`
      SELECT l.pid, a.application_name, a.backend_start
      FROM pg_locks l
      LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 2
        AND l.classid::bigint = ${key.classId}::bigint AND l.objid::bigint = ${key.objectId}::bigint
        AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return { operation: null, since: null, backendPid: null };
    const name = row.application_name ?? "";
    return {
      operation: name.startsWith(APPLICATION_NAME_PREFIX) ? name.slice(APPLICATION_NAME_PREFIX.length) : null,
      since: row.backend_start,
      backendPid: row.pid
    };
  } catch {
    // Holder details are a courtesy; never let them hide the "busy" answer.
    return { operation: null, since: null, backendPid: null };
  }
}

/**
 * Runs `work` while holding the exclusive lock.
 *
 * Fails immediately with LockBusyError when another session holds it; it
 * never waits. The lock is released when `work` settles, whether it resolves
 * or throws, and by PostgreSQL itself if the process dies first.
 */
export async function withExclusiveLock<T>(
  options: ExclusiveLockOptions,
  work: (lock: ExclusiveLock) => Promise<T>
): Promise<T> {
  const key = options.key ?? PIPELINE_WRITE_LOCK;
  const operation = options.operation;
  const client = new PrismaClient({
    datasourceUrl: buildLockConnectionUrl(resolveConnectionUrl(options.connectionUrl), operation)
  });

  let lostReason: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let acquired = false;

  try {
    const rows = await client.$queryRaw<Array<{ acquired: boolean; pid: number }>>`
      SELECT pg_try_advisory_lock(${key.classId}::int, ${key.objectId}::int) AS acquired, pg_backend_pid() AS pid
    `;
    const backendPid = rows[0]?.pid ?? -1;
    if (!rows[0]?.acquired) {
      throw new LockBusyError(operation, await findHolder(client, key));
    }
    acquired = true;

    const check = async (): Promise<void> => {
      if (lostReason) return;
      try {
        const state = await client.$queryRaw<Array<{ pid: number; held: boolean }>>`
          SELECT pg_backend_pid() AS pid,
                 EXISTS (
                   SELECT 1 FROM pg_locks
                   WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND pid = pg_backend_pid()
                     AND classid::bigint = ${key.classId}::bigint AND objid::bigint = ${key.objectId}::bigint
                 ) AS held
        `;
        if (state[0]?.pid !== backendPid) lostReason = "the database session was replaced";
        else if (!state[0]?.held) lostReason = "the session no longer holds the lock";
      } catch {
        lostReason = "the lock connection failed";
      }
    };

    heartbeat = setInterval(() => void check(), options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    heartbeat.unref?.();

    const lock: ExclusiveLock = {
      operation,
      backendPid,
      async assertHeld() {
        await check();
        if (lostReason) throw new LockLostError(operation, lostReason);
      }
    };

    const result = await work(lock);
    // A result produced without the lock cannot be trusted as exclusive.
    await lock.assertHeld();
    return result;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (acquired && !lostReason) {
      await client.$queryRaw`SELECT pg_advisory_unlock(${key.classId}::int, ${key.objectId}::int)`.catch(() => undefined);
    }
    // Closing the session releases the lock even if the explicit unlock failed.
    await client.$disconnect().catch(() => undefined);
  }
}

/** Reports a lock error on the console and sets the exit code; returns false for any other error. */
export function reportLockError(error: unknown): boolean {
  if (error instanceof LockBusyError) {
    console.error(error.message);
    process.exitCode = LOCK_BUSY_EXIT_CODE;
    return true;
  }
  if (error instanceof LockLostError || error instanceof PooledConnectionError) {
    console.error(error.message);
    process.exitCode = 1;
    return true;
  }
  return false;
}
