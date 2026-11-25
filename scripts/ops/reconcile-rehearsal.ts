/** Disposable-copy-only pipeline rehearsal, never the production deployment path. */
import { rehearsalEnvironment } from "./rehearsal-guard";
import { parseArgs, stringFlag, TargetError } from "./target";

const usage = "Usage: bun run ops:reconcile-rehearsal --expect-host <rehearsal-host> --production-host <production-host>";
const { flags, positional } = parseArgs(process.argv.slice(2));
if (flags.has("help")) {
  console.log(usage);
} else {
  try {
    if (positional.length || [...flags.keys()].some((key) => !["expect-host", "production-host"].includes(key))) throw new TargetError(usage);
    const safe = rehearsalEnvironment(process.env.DATABASE_URL, stringFlag(flags, "expect-host"), stringFlag(flags, "production-host"));
    Object.assign(process.env, safe);
    console.log("Disposable rehearsal: Gemini OFF; assignment OFF; scoring OFF. Ingestion/reconciliation writes to the named copy only.");
    await import("../../src/pipeline/run");
  } catch (error) {
    console.error(error instanceof TargetError ? error.message : "Rehearsal startup failed.");
    process.exitCode = 1;
  }
}
