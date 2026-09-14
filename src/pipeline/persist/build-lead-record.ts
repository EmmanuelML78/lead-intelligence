import type { CatalogMotorcycle } from "../../lib/normalization/motorcycle";
import { matchMotorcycle } from "../../lib/normalization/motorcycle";
import { normalizeLead } from "../normalize-lead";
import type { RawLead } from "../types";
import type { PipelineIssueInput } from "./pipeline-issue";

export type NormalizedLeadRecord = {
  id: string;
  companyId: string;
  salesPointId: string;
  registeredAt: Date | null;
  registeredAtAmbiguous: boolean;
  channel: "WHATSAPP" | "META_ADS" | "WEB_FORM" | "UNKNOWN";
  status:
    | "SIN_GESTION"
    | "CONTACTADO"
    | "NO_CONTESTA"
    | "COTIZACION_ENVIADA"
    | "EN_PROCESO"
    | "DESCARTADO"
    | "UNKNOWN";
  customerNameRaw: string | null;
  phoneRaw: string | null;
  emailRaw: string | null;
  cityRaw: string | null;
  motorcycleTextRaw: string | null;
  normalizedName: string | null;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
  cityNormalized: string | null;
  motorcycleSku: string | null;
  motorcycleMatchConfidence: number | null;
  motorcycleMatchMethod: string | null;
  firstContactAt: Date | null;
  firstContactAtAmbiguous: boolean;
  campaign: string | null;
  sourceFingerprint: string;
  rawPayload: RawLead;
};

export function buildLeadRecord(
  raw: RawLead,
  catalog: CatalogMotorcycle[]
): { record: NormalizedLeadRecord; issues: PipelineIssueInput[] } {
  const normalized = normalizeLead(raw);
  const motorcycleMatch = matchMotorcycle(normalized.motorcycleText, catalog);
  const issues: PipelineIssueInput[] = [];

  if (normalized.registeredAt.ambiguous) {
    issues.push({
      type: "AMBIGUOUS_DATE",
      severity: "WARNING",
      entityType: "Lead",
      entityId: normalized.id,
      field: "fecha_registro",
      rawValue: raw.fecha_registro,
      message: `Lead ${normalized.id} registration date "${raw.fecha_registro}" is ambiguous (day/month could not be disambiguated); parsed with rule "${normalized.registeredAt.rule}".`
    });
  }
  if (normalized.firstContactAt.ambiguous) {
    issues.push({
      type: "AMBIGUOUS_DATE",
      severity: "WARNING",
      entityType: "Lead",
      entityId: normalized.id,
      field: "fecha_primer_contacto",
      rawValue: raw.fecha_primer_contacto,
      message: `Lead ${normalized.id} first-contact date "${raw.fecha_primer_contacto}" is ambiguous (day/month could not be disambiguated); parsed with rule "${normalized.firstContactAt.rule}".`
    });
  }
  if (!normalized.city) {
    issues.push({
      type: "MISSING_CITY",
      severity: "INFO",
      entityType: "Lead",
      entityId: normalized.id,
      field: "ciudad",
      rawValue: raw.ciudad,
      message: `Lead ${normalized.id} has no usable city value.`
    });
  }
  if (!normalized.motorcycleText) {
    // Distinct from UNRESOLVED_MOTORCYCLE: the lead stated no interest at
    // all, so there is nothing to match against the catalog -- this is a
    // missing-data condition, not a failed match.
    issues.push({
      type: "MISSING_MOTORCYCLE_INTEREST",
      severity: "INFO",
      entityType: "Lead",
      entityId: normalized.id,
      field: "modelo_interes_texto",
      rawValue: raw.modelo_interes_texto,
      message: `Lead ${normalized.id} has no stated motorcycle interest.`
    });
  } else if (!motorcycleMatch.sku) {
    issues.push({
      type: "UNRESOLVED_MOTORCYCLE",
      severity: "WARNING",
      entityType: "Lead",
      entityId: normalized.id,
      field: "modelo_interes_texto",
      rawValue: normalized.motorcycleText,
      message: `Lead ${normalized.id} motorcycle interest "${normalized.motorcycleText}" could not be matched to the catalog (best score ${motorcycleMatch.confidence.toFixed(2)}).`
    });
  }

  const record: NormalizedLeadRecord = {
    id: normalized.id,
    companyId: normalized.companyId,
    salesPointId: normalized.salesPointId,
    registeredAt: normalized.registeredAt.date,
    registeredAtAmbiguous: normalized.registeredAt.ambiguous,
    channel: normalized.channel,
    status: normalized.status,
    customerNameRaw: raw.nombre_cliente?.trim() || null,
    phoneRaw: raw.telefono?.trim() || null,
    emailRaw: raw.email?.trim() || null,
    cityRaw: raw.ciudad?.trim() || null,
    motorcycleTextRaw: raw.modelo_interes_texto?.trim() || null,
    normalizedName: normalized.normalizedName,
    normalizedPhone: normalized.normalizedPhone,
    normalizedEmail: normalized.normalizedEmail,
    cityNormalized: normalized.city,
    motorcycleSku: motorcycleMatch.sku,
    motorcycleMatchConfidence: motorcycleMatch.sku ? motorcycleMatch.confidence : null,
    motorcycleMatchMethod: motorcycleMatch.sku ? motorcycleMatch.method : null,
    firstContactAt: normalized.firstContactAt.date,
    firstContactAtAmbiguous: normalized.firstContactAt.ambiguous,
    campaign: normalized.campaign,
    sourceFingerprint: normalized.fingerprint,
    rawPayload: raw
  };

  return { record, issues };
}
