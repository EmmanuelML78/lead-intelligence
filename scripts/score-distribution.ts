import { prisma } from "../src/lib/db/client";
import { reportLockError, withWriterLock } from "../src/lib/db/exclusive-lock";
import {
  analyzeScoreDistribution,
  selectSanitySamples
} from "../src/lib/scoring/distribution";
import { PRIORITY_BAND_THRESHOLDS, PRIORITY_SCORE_WEIGHTS } from "../src/lib/scoring/hybrid";
import { runScoringStage } from "../src/pipeline/scoring-stage";

async function main() {
  const { report: coverage, scores, issues } = await runScoringStage(prisma);
  const output = {
    generatedAt: new Date().toISOString(),
    scoreVersion: coverage.scoreVersion,
    weights: PRIORITY_SCORE_WEIGHTS,
    bandThresholds: PRIORITY_BAND_THRESHOLDS,
    distribution: analyzeScoreDistribution(scores),
    coverage,
    scoringIssues: issues,
    sanitySamples: selectSanitySamples(scores)
  };

  console.log(JSON.stringify(output, null, 2));
}

// The scoring stage persists scores, so this command excludes the pipeline
// and every other writer while it runs.
withWriterLock("analysis-priority", main)
  .catch((error) => {
    if (reportLockError(error)) return;
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
