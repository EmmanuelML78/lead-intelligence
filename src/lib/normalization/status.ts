import { normalizeSearchText } from "./text";

export type NormalizedStatus =
  | "SIN_GESTION"
  | "CONTACTADO"
  | "NO_CONTESTA"
  | "COTIZACION_ENVIADA"
  | "EN_PROCESO"
  | "DESCARTADO"
  | "UNKNOWN";

export function normalizeLeadStatus(value: string | null | undefined): NormalizedStatus {
  const text = normalizeSearchText(value);
  const map: Record<string, NormalizedStatus> = {
    "sin gestion": "SIN_GESTION",
    "contactado": "CONTACTADO",
    "no contesta": "NO_CONTESTA",
    "cotizacion enviada": "COTIZACION_ENVIADA",
    "en proceso": "EN_PROCESO",
    "descartado": "DESCARTADO"
  };
  return text ? (map[text] ?? "UNKNOWN") : "UNKNOWN";
}
