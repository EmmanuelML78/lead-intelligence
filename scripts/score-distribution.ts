import { prisma } from "../src/lib/db/client";
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

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
