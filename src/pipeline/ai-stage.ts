import type { PrismaClient } from "@prisma/client";
import type { CatalogMotorcycle } from "../lib/normalization/motorcycle";
import { mapWithConcurrency } from "../lib/ai/concurrency";
import { extractConversation } from "../lib/ai/extract-conversation";
import { AI_PROMPT_VERSION } from "../lib/ai/prompt";
import type { AiExtractionProvider } from "../lib/ai/provider";
import { GeminiProvider } from "../lib/ai/providers/gemini";
import { AI_EXTRACTION_VERSION } from "../lib/ai/schema";
import { conversationHash, type TranscriptMessage } from "../lib/ai/transcript";
import { findCachedExtraction, persistAiExtraction } from "./persist/ai-extractions";
import type { PipelineIssueInput } from "./persist/pipeline-issue";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 3;

export type EligibleConversation = {
  conversationId: string;
  leadId: string;
  messages: TranscriptMessage[];
};

export type AiStageReport = {
  status: "SKIPPED" | "COMPLETED" | "STOPPED";
  reason: string | null;
  conversationsEligible: number;
  cacheHits: number;
  modelCalls: number;
  successes: number;
  validationFailures: number;
  providerFailures: number;
  skippedNoApiKey: number;
  skippedDueToLimit: number;
  skippedDueToQuota: number;
  provider: string | null;
  model: string | null;
  promptVersion: string;
};

function emptyReport(overrides: Partial<AiStageReport>): AiStageReport {
  return {
    status: "SKIPPED",
    reason: null,
    conversationsEligible: 0,
    cacheHits: 0,
    modelCalls: 0,
    successes: 0,
    validationFailures: 0,
    providerFailures: 0,
    skippedNoApiKey: 0,
    skippedDueToLimit: 0,
    skippedDueToQuota: 0,
    provider: null,
    model: null,
    promptVersion: AI_PROMPT_VERSION,
    ...overrides
  };
}

export function isQuotaOrRateLimitError(message: string): boolean {
  return /(?:\b429\b|RESOURCE_EXHAUSTED|quota|rate[\s_-]?limit)/i.test(message);
}

function parseNonNegativeInt(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export type AiProviderEnv = NodeJS.Dict<string | undefined>;

/**
 * Only Gemini is implemented (spec item 7: "implement one real provider",
 * "use the provider already implied by the current .env.example"). The
 * business logic (extractConversation) only depends on the
 * AiExtractionProvider interface, so adding a second provider later is a
 * new class here, not a change to the pipeline stage.
 *
 * Returns null when no API key is configured -- the caller treats that as
 * "AI stage SKIPPED", never as a pipeline failure (spec item 13).
 */
export function createAiProviderFromEnv(env: AiProviderEnv): AiExtractionProvider | null {
  const apiKey = env.AI_API_KEY?.trim();
  if (!apiKey) return null;
  return new GeminiProvider({ apiKey, model: env.AI_MODEL?.trim() || undefined });
}

/**
 * AI extraction pipeline stage. Runs after conversations/messages are
 * persisted. Never throws to fail the overall pipeline run: a missing API
 * key or a per-conversation provider/validation failure is reported, not
 * raised (spec item 13 -- ingestion must be able to succeed even when AI
 * extraction cannot run).
 */
export async function runAiExtractionStage(
  db: PrismaClient,
  eligible: EligibleConversation[],
  catalog: CatalogMotorcycle[],
  options: {
    env: AiProviderEnv;
    provider?: AiExtractionProvider;
  }
): Promise<{ report: AiStageReport; issues: PipelineIssueInput[] }> {
  const provider = options.provider ?? createAiProviderFromEnv(options.env);

  if (!provider) {
    return {
      report: emptyReport({
        status: "SKIPPED",
        reason: "AI_API_KEY is not configured -- AI extraction stage skipped, ingestion is unaffected.",
        conversationsEligible: eligible.length,
        skippedNoApiKey: eligible.length
      }),
      issues: []
    };
  }

  const concurrency = parseNonNegativeInt(options.env.AI_CONCURRENCY) || DEFAULT_CONCURRENCY;
  const maxConversations = parseNonNegativeInt(options.env.AI_MAX_CONVERSATIONS);
  const queued =
    maxConversations === null || maxConversations >= eligible.length
      ? eligible
      : eligible.slice(0, maxConversations);
  const skippedDueToLimit = eligible.length - queued.length;
  const issues: PipelineIssueInput[] = [];
  let cacheHits = 0;
  let modelCalls = 0;
  let successes = 0;
  let validationFailures = 0;
  let providerFailures = 0;
  let skippedDueToQuota = 0;
  let stopFurtherCalls = false;

  await mapWithConcurrency(queued, concurrency, async (conversation) => {
    if (stopFurtherCalls) {
      skippedDueToQuota += 1;
      return;
    }

    const hash = conversationHash(conversation.messages);
    const cached = await findCachedExtraction(db, {
      conversationId: conversation.conversationId,
      conversationHash: hash,
      promptVersion: AI_PROMPT_VERSION,
      model: provider.model,
      extractionVersion: AI_EXTRACTION_VERSION
    });

    if (cached) {
      cacheHits += 1;
      return;
    }

    modelCalls += 1;
    const result = await extractConversation({
      messages: conversation.messages,
      catalog,
      provider,
      maxAttempts: DEFAULT_MAX_ATTEMPTS
    });

    if (result.outcome === "provider_failed") {
      providerFailures += 1;
      issues.push({
        type: "AI_EXTRACTION_PROVIDER_FAILED",
        severity: "WARNING",
        entityType: "Conversation",
        entityId: conversation.conversationId,
        message: `AI extraction for conversation ${conversation.conversationId} failed after ${result.attempts} attempt(s): ${result.message}`
      });
      if (isQuotaOrRateLimitError(result.message)) {
        stopFurtherCalls = true;
      }
      return;
    }

    if (result.outcome === "validation_failed") {
      validationFailures += 1;
      issues.push({
        type: "AI_EXTRACTION_VALIDATION_FAILED",
        severity: "WARNING",
        entityType: "Conversation",
        entityId: conversation.conversationId,
        message: `AI extraction for conversation ${conversation.conversationId} produced output that failed schema validation after ${result.attempts} attempt(s): ${result.message}`
      });
      return;
    }

    await persistAiExtraction(db, {
      leadId: conversation.leadId,
      conversationId: conversation.conversationId,
      conversationHash: result.conversationHash,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
      extractionVersion: result.extractionVersion,
      data: result.data
    });
    successes += 1;
  });

  const stopped = stopFurtherCalls;
  const reasonParts: string[] = [];
  if (skippedDueToLimit > 0) {
    reasonParts.push(`AI_MAX_CONVERSATIONS=${maxConversations}; ${skippedDueToLimit} eligible conversation(s) deferred.`);
  }
  if (stopped) {
    reasonParts.push("Stopped after quota/rate-limit errors so remaining conversations are not billed in a retry loop.");
  }

  return {
    report: emptyReport({
      status: stopped ? "STOPPED" : "COMPLETED",
      reason: reasonParts.join(" ") || null,
      conversationsEligible: eligible.length,
      cacheHits,
      modelCalls,
      successes,
      validationFailures,
      providerFailures,
      skippedDueToLimit,
      skippedDueToQuota,
      provider: provider.name,
      model: provider.model
    }),
    issues
  };
}
