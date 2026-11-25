import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../src/lib/db/client";
import {
  buildLockConnectionUrl,
  isPooledConnection,
  LOCK_BUSY_EXIT_CODE,
  LockBusyError,
  LockLostError,
  LockTargetMismatchError,
  LockTimeoutError,
  PooledConnectionError,
  withExclusiveLock,
  type LockKey
} from "../src/lib/db/exclusive-lock";
import { startFreezableProxy } from "./helpers/freezable-proxy";
import { createTempDatabase } from "./helpers/temp-database";

// Real concurrency against PostgreSQL, including independent operating
// system processes. Skipped when DATABASE_URL is not configured.
const hasDb = Boolean(process.env.DATABASE_URL);
const skip = hasDb
  ? false
  : "DATABASE_URL not configured -- run against a real Postgres instance to execute this suite.";

const holderScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "lock-holder.ts");

/** Every test uses its own key, so suites never contend with each other or with a real pipeline. */
function uniqueKey(): LockKey {
  return { classId: randomInt(1, 2_000_000_000), objectId: randomInt(1, 2_000_000_000) };
}

type Holder = {
  child: ChildProcess;
  /** Resolves with the first status line: "ACQUIRED <pid>", "BUSY ..." or "FAILED ...". */
  firstLine: Promise<string>;
  /** Resolves with the exit code once the process has ended. */
  exited: Promise<number | null>;
  output: () => string;
};

function startHolder(
  key: LockKey,
  operation: string,
  mode: "hold" | "throw" | "hang" | "hang-fail-stop" | "until-told",
  holdMs = 1_000
): Holder {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", holderScript, String(key.classId), String(key.objectId), operation, mode, String(holdMs)],
    { env: process.env, stdio: ["pipe", "pipe", "pipe"] }
  );
  let buffer = "";
  let resolveFirst: (line: string) => void = () => undefined;
  const firstLine = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    const line = buffer.split(/\r?\n/).find((entry) => /^(ACQUIRED|BUSY|FAILED)/.test(entry));
    if (line) resolveFirst(line);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  void exited.then(() => resolveFirst(`EXITED ${buffer}`));
  return { child, firstLine, exited, output: () => buffer };
}

async function tryAcquire(key: LockKey, operation = "probe"): Promise<"acquired" | LockBusyError> {
  try {
    await withExclusiveLock({ operation, key }, async () => undefined);
    return "acquired";
  } catch (error) {
    if (error instanceof LockBusyError) return error;
    throw error;
  }
}

async function eventually(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await check()) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("a pooled connection is recognized and refused for the lock", () => {
  assert.equal(isPooledConnection("postgresql://u:p@ep-cool-rain-123456-pooler.us-east-2.aws.neon.tech/db"), true);
  assert.equal(isPooledConnection("postgresql://u:p@db.example.com:5432/db?pgbouncer=true"), true);
  assert.equal(isPooledConnection("postgresql://u:p@db.example.com:6543/db"), true);
  assert.equal(isPooledConnection("postgresql://u:p@ep-cool-rain-123456.us-east-2.aws.neon.tech/db"), false);
  assert.throws(
    () => buildLockConnectionUrl("postgresql://u:p@ep-cool-rain-123456-pooler.us-east-2.aws.neon.tech/db", "pipeline"),
    (error: unknown) => error instanceof PooledConnectionError && !error.message.includes("u:p")
  );
});

test("the lock connection is a single tagged session and keeps the caller's own parameters", () => {
  const url = new URL(buildLockConnectionUrl("postgresql://u:p@db.example.com:5432/app?sslmode=require", "Ops Rescore!"));
  assert.equal(url.searchParams.get("connection_limit"), "1");
  assert.equal(url.searchParams.get("max_idle_connection_lifetime"), "0");
  assert.equal(url.searchParams.get("application_name"), "lead-intelligence:ops-rescore");
  assert.equal(url.searchParams.get("sslmode"), "require");
  assert.equal(url.hostname, "db.example.com");
  assert.equal(url.pathname, "/app");
});

