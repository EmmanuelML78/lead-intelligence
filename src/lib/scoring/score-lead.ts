import type { AiExtractionResult } from "../ai/schema";
import {
  PRIORITY_BAND_THRESHOLDS,
  PRIORITY_SCORE_VERSION,
  PRIORITY_SCORE_WEIGHTS,
  calculateHybridScore,
  scoreCommercialIntent,
  scoreInputFingerprint,
  scoreInventory,
  scoreOperationalUrgency,
  type HybridScore,
  type InventoryScore,
  type IntentScore,
  type UrgencyScore
} from "./hybrid";
import {
  defaultPropensityArtifact,
  predictPropensity,
  type PropensityContribution,
  type PropensityInput
} from "./propensity";

export type ScoringAiExtraction = Pick<
  AiExtractionResult,
  | "purchaseIntent"
  | "requestedAppointment"
  | "requestedQuote"
  | "downPayment"
  | "paymentMethod"
  | "mainObjection"
  | "confidence"
> & {
  motorcycleSku: string | null;
};

export type ScoringMotorcycle = {
  sku: string;
  brand: string;
  line: string;
  listPrice: number;
};

export type InventoryCandidate = {
  motorcycleSku: string;
  unitsGlobal: number;
};

export type LeadScoringInput = {
  leadId: string;
  companyId: string;
  salesPointId: string;
  channel: string;
  registeredAt: Date | null;
  registeredAtAmbiguous: boolean;
  firstContactAt: Date | null;
  leadMotorcycleSku: string | null;
  aiExtraction: ScoringAiExtraction | null;
  motorcycles: ReadonlyMap<string, ScoringMotorcycle>;
  inventoryCandidates: readonly InventoryCandidate[];
  decisionAt: Date;
};

export type ScoreExplanation = {
  summary: string;
  scoreVersion: string;
  weights: typeof PRIORITY_SCORE_WEIGHTS;
  propensity: {
    rawProbability: number;
    artifactVersion: string;
    component: number;
    contribution: number;
    importantFactors: PropensityContribution[];
  };
  intent: IntentScore & {
    contribution: number;
  };
  urgency: UrgencyScore & {
    contribution: number;
  };
  inventory: InventoryScore & {
    contribution: number;
  };
};

export type LeadPriorityScore = HybridScore & {
  leadId: string;
  companyId: string;
  scoreVersion: string;
  inputFingerprint: string;
  explanation: ScoreExplanation;
};

export function buildPropensityInput(input: {
  channel: string;
  companyId: string;
  salesPointId: string;
  motorcycle: ScoringMotorcycle | null;
  aiExtraction: ScoringAiExtraction | null;
}): PropensityInput {
  const numericFeature = defaultPropensityArtifact.features.numeric[0];
  if (!numericFeature) throw new Error("Propensity artifact is missing listPrice feature");

  return {
    channel: input.channel,
    companyId: input.companyId,
    salesPointId: input.salesPointId,
    motorcycleModel: input.motorcycle
      ? `${input.motorcycle.brand} ${input.motorcycle.line}`
      : "UNKNOWN",
    listPrice: input.motorcycle?.listPrice ?? numericFeature.mean,
    declaredDownPayment:
      input.aiExtraction?.downPayment === undefined ||
      input.aiExtraction.downPayment === null
        ? "UNKNOWN"
        : input.aiExtraction.downPayment > 0
          ? "YES"
          : "NO",
    declaredPaymentMethod: input.aiExtraction?.paymentMethod ?? "UNKNOWN",
    requestedAppointment: input.aiExtraction
      ? input.aiExtraction.requestedAppointment
      : "UNKNOWN"
  };
}

export function selectCatalogInventory(
  motorcycleSku: string | null,
  candidates: readonly InventoryCandidate[]
): InventoryCandidate | null {
  if (!motorcycleSku) return null;
  return (
    candidates.find((candidate) => candidate.motorcycleSku === motorcycleSku) ?? null
  );
}

