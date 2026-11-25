/**
 * Milestone 3.1 -- LIVE AI PROVIDER VALIDATION.
 *
 * One-off verification script, NOT part of the pipeline entrypoint. It
 * ingests only the small hand-picked set of real, non-orphan conversations
 * listed in SELECTED_CONVERSATION_IDS (never all 677), then runs the real
 * AI extraction stage against the configured Gemini provider so the cache
 * (findCachedExtraction / persistAiExtraction) is exercised for real,
 * against a real Postgres database -- not a fake/in-memory double.
 *
 * Usage: bun run scripts/milestone-3-1-live-check.ts
 * Requires DATABASE_URL and AI_API_KEY in .env (see .env.example).
 *
 * Never logs AI_API_KEY or DATABASE_URL. Only prints conversationId/leadId
 * and structured extraction fields -- no raw transcript text, no customer
 * PII (name/phone/email).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/db/client";
import { reportLockError, withExclusiveLock } from "../src/lib/db/exclusive-lock";
import { createAiProviderFromEnv, runAiExtractionStage, type EligibleConversation } from "../src/pipeline/ai-stage";
import { readCsv, readJson } from "../src/pipeline/io";
import { buildLeadRecord } from "../src/pipeline/persist/build-lead-record";
import { persistConversation } from "../src/pipeline/persist/conversations";
import { findCachedExtraction } from "../src/pipeline/persist/ai-extractions";
import { persistLead } from "../src/pipeline/persist/leads";
import { persistReferenceData } from "../src/pipeline/persist/reference-data";
import type { RawAdvisor, RawConversation, RawLead, RawMotorcycle } from "../src/pipeline/types";
import { validateRawLead } from "../src/pipeline/validate";
import { AI_PROMPT_VERSION } from "../src/lib/ai/prompt";
import { AI_EXTRACTION_VERSION } from "../src/lib/ai/schema";
import { conversationHash } from "../src/lib/ai/transcript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data/raw");

/**
 * Hand-picked, representative, non-orphan conversations (see the Milestone
 * 3.1 report for the selection rationale per case). Cross-checked against
 * leads.csv up front -- every lead_id below resolves to a real Lead.
 */
const SELECTED_CONVERSATION_IDS = new Set([
  "CONV-00219", // strong intent (cash ready) + appointment request
  "CONV-00502", // credit + down payment question + appointment
  "CONV-00587", // weak intent ("solo mirando precios") + brand comparison
  "CONV-00060", // credit + down payment + objection/comparison combined
  "CONV-00018" // credit process question, no down payment mentioned
]);

async function readSources() {
  const leads = await readCsv<RawLead>(path.join(dataDir, "leads.csv"));
  const advisors = await readCsv<RawAdvisor>(path.join(dataDir, "asesores.csv"));
  const motorcycles = await readCsv<RawMotorcycle>(path.join(dataDir, "catalogo_motos.csv"));
  const conversations = await readJson<RawConversation[]>(path.join(dataDir, "conversaciones.json"));
  return { leads, advisors, motorcycles, conversations };
}

async function ingestSelectedOnly() {
  const { leads, motorcycles, conversations } = await readSources();

  const selectedConversations = conversations.filter((c) => SELECTED_CONVERSATION_IDS.has(c.conversacion_id));
  if (selectedConversations.length !== SELECTED_CONVERSATION_IDS.size) {
    throw new Error(
      `Expected ${SELECTED_CONVERSATION_IDS.size} conversations, found ${selectedConversations.length} in the source file.`
    );
  }

  const selectedLeadIds = new Set(selectedConversations.map((c) => c.lead_id));
  const selectedLeadRows = leads.filter((l) => selectedLeadIds.has(l.lead_id.trim()));

  const catalog = motorcycles.map((m) => ({ sku: m.sku.trim(), brand: m.marca.trim(), line: m.linea.trim() }));

  const validLeads: RawLead[] = [];
  for (const raw of selectedLeadRows) {
    const validation = validateRawLead(raw);
    if (validation.valid) validLeads.push(raw);
  }

  const built = validLeads.map((raw) => buildLeadRecord(raw, catalog));

  const companyIds = new Set<string>();
  const salesPoints = new Map<string, string>();
  for (const { record } of built) {
    companyIds.add(record.companyId);
    if (!salesPoints.has(record.salesPointId)) salesPoints.set(record.salesPointId, record.companyId);
  }
  // Reference data write is scoped to the companies/sales points touched by
  // the 5 selected leads. Advisors and MotorcycleInventory are intentionally
  // NOT persisted -- the full advisors/inventory files reference sales
  // points outside this 5-lead slice, which would violate FKs. Motorcycle
  // rows ARE needed (Lead.motorcycleSku has a real FK to Motorcycle.sku), so
  // the whole small catalog is upserted directly (no per-sales-point
  // inventory rows, which is the part that would require every sales point).
  await persistReferenceData(prisma, { companyIds, salesPoints, advisors: [], motorcycles: [] });
  for (const moto of motorcycles) {
    const sku = moto.sku.trim();
    if (!sku) continue;
    await prisma.motorcycle.upsert({
      where: { sku },
      update: {},
      create: {
        sku,
        brand: moto.marca.trim(),
        line: moto.linea.trim(),
        displacement: Number.parseInt(moto.cilindraje, 10) || 0,
        segment: moto.segmento.trim(),
        listPrice: Number.parseInt(moto.precio_lista, 10) || 0
      }
    });
  }

  const knownLeadIds = new Set<string>();
  for (const { record } of built) {
    const { result } = await persistLead(prisma, record);
    if (result.outcome !== "error") knownLeadIds.add(record.id);
  }

  const eligible: EligibleConversation[] = [];
  for (const raw of selectedConversations) {
    const leadId = knownLeadIds.has(raw.lead_id) ? raw.lead_id : null;
    const messages = raw.mensajes.map((m, index) => ({
      index,
      sender: m.emisor?.trim() || "unknown",
      sentTime: m.hora?.trim() || null,
      text: m.texto ?? ""
    }));
    const { result } = await persistConversation(prisma, {
      id: raw.conversacion_id,
      sourceLeadId: raw.lead_id,
      leadId,
      channel: raw.canal?.trim() || null,
      startedAt: null,
      messages
    });
    if (!result.error && leadId) {
      eligible.push({ conversationId: raw.conversacion_id, leadId, messages });
    }
  }

  return { eligible, catalog };
}

