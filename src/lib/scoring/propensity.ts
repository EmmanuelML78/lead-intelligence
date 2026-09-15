import { z } from "zod";
import artifactJson from "../../../artifacts/propensity-model-v1.json";

const finiteNumber = z.number().finite();
const categoricalFeatureNameSchema = z.enum([
  "channel",
  "companyId",
  "salesPointId",
  "motorcycleModel",
  "declaredDownPayment",
  "declaredPaymentMethod",
  "requestedAppointment"
]);

const featureDecisionSchema = z
  .object({
    field: z.string().min(1),
    class: z.enum(["A", "B", "C"]),
    included: z.boolean(),
    reason: z.string().min(1)
  })
  .strict();

const categoricalFeatureSchema = z
  .object({
    name: categoricalFeatureNameSchema,
    sourceField: z.string().min(1),
    categories: z.array(z.string().min(1)).min(1),
    referenceCategory: z.string().min(1),
    coefficients: z.record(z.string(), finiteNumber),
    unknownCategoryPolicy: z.literal("zero_contribution")
  })
  .strict();

const numericFeatureSchema = z
  .object({
    name: z.literal("listPrice"),
    sourceField: z.literal("precio_lista"),
    mean: finiteNumber,
    scale: finiteNumber.positive(),
    coefficient: finiteNumber
  })
  .strict();