test(
  "integration: a second operation is refused while the first one holds the lock, with a clear message",
  { skip, timeout: 60_000 },
  async () => {
    const key = uniqueKey();
    await withExclusiveLock({ operation: "pipeline", key }, async (lock) => {
      const second = await tryAcquire(key, "ops-rescore");
      assert.ok(second instanceof LockBusyError, "the second operation must be refused");
      assert.match(second.message, /Cannot start "ops-rescore"/);
      assert.match(second.message, /"pipeline" is already running/);
      assert.match(second.message, /since \d{4}-\d{2}-\d{2}T/);
      assert.equal(second.holder.backendPid, lock.backendPid);
      assert.ok(!/postgres(ql)?:\/\//.test(second.message), "the message must not contain a connection string");
    });
    assert.equal(await tryAcquire(key), "acquired", "the lock must be free once the first operation finishes");
  }
);

test(
  "integration: different lock keys do not block each other",
  { skip, timeout: 60_000 },
  async () => {
    await withExclusiveLock({ operation: "one", key: uniqueKey() }, async () => {
      assert.equal(await tryAcquire(uniqueKey()), "acquired");
    });
  }
);

test(
  "integration: an error inside the protected work releases the lock and is propagated",
  { skip, timeout: 60_000 },
  async () => {
    const key = uniqueKey();
    await assert.rejects(
      () => withExclusiveLock({ operation: "pipeline", key }, async () => {
        throw new Error("stage failed");
      }),
      /stage failed/
    );
    assert.equal(await tryAcquire(key), "acquired");
  }
);

test(
  "integration: an idle lock session keeps the lock without relying on the heartbeat",
  { skip, timeout: 60_000 },
  async () => {
    const key = uniqueKey();
    await withExclusiveLock({ operation: "pipeline", key, heartbeatMs: 600_000 }, async (lock) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await lock.assertHeld();
      assert.ok((await tryAcquire(key)) instanceof LockBusyError);
    });
  }
);

test(
  "integration: losing the database session is detected and the operation fails instead of continuing unprotected",
  { skip, timeout: 60_000 },
  async () => {
    const key = uniqueKey();
    let reachedEnd = false;
    await assert.rejects(
      () => withExclusiveLock({ operation: "pipeline", key, heartbeatMs: 600_000 }, async (lock) => {
        await lock.assertHeld();
        await prisma.$queryRaw`SELECT pg_terminate_backend(${lock.backendPid}::int)`;
        await assert.rejects(() => lock.assertHeld(), LockLostError);
        reachedEnd = true;
      }),
      LockLostError,
      "a result produced after losing the lock must not be returned as if it were exclusive"
    );
    assert.equal(reachedEnd, true);
    assert.equal(await tryAcquire(key), "acquired");
  }
);

test(
  "integration: a lock taken on a different database than the one being written is refused",
  { skip, timeout: 120_000 },
  async () => {
    // What a stale DIRECT_URL would do: the lock lands on one database while
    // the command writes to another, protecting nothing.
    const other = await createTempDatabase("lock_other");
    const key = uniqueKey();
    try {
      await assert.rejects(
        () => withExclusiveLock({ operation: "pipeline", key, connectionUrl: other.url }, async () => {
          assert.fail("the protected work must not start");
        }),
        (error: unknown) =>
          error instanceof LockTargetMismatchError &&
          /DIRECT_URL and DATABASE_URL must point at the same database/.test(error.message) &&
          !/postgres(ql)?:\/\//.test(error.message)
      );

      // The refused attempt left nothing held on either database.
      assert.equal(await tryAcquire(key), "acquired");
      const otherClient = new PrismaClient({ datasourceUrl: other.url });
      try {
        await withExclusiveLock({ operation: "pipeline", key, connectionUrl: other.url, protects: otherClient }, async (lock) => {
          await lock.assertHeld();
        });
      } finally {
        await otherClient.$disconnect();
      }
    } finally {
      await other.drop();
    }
  }
);

