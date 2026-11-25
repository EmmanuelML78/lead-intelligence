/**
 * Recalculates lead scores only, at an explicit evaluation instant.
 *
 * It runs the scoring stage and nothing else: no ingestion, no AI
 * extraction (it reads persisted extractions and never calls a model
 * provider) and no advisor assignment. Existing assignments are not touched.
 *
 * Unlike `bun run analysis:priority`, which evaluates at the wall clock, the
 * evaluation instant must be given with `--decision-at`, so the same command
 * can be rehearsed on a copy and repeated on the real database with the same
 * result. The report records that instant and a digest of the results.
 *
 * Without `--apply` it only prints the plan and writes nothing.
 *
 * Usage:
 *   bun run ops:rescore --expect-host <host> --decision-at 2026-09-14T20:00:00.000Z
 *   bun run ops:rescore --expect-host <host> --decision-at <ISO instant> --apply --report rescore.json
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { prisma } from "../../src/lib/db/client";
import { reportLockError, withExclusiveLock } from "../../src/lib/db/exclusive-lock";
import { runScoringStage } from "../../src/pipeline/scoring-stage";
import { assertTarget, formatTarget, parseArgs, stringFlag, TargetError } from "./target";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function parseDecisionAt(value: string | undefined): Date {
  if (!value || !ISO_INSTANT.test(value)) {
    throw new TargetError("--decision-at is required as a full ISO 8601 instant with a time zone, for example 2026-09-14T20:00:00.000Z.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TargetError("--decision-at is not a valid instant.");
  return date;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const target = assertTarget(process.env.DATABASE_URL, stringFlag(flags, "expect-host"));
  const decisionAt = parseDecisionAt(stringFlag(flags, "decision-at"));
  const apply = flags.get("apply") === true;
  const reportFile = stringFlag(flags, "report");

  console.log(`Target: ${formatTarget(target)}`);
  console.log(`Evaluation instant (decisionAt): ${decisionAt.toISOString()}`);

  const running = await prisma.pipelineRun.count({ where: { status: "RUNNING" } });
  if (running > 0) {
    console.log(
      `Note: ${running} pipeline run(s) are recorded as RUNNING. With --apply this command takes the exclusive lock, ` +
        "so it is refused while a pipeline is really running; a RUNNING record without a live process is a leftover of an interrupted run."
    );
  }

  // Urgency is the only score component that depends on the evaluation
  // instant, and only for uncontacted leads with a trusted registration
  // time that are less than 24 hours old at that instant.
  const [leads, timeSensitive, registeredAfter] = await Promise.all([
    prisma.lead.count(),
    prisma.lead.count({
      where: {
        firstContactAt: null,
        registeredAtAmbiguous: false,
        registeredAt: { gt: new Date(decisionAt.getTime() - DAY_MS), lte: decisionAt }
      }
    }),
    prisma.lead.count({
      where: { firstContactAt: null, registeredAtAmbiguous: false, registeredAt: { gt: decisionAt } }
    })
  ]);
  console.log(`Leads to score: ${leads}`);
  console.log(`Leads whose score depends on the exact instant (uncontacted, registered within 24h before it): ${timeSensitive}`);
  console.log(`Leads registered after the instant (scored as age 0): ${registeredAfter}`);
  if (timeSensitive + registeredAfter > 0) {
    console.log("WARNING: for those leads a different --decision-at gives a different score. Use the same instant in the rehearsal and in the real run.");
  }

  if (!apply) {
    console.log("\nPlan only: nothing was written. Re-run with --apply to recalculate the scores.");
    return;
  }

  // Scoring writes LeadScore and LeadCurrentScore, so it must not overlap
  // with the pipeline or with another recalculation.
  const startedAt = new Date();
  const { report, scores, issues } = await withExclusiveLock({ operation: "ops-rescore" }, async (lock) => {
    console.log(`Exclusive lock acquired (database session ${lock.backendPid}).`);
    return runScoringStage(prisma, { decisionAt });
  });
  const finishedAt = new Date();
  const resultDigest = createHash("sha256")
    .update(
      scores
        .map((score) => [score.leadId, score.scoreVersion, score.inputFingerprint, score.totalScore, score.priorityBand].join("|"))
        .sort()
        .join("\n")
    )
    .digest("hex");

  const output = {
    targetFingerprint: target.fingerprint,
    decisionAt: decisionAt.toISOString(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    resultDigest,
    report,
    issues: issues.length
  };
  console.log("\nScoring report");
  console.log(JSON.stringify(output, null, 2));
  if (reportFile) {
    await writeFile(reportFile, JSON.stringify(output, null, 2));
    console.log(`Report written to ${reportFile}`);
  }
  if (report.failures > 0) {
    console.error(`Scoring FAILED for ${report.failures} lead(s); their previous scores were kept.`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    if (reportLockError(error)) return;
    console.error(error instanceof TargetError ? error.message : error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