function printSampleSelection(eligible: EligibleConversation[]) {
  console.log("\n=== Section 3: selected live sample (no PII, no transcript text) ===");
  for (const c of eligible) {
    console.log(`- conversationId=${c.conversationId} leadId=${c.leadId} messageCount=${c.messages.length}`);
  }
}

function printExtractionSummary(label: string, report: Awaited<ReturnType<typeof runAiExtractionStage>>["report"]) {
  console.log(`\n=== ${label} ===`);
  console.log(`status=${report.status} provider=${report.provider} model=${report.model} promptVersion=${report.promptVersion}`);
  console.log(`conversationsEligible=${report.conversationsEligible} modelCalls=${report.modelCalls} cacheHits=${report.cacheHits}`);
  console.log(`successes=${report.successes} validationFailures=${report.validationFailures} providerFailures=${report.providerFailures}`);
}

async function printLiveResults(conversationIds: string[]) {
  console.log("\n=== Section 4/5: extraction outputs (structured fields only) ===");
  for (const id of conversationIds) {
    const row = await prisma.aiExtraction.findFirst({
      where: { conversationId: id },
      orderBy: { createdAt: "desc" }
    });
    if (!row) {
      console.log(`conversationId=${id}: NO ROW FOUND`);
      continue;
    }
    console.log(`\nconversationId=${id}`);
    console.log(
      JSON.stringify(
        {
          motorcycleInterest: row.motorcycleInterest,
          resolvedMotorcycleSku: row.motorcycleSku,
          budget: row.budget,
          downPayment: row.downPayment,
          paymentMethod: row.paymentMethod,
          purchaseIntent: row.purchaseIntent,
          mainObjection: row.mainObjection,
          requestedAppointment: row.requestedAppointment,
          requestedQuote: row.requestedQuote,
          confidence: row.confidence,
          evidence: row.evidence
        },
        null,
        2
      )
    );
  }
}

async function main() {
  const provider = createAiProviderFromEnv(process.env);
  if (!provider) {
    console.error("AI_API_KEY is not configured in .env -- cannot run live validation. Add it and re-run.");
    process.exitCode = 1;
    return;
  }

  const { eligible, catalog } = await ingestSelectedOnly();
  if (eligible.length !== SELECTED_CONVERSATION_IDS.size) {
    throw new Error(`Expected ${SELECTED_CONVERSATION_IDS.size} eligible conversations, got ${eligible.length}.`);
  }
  printSampleSelection(eligible);

  console.log("\nCalling Gemini for the first run (expect modelCalls=5, cacheHits=0)...");
  const first = await runAiExtractionStage(prisma, eligible, catalog, { env: process.env, provider });
  printExtractionSummary("Run 1 (fresh)", first.report);
  for (const issue of first.issues) console.log(`ISSUE [${issue.type}] ${issue.message}`);

  await printLiveResults([...eligible.map((e) => e.conversationId)]);

  console.log("\nRunning the exact same 5 conversations again (expect modelCalls=0, cacheHits=5)...");
  const second = await runAiExtractionStage(prisma, eligible, catalog, { env: process.env, provider });
  printExtractionSummary("Run 2 (should be all cache hits)", second.report);

  console.log("\n=== Section 7 (part 2): prompt-version invalidation, controlled/read-only check ===");
  console.log("Simulating a bumped AI_PROMPT_VERSION against the real rows just persisted (no provider call, no writes).");
  for (const c of eligible) {
    const staleOnPromptBump = await findCachedExtraction(prisma, {
      conversationId: c.conversationId,
      conversationHash: conversationHash(c.messages),
      promptVersion: `${AI_PROMPT_VERSION}-test-bump`,
      model: provider.model,
      extractionVersion: AI_EXTRACTION_VERSION
    });
    console.log(`conversationId=${c.conversationId} promptVersion bumped -> cache ${staleOnPromptBump ? "HIT (BUG)" : "MISS (expected)"}`);
  }

  console.log("\n=== Section 2/7: extractionVersion invalidation, controlled/read-only check ===");
  for (const c of eligible) {
    const staleOnVersionBump = await findCachedExtraction(prisma, {
      conversationId: c.conversationId,
      conversationHash: conversationHash(c.messages),
      promptVersion: AI_PROMPT_VERSION,
      model: provider.model,
      extractionVersion: `${AI_EXTRACTION_VERSION}-test-bump`
    });
    console.log(`conversationId=${c.conversationId} extractionVersion bumped -> cache ${staleOnVersionBump ? "HIT (BUG)" : "MISS (expected)"}`);
  }

  console.log("\nDone. No secrets were logged.");
}

// This check ingests leads and conversations and persists AI extractions,
// the same data the pipeline writes, so it takes the same exclusive lock.
withExclusiveLock({ operation: "ai-live-check" }, main)
  .catch((error) => {
    if (reportLockError(error)) return;
    console.error("Live check FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
