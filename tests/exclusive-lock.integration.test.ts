import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db/client";
import {
  buildLockConnectionUrl,
  isPooledConnection,
  LOCK_BUSY_EXIT_CODE,
  LockBusyError,
  LockLostError,
  PooledConnectionError,
  withExclusiveLock,
  type LockKey
} from "../src/lib/db/exclusive-lock";

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
  mode: "hold" | "throw" | "hang" | "until-told",
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
      const waitedMs = await eventually(async () => (await tryAcquire(key)) === "acquired", 15_000, "lock release after kill");
      assert.ok(waitedMs < 15_000);
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
    const contenders = Array.from({ length: 6 }, (_, index) => startHolder(key, `contender-${index}`, "hold", 4_000));
    try {
      const lines = await Promise.all(contenders.map((contender) => contender.firstLine));
      const acquired = lines.filter((line) => line.startsWith("ACQUIRED"));
      const busy = lines.filter((line) => line.startsWith("BUSY"));
      assert.equal(acquired.length, 1, `expected exactly one winner, got: ${JSON.stringify(lines)}`);
      assert.equal(busy.length, 5, `expected five refusals, got: ${JSON.stringify(lines)}`);

      const codes = await Promise.all(contenders.map((contender) => contender.exited));
      assert.deepEqual([...codes].sort(), [0, 75, 75, 75, 75, 75]);
    } finally {
      for (const contender of contenders) contender.child.kill("SIGKILL");
    }
  }
);
