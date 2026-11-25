import { PrismaClient } from "@prisma/client";
import { prisma as sharedClient } from "./client";

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
 * - The lock connection (DIRECT_URL) and the connection the work writes
 *   with (DATABASE_URL) are configured separately, so after taking the lock
 *   the writing client must be able to see it. If it cannot, they are not
 *   the same database and the operation is refused.
 * - If that one connection is ever replaced (network drop, server restart),
 *   the lock is gone and another writer can take it. A heartbeat detects it
 *   within one interval. Commands run with `onLost: "fail-stop"`, which ends
 *   the process at once rather than letting it write unprotected.
 * - A connection can also stop answering without being closed (frozen
 *   server, black-holed network). A query on it would then wait for as long
 *   as the operating system keeps the socket, which can be many minutes, so
 *   every query on the lock session has its own time limit. A heartbeat that
 *   is not answered in time counts as a lost lock: whether the server still
 *   holds it cannot be known, and stopping is the safe answer.
 *
 * The stages themselves take no lock, so they stay usable as a library and
 * in tests. Each command that writes wraps its work in `withWriterLock`.
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

/** How often the lock session is verified. */
export const DEFAULT_HEARTBEAT_MS = 5_000;

/** How long one heartbeat may take before the lock is considered lost. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * Longest a lost or unresponsive lock session can go unnoticed with the
 * defaults: one interval until the next heartbeat starts, plus its time limit.
 */
export const DEFAULT_DETECTION_LIMIT_MS = DEFAULT_HEARTBEAT_MS + DEFAULT_HEARTBEAT_TIMEOUT_MS;

/** How long taking the lock may take before giving up. */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 15_000;

/** Releasing is best effort: PostgreSQL frees the lock when the process and its connection end. */
const RELEASE_TIMEOUT_MS = 3_000;

class QueryTimeoutError extends Error {}

/** Rejects when `work` has not settled in time. The abandoned promise is left to settle on its own. */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueryTimeoutError()), timeoutMs);
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

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

export class LockTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(
      `Cannot start "${operation}": the database did not answer within ${seconds(timeoutMs)} while taking the exclusive lock. ` +
        "Nothing was written. Check that the database is reachable and try again."
    );
    this.name = "LockTimeoutError";
  }
}

