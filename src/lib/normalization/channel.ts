import { normalizeSearchText } from "./text";

export type NormalizedChannel = "WHATSAPP" | "META_ADS" | "WEB_FORM" | "UNKNOWN";

export function normalizeChannel(value: string | null | undefined): NormalizedChannel {
  const text = normalizeSearchText(value);
  if (!text) return "UNKNOWN";
  if (text === "whatsapp") return "WHATSAPP";
  if (text === "meta ads") return "META_ADS";
  if (text === "formulario web") return "WEB_FORM";
  return "UNKNOWN";
}
