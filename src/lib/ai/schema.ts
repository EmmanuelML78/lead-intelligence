import { z } from "zod";

/**
 * Extraction output shape. Bumped whenever the *shape or semantics* of the
 * extraction contract changes (new field, changed enum values, etc.) -- not
 * for prompt wording tweaks (see AI_PROMPT_VERSION in prompt.ts). Persisted
 * on every AiExtraction row for audit; never overwritten in place.
 */
export const AI_EXTRACTION_VERSION = "v1";

const evidenceFieldNames = [
  "motorcycleInterest",
  "budget",
  "downPayment",
  "paymentMethod",
  "purchaseIntent",
  "mainObjection",
  "requestedAppointment",
  "requestedQuote"
] as const;

/**
 * Short, verbatim-leaning excerpts that justify each extracted field. Every
 * key is optional/defaults to an empty array -- an UNKNOWN/null field may
 * legitimately have no evidence at all (contract item 9).
 */
export const evidenceSchema = z.object(
  Object.fromEntries(
    evidenceFieldNames.map((name) => [name, z.array(z.string().trim().min(1)).max(5).default([])])
  ) as Record<(typeof evidenceFieldNames)[number], z.ZodDefault<z.ZodArray<z.ZodString>>>
);

export type Evidence = Partial<Record<(typeof evidenceFieldNames)[number], string[]>>;

/**
 * The AI extraction contract (assessment.mdc "AI Rules" + Milestone 3
 * spec). The model must never invent a value that isn't supported by the
 * conversation -- absence is represented with null/UNKNOWN, not guessed.
 */
export const aiExtractionResultSchema = z.object({
  motorcycleInterest: z.string().trim().min(1).nullable(),
  budget: z.number().finite().nonnegative().nullable(),
  downPayment: z.number().finite().nonnegative().nullable(),
  paymentMethod: z.enum(["CASH", "CREDIT", "UNKNOWN"]),
  purchaseIntent: z.enum(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]),
  mainObjection: z.enum([
    "PRICE",
    "CREDIT",
    "AVAILABILITY",
    "MODEL",
    "TIMING",
    "COMPARISON",
    "OTHER",
    "NONE",
    "UNKNOWN"
  ]),
  requestedAppointment: z.boolean(),
  requestedQuote: z.boolean(),
  confidence: z.number().min(0).max(1),
  evidence: evidenceSchema
});

export type AiExtractionResult = z.infer<typeof aiExtractionResultSchema>;

/**
 * Schema mirror of the contract above, handed to Gemini's `responseSchema`
 * (`generationConfig.responseSchema`). This is NOT standard JSON Schema --
 * Gemini's structured-output field is a protobuf/OpenAPI-3.0 subset that
 * represents "nullable" as a boolean `nullable: true` alongside a single
 * scalar `type`, not JSON Schema's `type: ["string", "null"]` union array.
 * Sending the union-array form makes the REST API reject the whole request
 * with HTTP 400 ("Proto field is not repeating, cannot start list") --
 * caught live during Milestone 3.1 validation. Zod (`aiExtractionResultSchema`
 * above) is still the source of truth and always re-validates the response
 * regardless of what this schema tells the provider to produce.
 */
export const aiExtractionJsonSchema = {
  type: "object",
  properties: {
    motorcycleInterest: { type: "string", nullable: true },
    budget: { type: "number", nullable: true },
    downPayment: { type: "number", nullable: true },
    paymentMethod: { type: "string", enum: ["CASH", "CREDIT", "UNKNOWN"] },
    purchaseIntent: { type: "string", enum: ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] },
    mainObjection: {
      type: "string",
      enum: ["PRICE", "CREDIT", "AVAILABILITY", "MODEL", "TIMING", "COMPARISON", "OTHER", "NONE", "UNKNOWN"]
    },
    requestedAppointment: { type: "boolean" },
    requestedQuote: { type: "boolean" },
    confidence: { type: "number" },
    evidence: {
      type: "object",
      properties: Object.fromEntries(
        evidenceFieldNames.map((name) => [name, { type: "array", items: { type: "string" } }])
      )
    }
  },
  required: [
    "motorcycleInterest",
    "budget",
    "downPayment",
    "paymentMethod",
    "purchaseIntent",
    "mainObjection",
    "requestedAppointment",
    "requestedQuote",
    "confidence",
    "evidence"
  ]
} as const;
