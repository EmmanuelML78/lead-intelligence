import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv, readJson } from "./io";
import { normalizeLead } from "./normalize-lead";
import type { RawAdvisor, RawLead, RawMotorcycle } from "./types";
import { matchMotorcycle } from "../lib/normalization/motorcycle";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const dataDir = path.join(root, "data/raw");

const leads = await readCsv<RawLead>(path.join(dataDir, "leads.csv"));
const advisors = await readCsv<RawAdvisor>(path.join(dataDir, "asesores.csv"));
const motorcycles = await readCsv<RawMotorcycle>(path.join(dataDir, "catalogo_motos.csv"));
const conversations = await readJson<Array<{ conversacion_id: string; lead_id: string }>>(path.join(dataDir, "conversaciones.json"));

const normalized = leads.map(normalizeLead);
const uniqueLeadIds = new Set(normalized.map((x) => x.id));
const duplicateLeadIds = normalized.length - uniqueLeadIds.size;

const duplicateCustomerGroups = new Map<string, string[]>();
for (const lead of normalized) {
  if (!lead.normalizedPhone) continue;
  const key = `${lead.companyId}|${lead.normalizedPhone}`;
  const group = duplicateCustomerGroups.get(key) ?? [];
  group.push(lead.id);
  duplicateCustomerGroups.set(key, group);
}
const duplicatedCustomers = [...duplicateCustomerGroups.values()].filter((g) => g.length > 1);

const catalog = motorcycles.map((m) => ({ sku: m.sku, brand: m.marca, line: m.linea }));
const motorcycleMatches = normalized.map((lead) => matchMotorcycle(lead.motorcycleText, catalog));
const unresolvedMotorcycles = motorcycleMatches.filter((m) => !m.sku).length;
const ambiguousDates = normalized.filter((x) => x.registeredAt.ambiguous).length;
const invalidPhones = normalized.filter((x) => !x.normalizedPhone).length;
const missingCities = normalized.filter((x) => !x.city).length;
const orphanConversations = conversations.filter((c) => !uniqueLeadIds.has(c.lead_id)).length;
const activeAdvisors = advisors.filter((a) => a.activo.trim().toUpperCase() === "SI");
const totalCapacity = activeAdvisors.reduce((sum, a) => sum + Number(a.capacidad_diaria_leads || 0), 0);

console.log("\nLead Intelligence — pipeline preflight\n");
console.table({
  leads_received: leads.length,
  unique_lead_ids: uniqueLeadIds.size,
  duplicate_lead_ids: duplicateLeadIds,
  duplicate_customer_groups: duplicatedCustomers.length,
  conversations: conversations.length,
  orphan_conversations: orphanConversations,
  ambiguous_registration_dates: ambiguousDates,
  invalid_or_missing_phones: invalidPhones,
  missing_cities: missingCities,
  unresolved_motorcycles: unresolvedMotorcycles,
  advisors: advisors.length,
  active_advisors: activeAdvisors.length,
  total_daily_capacity: totalCapacity
});

console.log("\nSample duplicate customer groups:");
console.log(duplicatedCustomers.slice(0, 5));

console.log("\nNext pipeline stages: persist -> AI extraction -> scoring -> assignment.\n");
