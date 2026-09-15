import type { AssignmentReason, PriorityBand } from "@prisma/client";
import { resolveTranscriptRole, type TranscriptRole } from "../ai/transcript";
import { evidenceSchema, type Evidence } from "../ai/schema";
import type { ScoreExplanation } from "../scoring/score-lead";
import type { UrgencyBucket } from "../scoring/hybrid";

export type AssignmentState = "ASSIGNED" | "WAITING" | "UNASSIGNED";

export type AssignmentView = {
  state: AssignmentState;
  reasonCode: AssignmentReason | null;
  label: string;
  explanation: string;
  advisorId: string | null;
  advisorName: string | null;
  assignedFor: string | null;
};

const WAITING_COPY: Record<Exclude<AssignmentReason, "ASSIGNED">, string> = {
  CAPACITY_EXHAUSTED: "Waiting: sales-point daily capacity exhausted.",
  NO_ACTIVE_ADVISOR: "Waiting: no active advisor at this sales point.",
  NO_ELIGIBLE_ADVISOR: "Waiting: no eligible advisor at this sales point."
};

export function presentAssignment(input: {
  reasonCode: AssignmentReason;
  explanation: string;
  advisorId: string | null;
  advisorName: string | null;
  assignedFor: Date | null;
} | null): AssignmentView {
  if (!input) {
    return {
      state: "UNASSIGNED",
      reasonCode: null,
      label: "Unassigned",
      explanation: "No assignment for this business date.",
      advisorId: null,
      advisorName: null,
      assignedFor: null
    };
  }

  const assignedFor = input.assignedFor ? input.assignedFor.toISOString().slice(0, 10) : null;

  if (input.reasonCode === "ASSIGNED" && input.advisorId) {
    return {
      state: "ASSIGNED",
      reasonCode: input.reasonCode,
      label: "Assigned",
      explanation: input.explanation,
      advisorId: input.advisorId,
      advisorName: input.advisorName ?? input.advisorId,
      assignedFor
    };
  }

  if (input.reasonCode !== "ASSIGNED") {
    return {
      state: "WAITING",
      reasonCode: input.reasonCode,
      label: "Waiting",
      explanation: WAITING_COPY[input.reasonCode],
      advisorId: null,
      advisorName: null,
      assignedFor
    };
  }

  return {
    state: "UNASSIGNED",
    reasonCode: input.reasonCode,
    label: "Unassigned",
    explanation: input.explanation || "No assignment for this business date.",
    advisorId: null,
    advisorName: null,
    assignedFor
  };
}

export const MISSING_AI_EXTRACTION_COPY = "No AI extraction available for this conversation.";

export type AiExtractionView = {
  motorcycleInterest: string | null;
  budget: number | null;
  downPayment: number | null;
  paymentMethod: string;
  purchaseIntent: string;
  mainObjection: string;
  requestedAppointment: boolean;
  requestedQuote: boolean;
  evidence: Evidence;
};

export function presentAiExtraction(row: {
  motorcycleInterest: string | null;
  budget: number | null;
  downPayment: number | null;
  paymentMethod: string;
  purchaseIntent: string;
  mainObjection: string;
  requestedAppointment: boolean;
  requestedQuote: boolean;
  evidence: unknown;
} | null): AiExtractionView | null {
  if (!row) return null;
  return {
    motorcycleInterest: row.motorcycleInterest,
    budget: row.budget,
    downPayment: row.downPayment,
    paymentMethod: row.paymentMethod,
    purchaseIntent: row.purchaseIntent,
    mainObjection: row.mainObjection,
    requestedAppointment: row.requestedAppointment,
    requestedQuote: row.requestedQuote,
    evidence: parseEvidence(row.evidence)
  };
}