export const propensityArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    modelVersion: z.string().min(1),
    trainedAt: z.iso.date(),
    algorithm: z
      .object({
        name: z.literal("l2_regularized_logistic_regression"),
        optimizer: z.string().min(1),
        l2Strength: finiteNumber.nonnegative(),
        epochs: z.number().int().positive(),
        randomSeed: z.number().int()
      })
      .strict(),
    targetDefinition: z
      .object({
        positive: z.string().min(1),
        negative: z.string().min(1),
        primaryPopulation: z.string().min(1)
      })
      .strict(),
    trainingPopulation: z
      .object({
        records: z.number().int().positive(),
        source: z.string().min(1)
      })
      .strict(),
    featureDefinitions: z.array(featureDecisionSchema).min(1),
    features: z
      .object({
        categorical: z.array(categoricalFeatureSchema),
        numeric: z.array(numericFeatureSchema)
      })
      .strict(),
    intercept: finiteNumber,
    evaluation: z.record(z.string(), z.unknown()),
    excludedFields: z.array(featureDecisionSchema),
    limitations: z.array(z.string().min(1)).min(1)
  })
  .strict()
  .superRefine((artifact, context) => {
    const expectedNames = new Set(categoricalFeatureNameSchema.options);
    const actualNames = new Set(artifact.features.categorical.map((feature) => feature.name));
    if (
      actualNames.size !== expectedNames.size ||
      [...expectedNames].some((name) => !actualNames.has(name))
    ) {
      context.addIssue({
        code: "custom",
        message: "Artifact must define every supported categorical feature exactly once",
        path: ["features", "categorical"]
      });
    }

    for (const [index, feature] of artifact.features.categorical.entries()) {
      if (!feature.categories.includes(feature.referenceCategory)) {
        context.addIssue({
          code: "custom",
          message: "Reference category must be included in categories",
          path: ["features", "categorical", index, "referenceCategory"]
        });
      }
      const invalidCoefficient = Object.keys(feature.coefficients).find(
        (category) => !feature.categories.includes(category)
      );
      if (invalidCoefficient !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Coefficient category ${invalidCoefficient} is not declared`,
          path: ["features", "categorical", index, "coefficients", invalidCoefficient]
        });
      }
    }

    if (artifact.features.numeric.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "Artifact must define exactly one listPrice numeric feature",
        path: ["features", "numeric"]
      });
    }

    const leakageFields = new Set(["horas_al_primer_contacto", "numero_contactos"]);
    const modelSourceFields = [
      ...artifact.features.categorical.map((feature) => feature.sourceField),
      ...artifact.features.numeric.map((feature) => feature.sourceField)
    ];
    if (modelSourceFields.some((field) => leakageFields.has(field))) {
      context.addIssue({
        code: "custom",
        message: "Artifact contains a post-treatment leakage feature",
        path: ["features"]
      });
    }
    const excluded = new Set(artifact.excludedFields.map((field) => field.field));
    for (const field of leakageFields) {
      if (!excluded.has(field)) {
        context.addIssue({
          code: "custom",
          message: `Artifact must explicitly record excluded leakage field ${field}`,
          path: ["excludedFields"]
        });
      }
    }
  });

export const propensityInputSchema = z
  .object({
    channel: z.string().min(1),
    companyId: z.string().min(1),
    salesPointId: z.string().min(1),
    motorcycleModel: z.string().min(1),
    listPrice: finiteNumber.nonnegative(),
    declaredDownPayment: z.enum(["YES", "NO", "UNKNOWN"]),
    declaredPaymentMethod: z.enum(["CREDIT", "CASH", "UNKNOWN"]),
    requestedAppointment: z.union([z.boolean(), z.literal("UNKNOWN")])
  })
  .strict();

export type PropensityArtifact = z.infer<typeof propensityArtifactSchema>;
export type PropensityInput = z.infer<typeof propensityInputSchema>;
type CategoricalFeatureName = z.infer<typeof categoricalFeatureNameSchema>;

export type PropensityContribution = {
  feature: CategoricalFeatureName | "listPrice";
  value: string | number;
  contribution: number;
  knownCategory: boolean;
};

export type PropensityPrediction = {
  probability: number;
  modelVersion: string;
  explanation: {
    intercept: number;
    logOdds: number;
    contributions: PropensityContribution[];
    importantFactors: PropensityContribution[];
  };
};

export function loadPropensityArtifact(raw: unknown): PropensityArtifact {
  return propensityArtifactSchema.parse(raw);
}

export const defaultPropensityArtifact = loadPropensityArtifact(artifactJson);

function categoryValue(input: PropensityInput, feature: CategoricalFeatureName): string {
  switch (feature) {
    case "channel":
      return input.channel;
    case "companyId":
      return input.companyId;
    case "salesPointId":
      return input.salesPointId;
    case "motorcycleModel":
      return input.motorcycleModel;
    case "declaredDownPayment":
      return input.declaredDownPayment;
    case "declaredPaymentMethod":
      return input.declaredPaymentMethod;
    case "requestedAppointment":
      return input.requestedAppointment === "UNKNOWN"
        ? "UNKNOWN"
        : input.requestedAppointment
          ? "YES"
          : "NO";
  }
}

function sigmoid(logOdds: number): number {
  if (logOdds >= 0) {
    return 1 / (1 + Math.exp(-logOdds));
  }
  const expLogOdds = Math.exp(logOdds);
  return expLogOdds / (1 + expLogOdds);
}

export function predictPropensity(
  rawInput: PropensityInput,
  artifact: PropensityArtifact = defaultPropensityArtifact
): PropensityPrediction {
  const input = propensityInputSchema.parse(rawInput);
  let logOdds = artifact.intercept;
  const contributions: PropensityContribution[] = [];

  for (const feature of artifact.features.categorical) {
    const value = categoryValue(input, feature.name);
    const contribution = feature.coefficients[value] ?? 0;
    logOdds += contribution;
    contributions.push({
      feature: feature.name,
      value,
      contribution,
      knownCategory: feature.categories.includes(value)
    });
  }

  for (const feature of artifact.features.numeric) {
    const contribution =
      ((input.listPrice - feature.mean) / feature.scale) * feature.coefficient;
    logOdds += contribution;
    contributions.push({
      feature: feature.name,
      value: input.listPrice,
      contribution,
      knownCategory: true
    });
  }

  const importantFactors = [...contributions]
    .filter((factor) => factor.contribution !== 0)
    .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution))
    .slice(0, 3);

  return {
    probability: sigmoid(logOdds),
    modelVersion: artifact.modelVersion,
    explanation: {
      intercept: artifact.intercept,
      logOdds,
      contributions,
      importantFactors
    }
  };
}
