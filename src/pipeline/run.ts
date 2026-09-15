import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../lib/db/client";
import { parseMixedDate } from "../lib/normalization/date";
import { runAiExtractionStage, type AiStageReport, type EligibleConversation } from "./ai-stage";
import { deduplicateLeadRows } from "./dedupe-lead-rows";
import { readCsv, readJson } from "./io";
import { buildLeadRecord } from "./persist/build-lead-record";
import { persistConversation, type NormalizedConversation } from "./persist/conversations";
import { persistLead } from "./persist/leads";
import { persistIssues, type PipelineIssueInput } from "./persist/pipeline-issue";
import { createPipelineRun, emptyCounters, finalizePipelineRun, type PipelineRunCounters } from "./persist/pipeline-run";
import { persistReferenceData } from "./persist/reference-data";
import type { RawAdvisor, RawConversation, RawLead, RawMotorcycle } from "./types";
import { validateRawLead } from "./validate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const dataDir = path.join(root, "data/raw");

async function readSources() {
  const leads = await readCsv<RawLead>(path.join(dataDir, "leads.csv"));
  const advisors = await readCsv<RawAdvisor>(path.join(dataDir, "asesores.csv"));
  const motorcycles = await readCsv<RawMotorcycle>(path.join(dataDir, "catalogo_motos.csv"));
  const conversations = await readJson<RawConversation[]>(path.join(dataDir, "conversaciones.json"));
  return { leads, advisors, motorcycles, conversations };
}