export function scoreLeadPriority(input: LeadScoringInput): LeadPriorityScore {
  const requestedSku = input.leadMotorcycleSku ?? input.aiExtraction?.motorcycleSku ?? null;
  const motorcycle = requestedSku ? input.motorcycles.get(requestedSku) ?? null : null;
  const effectiveSku = motorcycle?.sku ?? null;
  const inventoryRow = selectCatalogInventory(effectiveSku, input.inventoryCandidates);

  const propensityInput = buildPropensityInput({
    channel: input.channel,
    companyId: input.companyId,
    salesPointId: input.salesPointId,
    motorcycle,
    aiExtraction: input.aiExtraction
  });
  const propensity = predictPropensity(propensityInput);
  const propensityComponent = propensity.probability * 100;
  const intent = scoreCommercialIntent(input.aiExtraction);
  const urgency = scoreOperationalUrgency({
    registeredAt: input.registeredAt,
    registeredAtAmbiguous: input.registeredAtAmbiguous,
    firstContactAt: input.firstContactAt,
    decisionAt: input.decisionAt
  });
  const inventory = scoreInventory({
    sku: effectiveSku,
    unitsGlobal: inventoryRow?.unitsGlobal ?? null
  });
  const hybrid = calculateHybridScore({
    propensityComponent,
    intentComponent: intent.component,
    urgencyComponent: urgency.component,
    inventoryComponent: inventory.component
  });

  const relevantAiInput = input.aiExtraction
    ? {
        purchaseIntent: input.aiExtraction.purchaseIntent,
        requestedAppointment: input.aiExtraction.requestedAppointment,
        requestedQuote: input.aiExtraction.requestedQuote,
        downPayment: input.aiExtraction.downPayment,
        paymentMethod: input.aiExtraction.paymentMethod,
        mainObjection: input.aiExtraction.mainObjection,
        motorcycleSku: input.aiExtraction.motorcycleSku
      }
    : null;
  const inputFingerprint = scoreInputFingerprint({
    scoreVersion: PRIORITY_SCORE_VERSION,
    weights: PRIORITY_SCORE_WEIGHTS,
    bandThresholds: PRIORITY_BAND_THRESHOLDS,
    propensityArtifact: defaultPropensityArtifact,
    propensityInput,
    aiExtraction: relevantAiInput,
    urgency: {
      registeredAt: input.registeredAt?.toISOString() ?? null,
      registeredAtAmbiguous: input.registeredAtAmbiguous,
      contacted: urgency.contacted,
      bucket: urgency.bucket
    },
    inventory: {
      sku: inventory.sku,
      catalogStatus: inventory.catalogStatus,
      unitsGlobal: inventory.unitsGlobal
    }
  });

  const explanation: ScoreExplanation = {
    summary: buildSalesExplanation(hybrid, propensityComponent, intent, urgency, inventory),
    scoreVersion: PRIORITY_SCORE_VERSION,
    weights: PRIORITY_SCORE_WEIGHTS,
    propensity: {
      rawProbability: propensity.probability,
      artifactVersion: propensity.modelVersion,
      component: hybrid.propensityComponent,
      contribution: hybrid.contributions.propensity,
      importantFactors: propensity.explanation.importantFactors
    },
    intent: {
      ...intent,
      component: hybrid.intentComponent,
      contribution: hybrid.contributions.intent
    },
    urgency: {
      ...urgency,
      component: hybrid.urgencyComponent,
      contribution: hybrid.contributions.urgency
    },
    inventory: {
      ...inventory,
      component: hybrid.inventoryComponent,
      contribution: hybrid.contributions.inventory
    }
  };

  return {
    ...hybrid,
    leadId: input.leadId,
    companyId: input.companyId,
    scoreVersion: PRIORITY_SCORE_VERSION,
    inputFingerprint,
    explanation
  };
}

const INTENT_LABEL: Record<IntentScore["purchaseIntent"], string> = {
  HIGH: "alta",
  MEDIUM: "media",
  LOW: "baja",
  UNKNOWN: "desconocida"
};

function buildSalesExplanation(
  hybrid: HybridScore,
  propensityComponent: number,
  intent: IntentScore,
  urgency: UrgencyScore,
  inventory: InventoryScore
): string {
  const band = {
    CRITICAL: "crítica",
    HIGH: "alta",
    MEDIUM: "media",
    LOW: "baja"
  }[hybrid.priorityBand];
  const reasons = [`Prioridad ${band}`];

  if (urgency.contacted) {
    reasons.push("ya tuvo primer contacto; la urgencia SLA inicial se reduce");
  } else if (urgency.leadAgeMinutes === null) {
    reasons.push("la fecha de registro falta o es ambigua y se usa urgencia neutral");
  } else {
    reasons.push(`lleva ${formatDuration(urgency.leadAgeMinutes)} sin primer contacto`);
  }

  if (!intent.usedAiExtraction) {
    reasons.push("no hay extracción IA y se usa intención neutral");
  } else {
    reasons.push(
      `la conversación muestra intención ${INTENT_LABEL[intent.purchaseIntent]}`
    );
    const positiveSignals: string[] = [];
    if (intent.modifiers.some((modifier) => modifier.signal === "APPOINTMENT_REQUESTED")) {
      positiveSignals.push("solicitó cita");
    }
    if (intent.modifiers.some((modifier) => modifier.signal === "QUOTE_REQUESTED")) {
      positiveSignals.push("solicitó cotización");
    }
    if (positiveSignals.length > 0) reasons.push(positiveSignals.join(" y "));
    if (
      intent.modifiers.some((modifier) =>
        ["STRONG_OBJECTION", "COMPARISON_OBJECTION"].includes(modifier.signal)
      )
    ) {
      reasons.push("manifestó una objeción comercial");
    }
  }

  const historicalSignal =
    propensityComponent >= 15 ? "alta" : propensityComponent >= 8 ? "moderada" : "baja";
  reasons.push(`el histórico aporta una señal ${historicalSignal}`);

  if (inventory.catalogStatus === "UNKNOWN") {
    reasons.push("modelo o inventario de catálogo sin resolver");
  } else if (inventory.catalogStatus === "CATALOG_AVAILABLE") {
    reasons.push("el modelo registra disponibilidad global en el catálogo");
  } else {
    reasons.push("el modelo no registra unidades disponibles en el catálogo global");
  }

  return `${reasons.join(". ")}.`;
}

function formatDuration(ageMinutes: number): string {
  const roundedMinutes = Math.round(ageMinutes);
  const days = Math.floor(roundedMinutes / (24 * 60));
  const hours = Math.floor((roundedMinutes % (24 * 60)) / 60);
  const minutes = roundedMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
