import { createHash } from "node:crypto";
import type { AiExtractionResult } from "../ai/schema";

export const PRIORITY_SCORE_VERSION = "hybrid-v1";

/**
 * Business-calibrated V1 starting weights. They are deliberately explicit:
 * historical propensity is modest, while current SLA urgency dominates.
 * Inventory is a 5% catalog-global term; its semantics changed in 5.1
 * (CATALOG_* statuses) without changing these weights, so the version stays.
 */
export const PRIORITY_SCORE_WEIGHTS = {
  propensity: 20,
  intent: 35,
  urgency: 40,
  inventory: 5
} as const;

export const PRIORITY_BAND_THRESHOLDS = {
  CRITICAL: 55,
  HIGH: 45,
  MEDIUM: 30
} as const;

export type PriorityBand = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

type IntentExtraction = Pick<
  AiExtractionResult,
  | "purchaseIntent"
  | "requestedAppointment"
  | "requestedQuote"
  | "downPayment"
  | "paymentMethod"
  | "mainObjection"
  | "confidence"
>;

export type IntentModifier = {
  signal:
    | "APPOINTMENT_REQUESTED"
    | "QUOTE_REQUESTED"
    | "DOWN_PAYMENT_DECLARED"
    | "PAYMENT_METHOD_DECLARED"
    | "STRONG_OBJECTION"
    | "COMPARISON_OBJECTION";
  points: number;
};

export type IntentScore = {
  purchaseIntent: AiExtractionResult["purchaseIntent"];
  modifiers: IntentModifier[];
  component: number;
  usedAiExtraction: boolean;
};

const INTENT_BASE: Record<AiExtractionResult["purchaseIntent"], number> = {
  HIGH: 100,
  MEDIUM: 65,
  LOW: 25,
  UNKNOWN: 40
};

const STRONG_OBJECTIONS = new Set<AiExtractionResult["mainObjection"]>([
  "PRICE",
  "CREDIT",
  "AVAILABILITY",
  "MODEL",
  "TIMING",
  "OTHER"
]);

export function scoreCommercialIntent(extraction: IntentExtraction | null): IntentScore {
  // V1 ignores extraction.confidence on purpose: it is extraction-quality
  // metadata, not purchase probability, and live Gemini returned a uniform 0.95.
  if (!extraction) {
    return {
      purchaseIntent: "UNKNOWN",
      modifiers: [],
      component: INTENT_BASE.UNKNOWN,
      usedAiExtraction: false
    };
  }

  const modifiers: IntentModifier[] = [];
  if (extraction.requestedAppointment) {
    modifiers.push({ signal: "APPOINTMENT_REQUESTED", points: 10 });
  }
  if (extraction.requestedQuote) {
    modifiers.push({ signal: "QUOTE_REQUESTED", points: 8 });
  }
  if (extraction.downPayment !== null && extraction.downPayment > 0) {
    modifiers.push({ signal: "DOWN_PAYMENT_DECLARED", points: 6 });
  }
  if (extraction.paymentMethod !== "UNKNOWN") {
    modifiers.push({ signal: "PAYMENT_METHOD_DECLARED", points: 4 });
  }
  if (extraction.mainObjection === "COMPARISON") {
    modifiers.push({ signal: "COMPARISON_OBJECTION", points: -8 });
  } else if (STRONG_OBJECTIONS.has(extraction.mainObjection)) {
    modifiers.push({ signal: "STRONG_OBJECTION", points: -5 });
  }

  return {
    purchaseIntent: extraction.purchaseIntent,
    modifiers,
    component: clampComponent(
      INTENT_BASE[extraction.purchaseIntent] +
        modifiers.reduce((total, modifier) => total + modifier.points, 0)
    ),
    usedAiExtraction: true
  };
}

export type UrgencyBucket =
  | "CONTACTED"
  | "UNKNOWN_REGISTRATION_TIME"
  | "FRESH_0_15M"
  | "ACTIONABLE_15_45M"
  | "APPROACHING_SLA_45_60M"
  | "OVERDUE_1_4H"
  | "SEVERELY_OVERDUE_4_24H"
  | "CRITICAL_24H_PLUS";

export type UrgencyScore = {
  leadAgeMinutes: number | null;
  contacted: boolean;
  registrationTimeReliable: boolean;
  bucket: UrgencyBucket;
  component: number;
};

