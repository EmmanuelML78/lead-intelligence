import assert from "node:assert/strict";
import test from "node:test";
import artifactJson from "../artifacts/propensity-model-v1.json";
import parityJson from "../artifacts/propensity-parity-v1.json";
import {
  defaultPropensityArtifact,
  loadPropensityArtifact,
  predictPropensity,
  propensityInputSchema
} from "../src/lib/scoring/propensity";

test("versioned propensity artifact loads through strict validation", () => {
  const artifact = loadPropensityArtifact(artifactJson);
  assert.equal(artifact.modelVersion, "propensity-model-v1");
  assert.equal(artifact.algorithm.name, "l2_regularized_logistic_regression");
});

test("probability stays in 0..1 and inference is deterministic", () => {
  const input = propensityInputSchema.parse(parityJson.fixtures[0].input);
  const first = predictPropensity(input);
  const second = predictPropensity(input);

  assert.ok(first.probability >= 0 && first.probability <= 1);
  assert.deepEqual(first, second);
});

test("unknown categorical values use zero contribution without failing", () => {
  const fixture = parityJson.fixtures.find((item) => item.name === "unknown-categories");
  assert.ok(fixture);
  const prediction = predictPropensity(propensityInputSchema.parse(fixture.input));
  const unknownFactors = prediction.explanation.contributions.filter(
    (factor) =>
      ["channel", "companyId", "salesPointId", "motorcycleModel"].includes(
        factor.feature
      )
  );

  assert.ok(unknownFactors.every((factor) => factor.knownCategory === false));
  assert.ok(unknownFactors.every((factor) => factor.contribution === 0));
});

test("Python and TypeScript inference agree on exported parity fixtures", () => {
  for (const fixture of parityJson.fixtures) {
    const prediction = predictPropensity(propensityInputSchema.parse(fixture.input));
    assert.ok(
      Math.abs(prediction.probability - fixture.expectedProbability) <=
        parityJson.tolerance,
      `${fixture.name} probability differs: ${prediction.probability} vs ${fixture.expectedProbability}`
    );
    assert.ok(
      Math.abs(prediction.explanation.logOdds - fixture.expectedLogOdds) <=
        parityJson.tolerance,
      `${fixture.name} log-odds differs`
    );
  }
});

test("leakage fields are absent from model features and rejected from runtime input", () => {
  const leakageFields = ["horas_al_primer_contacto", "numero_contactos"];
  const sourceFields = [
    ...defaultPropensityArtifact.features.categorical.map(
      (feature) => feature.sourceField
    ),
    ...defaultPropensityArtifact.features.numeric.map((feature) => feature.sourceField)
  ];
  const explicitlyExcluded = new Set(
    defaultPropensityArtifact.excludedFields.map((field) => field.field)
  );

  assert.ok(leakageFields.every((field) => !sourceFields.includes(field)));
  assert.ok(leakageFields.every((field) => explicitlyExcluded.has(field)));

  const inputWithLeakage = {
    ...parityJson.fixtures[0].input,
    horas_al_primer_contacto: 1,
    numero_contactos: 2,
    confidence: 0.99
  };
  assert.equal(propensityInputSchema.safeParse(inputWithLeakage).success, false);
});

test("malformed artifacts are rejected", () => {
  const malformed = {
    ...artifactJson,
    features: {
      ...artifactJson.features,
      numeric: [{ ...artifactJson.features.numeric[0], scale: 0 }]
    }
  };

  assert.throws(() => loadPropensityArtifact(malformed));
});