test(
  "integration: a writer that loses its lock stops at once instead of finishing its work unprotected",
  { skip, timeout: 60_000 },
  async () => {
    const key = uniqueKey();
    const holder = startHolder(key, "pipeline", "hang-fail-stop");
    try {
      const acquired = await holder.firstLine;
      assert.match(acquired, /^ACQUIRED \d+/, holder.output());
      const backendPid = Number(acquired.split(" ")[1]);

      // The session disappears underneath the process (network drop, server restart).
      await prisma.$queryRaw`SELECT pg_terminate_backend(${backendPid}::int)`;

      const code = await Promise.race([
        holder.exited,
        new Promise<"still-running">((resolve) => setTimeout(() => resolve("still-running"), 10_000))
      ]);
      assert.equal(code, 1, `the process must end by itself shortly after losing the lock: ${holder.output()}`);
      assert.match(holder.output(), /The exclusive lock for "pipeline" was lost while it was running/);
      assert.ok(!holder.output().includes("RELEASED"), "the protected work must not run to completion");
    } finally {
      holder.child.kill("SIGKILL");
    }
  }
);

test(
  "integration: an independent process holding the lock blocks others, and frees it when it finishes",
  { skip, timeout: 60_000 },
  async () => {
    const key = uniqueKey();
    const holder = startHolder(key, "pipeline", "until-told");
    try {
      assert.match(await holder.firstLine, /^ACQUIRED \d+/, holder.output());

      const inProcess = await tryAcquire(key, "ops-rescore");
      assert.ok(inProcess instanceof LockBusyError);
      assert.match(inProcess.message, /"pipeline" is already running/);

      const rival = startHolder(key, "ops-rescore", "hold", 100);
      assert.match(await rival.firstLine, /^BUSY Cannot start "ops-rescore": "pipeline" is already running/);
      assert.equal(await rival.exited, LOCK_BUSY_EXIT_CODE);

      holder.child.stdin?.write("finish\n");
      assert.equal(await holder.exited, 0);
      assert.match(holder.output(), /RELEASED/);
      assert.equal(await tryAcquire(key), "acquired");
    } finally {
      holder.child.kill("SIGKILL");
    }
  }
);

test(
  "integration: a process that fails inside the protected work releases the lock",
  { skip, timeout: 60_000 },
  async () => {
    const key = uniqueKey();
    const holder = startHolder(key, "pipeline", "throw");
    assert.match(await holder.firstLine, /^ACQUIRED \d+/, holder.output());
    assert.equal(await holder.exited, 1);
    assert.match(holder.output(), /FAILED simulated failure/);
    assert.equal(await tryAcquire(key), "acquired");
  }
);

test(
  "integration: killing the process that holds the lock releases it without any cleanup",
  { skip, timeout: 60_000 },
  async () => {
    const key = uniqueKey();
    const holder = startHolder(key, "pipeline", "hang");
    try {
      assert.match(await holder.firstLine, /^ACQUIRED \d+/, holder.output());
      assert.ok((await tryAcquire(key)) instanceof LockBusyError);

      holder.child.kill("SIGKILL");
      await holder.exited;
      await eventually(async () => (await tryAcquire(key)) === "acquired", 15_000, "lock release after kill");
    } finally {
      holder.child.kill("SIGKILL");
    }
  }
);

test(
  "integration: of several processes starting at once, exactly one gets the lock",
  { skip, timeout: 90_000 },
  async () => {
    const key = uniqueKey();
    // The winner keeps the lock until every contender has reported, so the
    // result does not depend on how fast each process starts.
    const contenders = Array.from({ length: 6 }, (_, index) => startHolder(key, `contender-${index}`, "until-told"));
    try {
      const lines = await Promise.all(contenders.map((contender) => contender.firstLine));
      const acquired = lines.filter((line) => line.startsWith("ACQUIRED"));
      const busy = lines.filter((line) => line.startsWith("BUSY"));
      assert.equal(acquired.length, 1, `expected exactly one winner, got: ${JSON.stringify(lines)}`);
      assert.equal(busy.length, 5, `expected five refusals, got: ${JSON.stringify(lines)}`);

      for (const contender of contenders) contender.child.stdin?.write("finish\n");
      const codes = await Promise.all(contenders.map((contender) => contender.exited));
      assert.deepEqual([...codes].sort(), [0, 75, 75, 75, 75, 75]);
    } finally {
      for (const contender of contenders) contender.child.kill("SIGKILL");
    }
  }
);