export class LockTargetMismatchError extends Error {
  constructor(operation: string) {
    super(
      `Cannot start "${operation}": the exclusive lock was taken on a different database than the one this command writes to. ` +
        "DIRECT_URL and DATABASE_URL must point at the same database. Unset DIRECT_URL, or set it to the direct " +
        "connection string of the database in DATABASE_URL."
    );
    this.name = "LockTargetMismatchError";
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
  /** Time limit of one heartbeat query; unanswered in time means the lock is treated as lost. */
  heartbeatTimeoutMs?: number;
  /** Time limit for taking the lock and verifying it against the writing client. */
  acquireTimeoutMs?: number;
  /**
   * The client the protected work writes with. It must see the lock, which
   * proves both connections reach the same database. Defaults to the shared
   * application client; pass null only when nothing is written through Prisma.
   */
  protects?: PrismaClient | null;
  /**
   * What happens when the heartbeat finds the lock lost.
   * "report": remember it; `assertHeld` and the end of the operation throw.
   * "fail-stop": print the reason and end the process immediately.
   */
  onLost?: "report" | "fail-stop";
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

/** True when `client`, in its own current database, sees the lock held by the given session. */
async function seesLock(client: PrismaClient, key: LockKey, backendPid: number): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ visible: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND pid = ${backendPid}::int
        AND classid::bigint = ${key.classId}::bigint AND objid::bigint = ${key.objectId}::bigint
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    ) AS visible
  `;
  return rows[0]?.visible === true;
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
  const onLost = options.onLost ?? "report";
  const protectedClient = options.protects === undefined ? sharedClient : options.protects;
  const client = new PrismaClient({
    datasourceUrl: buildLockConnectionUrl(resolveConnectionUrl(options.connectionUrl), operation)
  });

  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;

  let lostReason: string | null = null;
  let checking: Promise<void> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let acquired = false;

  try {
    // Taking the lock is bounded as a whole, so a database that accepts the
    // connection but never answers cannot leave the command waiting forever.
    const backendPid = await withTimeout(
      (async () => {
        const rows = await client.$queryRaw<Array<{ acquired: boolean; pid: number }>>`
          SELECT pg_try_advisory_lock(${key.classId}::int, ${key.objectId}::int) AS acquired, pg_backend_pid() AS pid
        `;
        if (!rows[0]?.acquired) {
          throw new LockBusyError(operation, await findHolder(client, key));
        }
        acquired = true;
        const pid = rows[0].pid;
        if (protectedClient && !(await seesLock(protectedClient, key, pid))) {
          throw new LockTargetMismatchError(operation);
        }
        return pid;
      })(),
      acquireTimeoutMs
    ).catch((error: unknown) => {
      if (error instanceof QueryTimeoutError) throw new LockTimeoutError(operation, acquireTimeoutMs);
      throw error;
    });

    const verify = async (): Promise<void> => {
      if (lostReason) return;
      try {
        const state = await withTimeout(
          client.$queryRaw<Array<{ pid: number; held: boolean }>>`
            SELECT pg_backend_pid() AS pid,
                   EXISTS (
                     SELECT 1 FROM pg_locks
                     WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND pid = pg_backend_pid()
                       AND classid::bigint = ${key.classId}::bigint AND objid::bigint = ${key.objectId}::bigint
                   ) AS held
          `,
          heartbeatTimeoutMs
        );
        if (state[0]?.pid !== backendPid) lostReason = "the database session was replaced";
        else if (!state[0]?.held) lostReason = "the session no longer holds the lock";
      } catch (error) {
        lostReason =
          error instanceof QueryTimeoutError
            ? `the lock connection did not answer within ${seconds(heartbeatTimeoutMs)}`
            : "the lock connection failed";
      }
      if (lostReason && onLost === "fail-stop") {
        // Without the lock every further write is unprotected. Ending the
        // process is the only way to stop work that is already in progress.
        console.error(new LockLostError(operation, lostReason).message);
        process.exit(1);
      }
    };
    // One verification at a time, shared by the heartbeat and assertHeld.
    const check = (): Promise<void> => {
      checking ??= verify().finally(() => {
        checking = null;
      });
      return checking;
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
      await withTimeout(
        client.$queryRaw`SELECT pg_advisory_unlock(${key.classId}::int, ${key.objectId}::int)`,
        RELEASE_TIMEOUT_MS
      ).catch(() => undefined);
    }
    // Closing the session releases the lock even if the explicit unlock
    // failed. Bounded as well: a frozen connection must not hold the caller.
    await withTimeout(client.$disconnect(), RELEASE_TIMEOUT_MS).catch(() => undefined);
  }
}

/**
 * The lock every writing command takes: the shared pipeline lock, verified
 * against the shared application client, ending the process if it is lost.
 */
export function withWriterLock<T>(operation: string, work: (lock: ExclusiveLock) => Promise<T>): Promise<T> {
  return withExclusiveLock({ operation, onLost: "fail-stop" }, work);
}

/** Reports a lock error on the console and sets the exit code; returns false for any other error. */
export function reportLockError(error: unknown): boolean {
  if (error instanceof LockBusyError) {
    console.error(error.message);
    process.exitCode = LOCK_BUSY_EXIT_CODE;
    return true;
  }
  if (
    error instanceof LockLostError ||
    error instanceof PooledConnectionError ||
    error instanceof LockTargetMismatchError ||
    error instanceof LockTimeoutError
  ) {
    console.error(error.message);
    process.exitCode = 1;
    return true;
  }
  return false;
}