export function parseEvidence(value: unknown): Evidence {
  const parsed = evidenceSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

export type ConversationMessageView = {
  id: string;
  index: number;
  role: TranscriptRole;
  sentTime: string | null;
  text: string;
};

export function presentConversationMessage(message: {
  id: string;
  index: number;
  sender: string;
  sentTime: string | null;
  text: string;
}): ConversationMessageView {
  return {
    id: message.id,
    index: message.index,
    role: resolveTranscriptRole(message.sender),
    sentTime: message.sentTime,
    text: message.text
  };
}

export type SlaView = {
  label: string;
  ageLabel: string;
  contacted: boolean;
  bucket: UrgencyBucket | null;
};

const URGENCY_SLA_LABEL: Record<UrgencyBucket, string> = {
  CONTACTED: "Contacted",
  UNKNOWN_REGISTRATION_TIME: "Unknown registration time",
  FRESH_0_15M: "Fresh (<15m)",
  ACTIONABLE_15_45M: "Actionable (15–45m)",
  APPROACHING_SLA_45_60M: "Approaching SLA (45–60m)",
  OVERDUE_1_4H: "Overdue (1–4h)",
  SEVERELY_OVERDUE_4_24H: "Severely overdue (4–24h)",
  CRITICAL_24H_PLUS: "Critical (24h+ uncontacted)"
};

export function presentSla(input: {
  bucket?: UrgencyBucket | null;
  contacted?: boolean;
  leadAgeMinutes?: number | null;
  registeredAtAmbiguous?: boolean;
}): SlaView {
  const bucket = input.bucket ?? null;
  const contacted = input.contacted === true || bucket === "CONTACTED";
  const ageLabel =
    input.leadAgeMinutes == null
      ? input.registeredAtAmbiguous
        ? "Ambiguous date"
        : "Unknown age"
      : formatDurationMinutes(input.leadAgeMinutes);
  return {
    label: bucket ? URGENCY_SLA_LABEL[bucket] : contacted ? "Contacted" : "Unknown SLA",
    ageLabel,
    contacted,
    bucket
  };
}

export function formatDurationMinutes(ageMinutes: number): string {
  const roundedMinutes = Math.max(0, Math.round(ageMinutes));
  const days = Math.floor(roundedMinutes / (24 * 60));
  const hours = Math.floor((roundedMinutes % (24 * 60)) / 60);
  const minutes = roundedMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatCop(value: number | null): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0
  }).format(value);
}

export function formatScore(value: number): string {
  return value.toFixed(1);
}

export function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

export function channelLabel(channel: string): string {
  switch (channel) {
    case "WHATSAPP":
      return "WhatsApp";
    case "META_ADS":
      return "Meta Ads";
    case "WEB_FORM":
      return "Web form";
    default:
      return "Unknown";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "SIN_GESTION":
      return "Unworked";
    case "CONTACTADO":
      return "Contacted";
    case "NO_CONTESTA":
      return "No answer";
    case "COTIZACION_ENVIADA":
      return "Quote sent";
    case "EN_PROCESO":
      return "In progress";
    case "DESCARTADO":
      return "Discarded";
    default:
      return "Unknown";
  }
}

export function purchaseIntentLabel(intent: string): string {
  switch (intent) {
    case "HIGH":
      return "High";
    case "MEDIUM":
      return "Medium";
    case "LOW":
      return "Low";
    default:
      return "Unknown";
  }
}

export function paymentMethodLabel(method: string): string {
  switch (method) {
    case "CASH":
      return "Cash";
    case "CREDIT":
      return "Credit";
    default:
      return "Unknown";
  }
}

export function objectionLabel(objection: string): string {
  switch (objection) {
    case "PRICE":
      return "Price";
    case "CREDIT":
      return "Credit";
    case "AVAILABILITY":
      return "Availability";
    case "MODEL":
      return "Model";
    case "TIMING":
      return "Timing";
    case "COMPARISON":
      return "Comparison";
    case "OTHER":
      return "Other";
    case "NONE":
      return "None";
    default:
      return "Unknown";
  }
}

export function motorcycleLabel(input: {
  brand?: string | null;
  line?: string | null;
  sku?: string | null;
  raw?: string | null;
}): string {
  const catalog = [input.brand, input.line].filter(Boolean).join(" ").trim();
  if (catalog) return catalog;
  if (input.raw?.trim()) return input.raw.trim();
  if (input.sku) return input.sku;
  return "Unresolved model";
}

