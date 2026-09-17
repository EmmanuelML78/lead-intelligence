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
  CAPACITY_EXHAUSTED: "En espera: la capacidad diaria del punto de venta está agotada.",
  NO_ACTIVE_ADVISOR: "En espera: no hay asesores activos en este punto de venta.",
  NO_ELIGIBLE_ADVISOR: "En espera: no hay asesores elegibles en este punto de venta."
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
      label: "Sin asignar",
      explanation: "No hay asignación para esta fecha de negocio.",
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
      label: "Asignado",
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
      label: "En espera",
      explanation: WAITING_COPY[input.reasonCode],
      advisorId: null,
      advisorName: null,
      assignedFor
    };
  }

  return {
    state: "UNASSIGNED",
    reasonCode: input.reasonCode,
    label: "Sin asignar",
    explanation: input.explanation || "No hay asignación para esta fecha de negocio.",
    advisorId: null,
    advisorName: null,
    assignedFor
  };
}

export const MISSING_AI_EXTRACTION_COPY =
  "No hay extracción de IA para esta conversación.";

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
  CONTACTED: "Contactado",
  UNKNOWN_REGISTRATION_TIME: "Hora de registro desconocida",
  FRESH_0_15M: "Recién llegado (<15 min)",
  ACTIONABLE_15_45M: "Accionable (15–45 min)",
  APPROACHING_SLA_45_60M: "Cerca del SLA (45–60 min)",
  OVERDUE_1_4H: "Vencido (1–4 h)",
  SEVERELY_OVERDUE_4_24H: "Muy vencido (4–24 h)",
  CRITICAL_24H_PLUS: "Crítico (más de 24 h sin contactar)"
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
        ? "Fecha ambigua"
        : "Edad desconocida"
      : formatDurationMinutes(input.leadAgeMinutes);
  return {
    label: bucket ? URGENCY_SLA_LABEL[bucket] : contacted ? "Contactado" : "SLA desconocido",
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
      return "Formulario web";
    default:
      return "Desconocido";
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case "SIN_GESTION":
      return "Sin gestión";
    case "CONTACTADO":
      return "Contactado";
    case "NO_CONTESTA":
      return "No contesta";
    case "COTIZACION_ENVIADA":
      return "Cotización enviada";
    case "EN_PROCESO":
      return "En proceso";
    case "DESCARTADO":
      return "Descartado";
    default:
      return "Desconocido";
  }
}

export function purchaseIntentLabel(intent: string): string {
  switch (intent) {
    case "HIGH":
      return "Alta";
    case "MEDIUM":
      return "Media";
    case "LOW":
      return "Baja";
    default:
      return "Desconocida";
  }
}

export function paymentMethodLabel(method: string): string {
  switch (method) {
    case "CASH":
      return "Contado";
    case "CREDIT":
      return "Crédito";
    default:
      return "Desconocido";
  }
}

export function objectionLabel(objection: string): string {
  switch (objection) {
    case "PRICE":
      return "Precio";
    case "CREDIT":
      return "Crédito";
    case "AVAILABILITY":
      return "Disponibilidad";
    case "MODEL":
      return "Modelo";
    case "TIMING":
      return "Tiempo";
    case "COMPARISON":
      return "Comparación";
    case "OTHER":
      return "Otra";
    case "NONE":
      return "Ninguna";
    default:
      return "Desconocida";
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
  return "Modelo sin resolver";
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
      title: "Propensión histórica",
      component: explanation.propensity.component,
      contribution: explanation.propensity.contribution,
      weight: explanation.weights.propensity,
      explanation: propensityCopy(explanation)
    },
    {
      key: "intent",
      title: "Intención comercial (IA)",
      component: explanation.intent.component,
      contribution: explanation.intent.contribution,
      weight: explanation.weights.intent,
      explanation: intentCopy(explanation)
    },
    {
      key: "urgency",
      title: "Urgencia operativa",
      component: explanation.urgency.component,
      contribution: explanation.urgency.contribution,
      weight: explanation.weights.urgency,
      explanation: urgencyCopy(explanation)
    },
    {
      key: "inventory",
      title: "Disponibilidad en catálogo",
      component: explanation.inventory.component,
      contribution: explanation.inventory.contribution,
      weight: explanation.weights.inventory,
      explanation: inventoryCopy(explanation)
    }
  ];
}

