import { createHash } from "node:crypto";
import { normalizeChannel } from "../lib/normalization/channel";
import { normalizeCity } from "../lib/normalization/city";
import { parseMixedDate } from "../lib/normalization/date";
import { normalizeColombianPhone } from "../lib/normalization/phone";
import { normalizeLeadStatus } from "../lib/normalization/status";
import { normalizeWhitespace } from "../lib/normalization/text";
import type { RawLead } from "./types";

export function normalizeLead(raw: RawLead) {
  const registeredAt = parseMixedDate(raw.fecha_registro);
  const firstContactAt = parseMixedDate(raw.fecha_primer_contacto);
  const phone = normalizeColombianPhone(raw.telefono);
  const normalizedName = normalizeWhitespace(raw.nombre_cliente);
  const normalizedEmail = normalizeWhitespace(raw.email)?.toLowerCase() ?? null;

  const fingerprint = createHash("sha256")
    .update(JSON.stringify(raw))
    .digest("hex");

  return {
    id: raw.lead_id.trim(),
    companyId: raw.empresa_id.trim(),
    salesPointId: raw.punto_venta_id.trim(),
    registeredAt,
    firstContactAt,
    channel: normalizeChannel(raw.canal),
    status: normalizeLeadStatus(raw.estado_gestion),
    normalizedName,
    normalizedPhone: phone.normalized,
    normalizedEmail,
    city: normalizeCity(raw.ciudad),
    motorcycleText: normalizeWhitespace(raw.modelo_interes_texto),
    campaign: normalizeWhitespace(raw.campania),
    fingerprint,
    raw
  };
}
