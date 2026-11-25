/**
 * Child process used by the exclusive-lock tests: an independent operating
 * system process, with its own database connection, that tries to take the
 * lock.
 *
 * Usage: lock-holder.ts <classId> <objectId> <operation> <mode> [holdMs]
 *   mode "hold"  - keep the lock for holdMs, then finish normally
 *   mode "until-told" - keep the lock until a line arrives on stdin, then finish normally
 *   mode "throw" - fail inside the protected work
 *   mode "hang"  - keep the lock until the process is killed
 *
 * Prints "ACQUIRED <backend pid>" once it holds the lock, or "BUSY <message>".
 */
import { LOCK_BUSY_EXIT_CODE, LockBusyError, withExclusiveLock } from "../../src/lib/db/exclusive-lock";

const [classId, objectId, operation, mode, holdMs] = process.argv.slice(2);

async function main() {
  await withExclusiveLock(
    { operation: operation ?? "holder", key: { classId: Number(classId), objectId: Number(objectId) }, heartbeatMs: 500 },
    async (lock) => {
      console.log(`ACQUIRED ${lock.backendPid}`);
      if (mode === "throw") throw new Error("simulated failure inside the protected work");
      if (mode === "hang") await new Promise(() => setInterval(() => undefined, 1_000));
      if (mode === "until-told") {
        await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
        process.stdin.pause();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Number(holdMs ?? 1_000)));
    }
  );
  console.log("RELEASED");
}

main().catch((error) => {
  if (error instanceof LockBusyError) {
    console.log(`BUSY ${error.message}`);
    process.exit(LOCK_BUSY_EXIT_CODE);
  }
  console.log(`FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
