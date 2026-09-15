import type { LeadPriorityScore } from "./score-lead";

export type ScoreDistribution = {
  count: number;
  min: number | null;
  median: number | null;
  mean: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
  bands: Record<LeadPriorityScore["priorityBand"], number>;
};

export type ScoreExample = {
  leadId: string;
  companyId: string;
  totalScore: number;
  priorityBand: LeadPriorityScore["priorityBand"];
  propensityComponent: number;
  intentComponent: number;
  urgencyComponent: number;
  inventoryComponent: number;
  usedAiExtraction: boolean;
  contacted: boolean;
  inventoryAvailable: boolean | null;
  explanation: string;
};

export type ScoreSanitySamples = {
  highest: ScoreExample[];
  lowest: ScoreExample[];
  noAiExtraction: ScoreExample[];
  contacted: ScoreExample[];
  uncontacted: ScoreExample[];
  inventoryUnavailable: ScoreExample[];
};

export function analyzeScoreDistribution(scores: readonly LeadPriorityScore[]): ScoreDistribution {
  const values = scores.map((score) => score.totalScore).sort((left, right) => left - right);
  return {
    count: values.length,
    min: values[0] ?? null,
    median: quantile(values, 0.5),
    mean:
      values.length === 0
        ? null
        : values.reduce((sum, value) => sum + value, 0) / values.length,
    p75: quantile(values, 0.75),
    p90: quantile(values, 0.9),
    max: values.at(-1) ?? null,
    bands: {
      CRITICAL: scores.filter((score) => score.priorityBand === "CRITICAL").length,
      HIGH: scores.filter((score) => score.priorityBand === "HIGH").length,
      MEDIUM: scores.filter((score) => score.priorityBand === "MEDIUM").length,
      LOW: scores.filter((score) => score.priorityBand === "LOW").length
    }
  };
}

export function selectSanitySamples(scores: readonly LeadPriorityScore[]): ScoreSanitySamples {
  const descending = [...scores].sort(
    (left, right) => right.totalScore - left.totalScore || left.leadId.localeCompare(right.leadId)
  );
  const ascending = [...descending].reverse();
  return {
    highest: descending.slice(0, 5).map(toExample),
    lowest: ascending.slice(0, 5).map(toExample),
    noAiExtraction: descending
      .filter((score) => !score.explanation.intent.usedAiExtraction)
      .slice(0, 5)
      .map(toExample),
    contacted: descending
      .filter((score) => score.explanation.urgency.contacted)
      .slice(0, 3)
      .map(toExample),
    uncontacted: descending
      .filter((score) => !score.explanation.urgency.contacted)
      .slice(0, 3)
      .map(toExample),
    inventoryUnavailable: descending
      .filter(
        (score) =>
          score.explanation.inventory.catalogStatus === "CATALOG_UNAVAILABLE"
      )
      .slice(0, 3)
      .map(toExample)
  };
}

function quantile(sortedValues: readonly number[], probability: number): number | null {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];
  if (lower === undefined || upper === undefined) return null;
  return lower + (upper - lower) * (position - lowerIndex);
}

function toExample(score: LeadPriorityScore): ScoreExample {
  return {
    leadId: score.leadId,
    companyId: score.companyId,
    totalScore: score.totalScore,
    priorityBand: score.priorityBand,
    propensityComponent: score.propensityComponent,
    intentComponent: score.intentComponent,
    urgencyComponent: score.urgencyComponent,
    inventoryComponent: score.inventoryComponent,
    usedAiExtraction: score.explanation.intent.usedAiExtraction,
    contacted: score.explanation.urgency.contacted,
    inventoryAvailable: score.explanation.inventory.available,
    explanation: score.explanation.summary
  };
}