function propensityCopy(explanation: ScoreExplanation): string {
  const probability = (explanation.propensity.rawProbability * 100).toFixed(1);
  return `Señal histórica de cierre a partir de variables tabulares (${probability}% de probabilidad del modelo). Es un insumo de la prioridad operativa, no un pronóstico de compra.`;
}

function intentCopy(explanation: ScoreExplanation): string {
  if (!explanation.intent.usedAiExtraction) {
    return "No hay extracción de IA para esta conversación; el componente de intención usa el fallback neutro documentado.";
  }
  return `Intención de la conversación ${purchaseIntentLabel(explanation.intent.purchaseIntent).toLowerCase()}, con modificadores determinísticos por cita, cotización, pago y objeciones. La confianza de la extracción no se usa.`;
}

function urgencyCopy(explanation: ScoreExplanation): string {
  const sla = presentSla({
    bucket: explanation.urgency.bucket,
    contacted: explanation.urgency.contacted,
    leadAgeMinutes: explanation.urgency.leadAgeMinutes
  });
  if (explanation.urgency.contacted) {
    return "Ya fue contactado, así que la urgencia de primer contacto se reduce.";
  }
  return `${sla.label}. Usa la edad actual del lead al puntuar, nunca el tiempo histórico hasta el primer contacto.`;
}

function inventoryCopy(explanation: ScoreExplanation): string {
  if (explanation.inventory.catalogStatus === "CATALOG_AVAILABLE") {
    return "El modelo resuelto tiene unidades en el catálogo global. No es inventario de empresa ni de punto de venta.";
  }
  if (explanation.inventory.catalogStatus === "CATALOG_UNAVAILABLE") {
    return "El modelo resuelto no tiene unidades en el catálogo global.";
  }
  return "Modelo o unidades de catálogo sin resolver; inventario usa el fallback neutro documentado.";
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
  return ISSUE_TYPE_LABEL[type] ?? type.replaceAll("_", " ").toLowerCase();
}

const ISSUE_TYPE_LABEL: Record<string, string> = {
  AMBIGUOUS_DATE: "Fecha ambigua",
  MISSING_CITY: "Ciudad faltante",
  MISSING_MOTORCYCLE_INTEREST: "Interés de moto faltante",
  UNRESOLVED_MOTORCYCLE: "Modelo sin resolver",
  ORPHAN_CONVERSATION: "Conversación huérfana",
  DUPLICATE_LEAD_ID: "ID de lead duplicado",
  AI_EXTRACTION_PROVIDER_FAILED: "Fallo del proveedor de IA"
};

export function priorityBandLabel(band: PriorityBand): string {
  switch (band) {
    case "CRITICAL":
      return "Crítica";
    case "HIGH":
      return "Alta";
    case "MEDIUM":
      return "Media";
    case "LOW":
      return "Baja";
    default:
      return band;
  }
}

export function transcriptRoleLabel(role: TranscriptRole): string {
  switch (role) {
    case "CUSTOMER":
      return "Cliente";
    case "ADVISOR":
      return "Asesor";
    default:
      return "Desconocido";
  }
}

export function pipelineStatusLabel(status: string): string {
  switch (status) {
    case "SUCCESS":
      return "Completado";
    case "FAILED":
      return "Falló";
    case "RUNNING":
      return "En curso";
    default:
      return status;
  }
}

export function yesNo(value: boolean): string {
  return value ? "Sí" : "No";
}

export function formatDashboardDateTime(value: Date | string): string {
  return new Date(value).toLocaleString("es-CO", {
    dateStyle: "short",
    timeStyle: "short"
  });
}