export function customerLabel(input: {
  normalizedName?: string | null;
  customerNameRaw?: string | null;
  leadId: string;
}): string {
  return input.normalizedName?.trim() || input.customerNameRaw?.trim() || input.leadId;
}

export type ScoreComponentView = {
  key: "propensity" | "intent" | "urgency" | "inventory";
  title: string;
  component: number;
  contribution: number;
  weight: number;
  explanation: string;
};

export function presentScoreComponents(explanation: ScoreExplanation | null): ScoreComponentView[] {
  if (!explanation) return [];
  return [
    {
      key: "propensity",
      title: "Historical propensity",
      component: explanation.propensity.component,
      contribution: explanation.propensity.contribution,
      weight: explanation.weights.propensity,
      explanation: propensityCopy(explanation)
    },
    {
      key: "intent",
      title: "AI commercial intent",
      component: explanation.intent.component,
      contribution: explanation.intent.contribution,
      weight: explanation.weights.intent,
      explanation: intentCopy(explanation)
    },
    {
      key: "urgency",
      title: "Operational urgency",
      component: explanation.urgency.component,
      contribution: explanation.urgency.contribution,
      weight: explanation.weights.urgency,
      explanation: urgencyCopy(explanation)
    },
    {
      key: "inventory",
      title: "Catalog availability",
      component: explanation.inventory.component,
      contribution: explanation.inventory.contribution,
      weight: explanation.weights.inventory,
      explanation: inventoryCopy(explanation)
    }
  ];
}

function propensityCopy(explanation: ScoreExplanation): string {
  const probability = (explanation.propensity.rawProbability * 100).toFixed(1);
  return `Historical close-rate signal from tabular features (${probability}% model probability). This is one input to operational priority, not a purchase forecast.`;
}

function intentCopy(explanation: ScoreExplanation): string {
  if (!explanation.intent.usedAiExtraction) {
    return "No AI extraction for this conversation; the intent component uses the documented neutral fallback.";
  }
  return `Conversation intent ${purchaseIntentLabel(explanation.intent.purchaseIntent).toLowerCase()}, with deterministic modifiers for appointment, quote, payment, and objections. Extraction confidence is not used.`;
}

function urgencyCopy(explanation: ScoreExplanation): string {
  const sla = presentSla({
    bucket: explanation.urgency.bucket,
    contacted: explanation.urgency.contacted,
    leadAgeMinutes: explanation.urgency.leadAgeMinutes
  });
  if (explanation.urgency.contacted) {
    return "Already contacted, so initial-response SLA urgency is reduced.";
  }
  return `${sla.label}. Uses current lead age at scoring time, never historical hours-to-first-contact.`;
}

function inventoryCopy(explanation: ScoreExplanation): string {
  if (explanation.inventory.catalogStatus === "CATALOG_AVAILABLE") {
    return "Resolved model has global catalog units. This is not company or store stock.";
  }
  if (explanation.inventory.catalogStatus === "CATALOG_UNAVAILABLE") {
    return "Resolved model has zero global catalog units.";
  }
  return "Model or catalog units unresolved; inventory uses the documented neutral fallback.";
}

export function parseScoreExplanation(value: unknown): ScoreExplanation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const weights = record.weights;
  const propensity = record.propensity;
  const intent = record.intent;
  const urgency = record.urgency;
  const inventory = record.inventory;
  if (
    !isRecord(weights) ||
    !isRecord(propensity) ||
    !isRecord(intent) ||
    !isRecord(urgency) ||
    !isRecord(inventory)
  ) {
    return null;
  }
  if (
    typeof weights.propensity !== "number" ||
    typeof weights.intent !== "number" ||
    typeof weights.urgency !== "number" ||
    typeof weights.inventory !== "number"
  ) {
    return null;
  }
  return value as ScoreExplanation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function bandClassName(band: PriorityBand): string {
  return `band band-${band.toLowerCase()}`;
}

export function issueTypeLabel(type: string): string {
  return type.replaceAll("_", " ");
}