// --- connections that stop answering without being closed -------------------

function databaseAddress(): { host: string; port: number } {
  const url = new URL(process.env.DATABASE_URL!);
  return { host: url.hostname, port: Number(url.port || 5432) };
}

function throughProxy(port: number): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.toString();
}

/** Fails with a clear message instead of letting a hung promise stall the whole suite. */
async function within<T>(timeoutMs: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${timeoutMs} ms: ${what}`)), timeoutMs);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "integration: a lock connection that stops answering is treated as lost within the heartbeat time limit",
  { skip, timeout: 90_000 },
  async () => {
    const proxy = await startFreezableProxy(databaseAddress());
    const key = uniqueKey();
    try {
      const outcome = withExclusiveLock(
        { operation: "pipeline", key, connectionUrl: throughProxy(proxy.port), heartbeatMs: 600_000, heartbeatTimeoutMs: 1_000 },
        async (lock) => {
          await lock.assertHeld();

          // The connection stays open but nothing comes back any more.
          proxy.freeze();
          const frozenAt = Date.now();
          await within(
            8_000,
            "the lock check on a frozen connection",
            assert.rejects(
              () => lock.assertHeld(),
              (error: unknown) => error instanceof LockLostError && /did not answer within 1 s/.test(error.message)
            )
          );
          const waitedMs = Date.now() - frozenAt;
          assert.ok(waitedMs >= 900 && waitedMs < 4_000, `detected after ${waitedMs} ms, expected about 1000`);
        }
      );
      await within(20_000, "the operation to end without waiting on the frozen connection", assert.rejects(() => outcome, LockLostError));
    } finally {
      await proxy.close();
    }
    await eventually(async () => (await tryAcquire(key)) === "acquired", 15_000, "release once the frozen connection is closed");
  }
);

test(
  "integration: the heartbeat alone notices a connection that stops answering",
  { skip, timeout: 90_000 },
  async () => {
    const proxy = await startFreezableProxy(databaseAddress());
    const key = uniqueKey();
    try {
      const outcome = withExclusiveLock(
        { operation: "pipeline", key, connectionUrl: throughProxy(proxy.port), heartbeatMs: 300, heartbeatTimeoutMs: 800 },
        async (lock) => {
          await lock.assertHeld();
          proxy.freeze();
          // No explicit check: only the background heartbeat is running.
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          const askedAt = Date.now();
          await within(8_000, "the lock check after the heartbeat ran", assert.rejects(() => lock.assertHeld(), LockLostError));
          assert.ok(Date.now() - askedAt < 500, "the heartbeat had already recorded the loss");
        }
      );
      await within(20_000, "the operation to end", assert.rejects(() => outcome, LockLostError));
    } finally {
      await proxy.close();
    }
  }
);

test(
  "integration: taking the lock on a database that never answers gives up with a clear error",
  { skip, timeout: 90_000 },
  async () => {
    const proxy = await startFreezableProxy(databaseAddress());
    proxy.freeze();
    const startedAt = Date.now();
    try {
      await within(
        20_000,
        "taking the lock on a silent database",
        assert.rejects(
          () => withExclusiveLock(
            { operation: "pipeline", key: uniqueKey(), connectionUrl: throughProxy(proxy.port), acquireTimeoutMs: 1_500 },
            async () => {
              assert.fail("the protected work must not start");
            }
          ),
          (error: unknown) =>
            error instanceof LockTimeoutError &&
            /did not answer within 1.5 s while taking the exclusive lock/.test(error.message) &&
            /Nothing was written/.test(error.message)
        )
      );
      assert.ok(Date.now() - startedAt < 10_000);
    } finally {
      await proxy.close();
    }
  }
);