async function main() {
  const { leads, advisors, motorcycles, conversations } = await readSources();
  const pipelineRun = await createPipelineRun(prisma);
  const counters: PipelineRunCounters = { ...emptyCounters };
  const issues: PipelineIssueInput[] = [];

  counters.leadsReceived = leads.length;

  try {
    // 1. validate -----------------------------------------------------------
    const validLeads: RawLead[] = [];
    for (const raw of leads) {
      const validation = validateRawLead(raw);
      if (!validation.valid) {
        issues.push({
          type: "INVALID_LEAD_ROW",
          severity: "ERROR",
          entityType: "Lead",
          entityId: raw.lead_id?.trim() || null,
          rawValue: JSON.stringify(raw),
          message: `Lead row failed validation and was skipped: ${validation.errors.join("; ")}`
        });
        continue;
      }
      validLeads.push(raw);
    }

    // 2. detect duplicate raw lead_id (keep first occurrence as canonical) --
    const { canonical: canonicalLeads, duplicates } = deduplicateLeadRows(validLeads);
    for (const dup of duplicates) {
      const id = dup.lead_id.trim();
      counters.duplicateLeadIds += 1;
      issues.push({
        type: "DUPLICATE_LEAD_ID",
        severity: "WARNING",
        entityType: "Lead",
        entityId: id,
        field: "lead_id",
        rawValue: JSON.stringify(dup),
        message: `lead_id ${id} appears more than once in the source file; only the first occurrence is persisted as the canonical Lead.`
      });
    }
    const knownLeadIds = new Set(canonicalLeads.map((row) => row.lead_id.trim()));

    // 3. normalize + build lead records -------------------------------------
    const catalog = motorcycles.map((m) => ({ sku: m.sku.trim(), brand: m.marca.trim(), line: m.linea.trim() }));
    const built = canonicalLeads.map((raw) => buildLeadRecord(raw, catalog));
    for (const { issues: leadIssues } of built) issues.push(...leadIssues);
    const ambiguousDateIssues = issues.filter((i) => i.type === "AMBIGUOUS_DATE");
    counters.ambiguousDateFields = ambiguousDateIssues.length;
    counters.leadsWithAmbiguousDates = new Set(ambiguousDateIssues.map((i) => i.entityId)).size;
    counters.missingCities = issues.filter((i) => i.type === "MISSING_CITY").length;
    counters.unresolvedMotorcycles = issues.filter((i) => i.type === "UNRESOLVED_MOTORCYCLE").length;
    counters.missingMotorcycleInterest = issues.filter((i) => i.type === "MISSING_MOTORCYCLE_INTEREST").length;

    // duplicate customer groups: informational counter only (not a
    // PipelineIssue type) -- same company + same normalized phone across
    // more than one distinct lead_id.
    const phoneGroups = new Map<string, Set<string>>();
    for (const { record } of built) {
      if (!record.normalizedPhone) continue;
      const key = `${record.companyId}|${record.normalizedPhone}`;
      const set = phoneGroups.get(key) ?? new Set<string>();
      set.add(record.id);
      phoneGroups.set(key, set);
    }
    counters.duplicateCustomerGroups = [...phoneGroups.values()].filter((s) => s.size > 1).length;

    // 4. persist reference data ---------------------------------------------
    const companyIds = new Set<string>();
    const salesPoints = new Map<string, string>();
    for (const advisor of advisors) {
      if (advisor.empresa_id?.trim()) companyIds.add(advisor.empresa_id.trim());
      if (advisor.punto_venta_id?.trim() && advisor.empresa_id?.trim()) {
        salesPoints.set(advisor.punto_venta_id.trim(), advisor.empresa_id.trim());
      }
    }
    for (const { record } of built) {
      companyIds.add(record.companyId);
      if (!salesPoints.has(record.salesPointId)) salesPoints.set(record.salesPointId, record.companyId);
    }

    await persistReferenceData(prisma, { companyIds, salesPoints, advisors, motorcycles });

    // 5. resolve customers + persist leads -----------------------------------
    const persistedCustomerIds = new Set<string>();
    for (const { record } of built) {
      const { result, issues: leadIssues } = await persistLead(prisma, record);
      issues.push(...leadIssues);
      if (result.outcome === "error") continue;
      // Leads that are already ingested (unchanged fingerprint) still count
      // as "persisted" -- they exist in the database, which is what the
      // counter communicates.
      counters.leadsPersisted += 1;
      if (result.customerId) persistedCustomerIds.add(result.customerId);
      if (result.outcome === "updated") counters.sourceRecordChanged += 1;
    }
    counters.customersPersisted = persistedCustomerIds.size;

    // 6. persist conversations + messages ------------------------------------
    // Conversations resolved to a real Lead (leadId !== null) are eligible
    // for AI extraction in stage 7 -- an orphan conversation has no Lead to
    // attach structured intelligence to.
    const eligibleConversations: EligibleConversation[] = [];
    for (const raw of conversations) {
      const leadId = knownLeadIds.has(raw.lead_id) ? raw.lead_id : null;
      const messages = raw.mensajes.map((m, index) => ({
        index,
        sender: m.emisor?.trim() || "unknown",
        sentTime: m.hora?.trim() || null,
        text: m.texto ?? ""
      }));
      const normalizedConversation: NormalizedConversation = {
        id: raw.conversacion_id,
        sourceLeadId: raw.lead_id,
        leadId,
        channel: raw.canal?.trim() || null,
        startedAt: parseMixedDate(raw.fecha_inicio).date,
        messages
      };

      const { result, issues: convIssues } = await persistConversation(prisma, normalizedConversation);
      issues.push(...convIssues);
      if (result.error) continue;
      counters.conversationsPersisted += 1;
      counters.messagesPersisted += result.messagesPersisted;
      if (result.isOrphan) counters.orphanConversations += 1;
      else if (leadId) eligibleConversations.push({ conversationId: raw.conversacion_id, leadId, messages });
    }

    // 7. AI conversation extraction -------------------------------------------
    // Never fails the pipeline: a missing AI_API_KEY (or per-conversation
    // provider/validation failures) is reported in the run's metadata, not
    // thrown (see docs/architecture.md "Milestone 3").
    const { report: aiStageReport, issues: aiIssues } = await runAiExtractionStage(prisma, eligibleConversations, catalog, {
      env: process.env
    });
    issues.push(...aiIssues);
    printAiStageSummary(aiStageReport);

    // 8. record issues (deduplicated by fingerprint) -------------------------
    counters.warnings = issues.filter((i) => i.severity === "WARNING").length;
    counters.errors = issues.filter((i) => i.severity === "ERROR").length;
    await persistIssues(prisma, pipelineRun.id, issues);

    // 9. finalize -------------------------------------------------------------
    await finalizePipelineRun(prisma, pipelineRun.id, "SUCCESS", counters, null, { aiExtraction: aiStageReport });

    printSummary(counters, pipelineRun.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persistIssues(prisma, pipelineRun.id, issues);
    await finalizePipelineRun(prisma, pipelineRun.id, "FAILED", counters, message);
    throw error;
  }
}

function printSummary(counters: PipelineRunCounters, pipelineRunId: string) {
  console.log("\nLead Intelligence — pipeline run", pipelineRunId, "\n");
  console.table(counters);
  console.log("\nDone.\n");
}

function printAiStageSummary(report: AiStageReport) {
  console.log("\nAI conversation extraction stage:", report.status);
  if (report.reason) console.log(report.reason);
  console.table({
    conversationsEligible: report.conversationsEligible,
    cacheHits: report.cacheHits,
    modelCalls: report.modelCalls,
    successes: report.successes,
    validationFailures: report.validationFailures,
    providerFailures: report.providerFailures,
    skippedNoApiKey: report.skippedNoApiKey
  });
}

main()
  .catch((error) => {
    console.error("\nPipeline run FAILED:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