export function scoreOperationalUrgency(input: {
  registeredAt: Date | null;
  registeredAtAmbiguous?: boolean;
  firstContactAt: Date | null;
  decisionAt: Date;
}): UrgencyScore {
  const contacted = input.firstContactAt !== null;
  const registrationTimeReliable =
    input.registeredAt !== null && input.registeredAtAmbiguous !== true;
  const leadAgeMinutes = registrationTimeReliable && input.registeredAt
    ? Math.max(0, (input.decisionAt.getTime() - input.registeredAt.getTime()) / 60_000)
    : null;

  if (contacted) {
    return {
      leadAgeMinutes,
      contacted,
      registrationTimeReliable,
      bucket: "CONTACTED",
      component: 20
    };
  }
  if (leadAgeMinutes === null) {
    return {
      leadAgeMinutes,
      contacted,
      registrationTimeReliable,
      bucket: "UNKNOWN_REGISTRATION_TIME",
      component: 50
    };
  }
  if (leadAgeMinutes >= 24 * 60) {
    return {
      leadAgeMinutes,
      contacted,
      registrationTimeReliable,
      bucket: "CRITICAL_24H_PLUS",
      component: 100
    };
  }
  if (leadAgeMinutes >= 4 * 60) {
    return {
      leadAgeMinutes,
      contacted,
      registrationTimeReliable,
      bucket: "SEVERELY_OVERDUE_4_24H",
      component: 95
    };
  }
  if (leadAgeMinutes >= 60) {
    return {
      leadAgeMinutes,
      contacted,
      registrationTimeReliable,
      bucket: "OVERDUE_1_4H",
      component: 90
    };
  }
  if (leadAgeMinutes >= 45) {
    return {
      leadAgeMinutes,
      contacted,
      registrationTimeReliable,
      bucket: "APPROACHING_SLA_45_60M",
      component: 75
    };
  }
  if (leadAgeMinutes >= 15) {
    return {
      leadAgeMinutes,
      contacted,
      registrationTimeReliable,
      bucket: "ACTIONABLE_15_45M",
      component: 50
    };
  }
  return {
    leadAgeMinutes,
    contacted,
    registrationTimeReliable,
    bucket: "FRESH_0_15M",
    component: 35
  };
}

export type CatalogAvailability =
  | "CATALOG_AVAILABLE"
  | "CATALOG_UNAVAILABLE"
  | "UNKNOWN";

export type InventoryScore = {
  sku: string | null;
  catalogStatus: CatalogAvailability;
  available: boolean | null;
  unitsGlobal: number | null;
  component: number;
};

export function scoreInventory(input: {
  sku: string | null;
  unitsGlobal: number | null;
}): InventoryScore {
  if (!input.sku || input.unitsGlobal === null) {
    return {
      sku: input.sku,
      catalogStatus: "UNKNOWN",
      available: null,
      unitsGlobal: null,
      component: 50
    };
  }
  const catalogStatus: CatalogAvailability =
    input.unitsGlobal > 0 ? "CATALOG_AVAILABLE" : "CATALOG_UNAVAILABLE";
  return {
    sku: input.sku,
    catalogStatus,
    available: catalogStatus === "CATALOG_AVAILABLE",
    unitsGlobal: input.unitsGlobal,
    component: catalogStatus === "CATALOG_AVAILABLE" ? 100 : 20
  };
}

export type HybridScoreInput = {
  propensityComponent: number;
  intentComponent: number;
  urgencyComponent: number;
  inventoryComponent: number;
};

export type HybridScore = HybridScoreInput & {
  contributions: {
    propensity: number;
    intent: number;
    urgency: number;
    inventory: number;
  };
  totalScore: number;
  priorityBand: PriorityBand;
};

export function calculateHybridScore(input: HybridScoreInput): HybridScore {
  const propensityComponent = clampComponent(input.propensityComponent);
  const intentComponent = clampComponent(input.intentComponent);
  const urgencyComponent = clampComponent(input.urgencyComponent);
  const inventoryComponent = clampComponent(input.inventoryComponent);
  const contributions = {
    propensity: (propensityComponent * PRIORITY_SCORE_WEIGHTS.propensity) / 100,
    intent: (intentComponent * PRIORITY_SCORE_WEIGHTS.intent) / 100,
    urgency: (urgencyComponent * PRIORITY_SCORE_WEIGHTS.urgency) / 100,
    inventory: (inventoryComponent * PRIORITY_SCORE_WEIGHTS.inventory) / 100
  };
  const totalScore = clampComponent(
    contributions.propensity +
      contributions.intent +
      contributions.urgency +
      contributions.inventory
  );

  return {
    propensityComponent,
    intentComponent,
    urgencyComponent,
    inventoryComponent,
    contributions,
    totalScore,
    priorityBand: priorityBandFor(totalScore)
  };
}

export function priorityBandFor(totalScore: number): PriorityBand {
  if (totalScore >= PRIORITY_BAND_THRESHOLDS.CRITICAL) return "CRITICAL";
  if (totalScore >= PRIORITY_BAND_THRESHOLDS.HIGH) return "HIGH";
  if (totalScore >= PRIORITY_BAND_THRESHOLDS.MEDIUM) return "MEDIUM";
  return "LOW";
}

export function scoreInputFingerprint(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function weightSum(): number {
  return Object.values(PRIORITY_SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
}

function clampComponent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Score fingerprint cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported score fingerprint value: ${typeof value}`);
}
