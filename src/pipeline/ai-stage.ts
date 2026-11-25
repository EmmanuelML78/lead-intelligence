import type { PrismaClient } from "@prisma/client";
import type { CatalogMotorcycle } from "../lib/normalization/motorcycle";
import { mapWithConcurrency } from "../lib/ai/concurrency";
import { DEFAULT_MAX_ATTEMPTS, extractConversation } from "../lib/ai/extract-conversation";
import { AI_PROMPT_VERSION } from "../lib/ai/prompt";
import { isRateLimitFailure, type AiExtractionProvider } from "../lib/ai/provider";
import { GeminiProvider } from "../lib/ai/providers/gemini";
import { AI_EXTRACTION_VERSION } from "../lib/ai/schema";
import { conversationHash, type TranscriptMessage } from "../lib/ai/transcript";
import { findCachedExtraction, persistAiExtraction } from "./persist/ai-extractions";
import type { PipelineIssueInput } from "./persist/pipeline-issue";

const DEFAULT_CONCURRENCY = 4;

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
  // modelCalls counts extractions started, including ones cancelled in flight.
  /** Conversations whose extraction could not be read from or written to the database. */
  storeFailures: number;
  skippedNoApiKey: number;
  skippedDueToLimit: number;
  /** Not started, or cancelled while in flight, because a rate limit stopped the stage. */
  skippedDueToQuota: number;
  /** Not started, or cancelled while in flight, because the caller cancelled the stage. */
  skippedDueToCancellation: number;
  /** Conversations with no message text: there is nothing to extract, so the model is not called. */
  skippedEmptyTranscript: number;
  /** Evidence excerpts returned by the model that are not in the transcript, and so were not stored. */
  evidenceExcerptsDropped: number;
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
    storeFailures: 0,
    skippedNoApiKey: 0,
    skippedDueToLimit: 0,
    skippedDueToQuota: 0,
    skippedDueToCancellation: 0,
    skippedEmptyTranscript: 0,
    evidenceExcerptsDropped: 0,
    provider: null,
    model: null,
    promptVersion: AI_PROMPT_VERSION,
    ...overrides
  };
}

/** Text-only check, for failures that carry no HTTP status. See isRateLimitFailure in src/lib/ai/provider.ts. */
export function isQuotaOrRateLimitError(message: string): boolean {
  return isRateLimitFailure(null, message);
}

function parseNonNegativeInt(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function hasText(messages: readonly TranscriptMessage[]): boolean {
  return messages.some((message) => message.text.trim().length > 0);
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
  return new GeminiProvider({
    apiKey,
    model: env.AI_MODEL?.trim() || undefined,
    timeoutMs: parseNonNegativeInt(env.AI_TIMEOUT_MS) || undefined
  });
}

/**
 * AI extraction pipeline stage. Runs after conversations/messages are
 * persisted.
 *
 * It never throws and never fails the pipeline run (spec item 13: ingestion
 * must succeed even when AI extraction cannot run). Each conversation is
 * handled on its own: a missing API key, a provider failure, invalid output
 * or a database error while reading or storing one extraction is counted and
 * reported for that conversation, and the others carry on. Leads left
 * without an extraction are scored with the documented neutral fallback.
 *
 * When the provider signals a rate limit or exhausted quota, the stage
 * stops: no further calls are started and the ones in flight are cancelled,
 * instead of paying for requests that will be refused.
 */
export async function runAiExtractionStage(
  db: PrismaClient,
  eligible: EligibleConversation[],
  catalog: CatalogMotorcycle[],
  options: {
    env: AiProviderEnv;
    provider?: AiExtractionProvider;
    /** Cancels the whole stage from outside. */
    signal?: AbortSignal;
    /** Overrides for the retry policy; see extractConversation. Used by tests to avoid real waits. */
    retry?: { backoffMs?: number; maxBackoffMs?: number; maxRetryAfterMs?: number; random?: () => number };
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
  let storeFailures = 0;
  let skippedDueToQuota = 0;
  let skippedDueToCancellation = 0;
  let skippedEmptyTranscript = 0;
  let evidenceExcerptsDropped = 0;

  // Aborted when the stage decides to stop, or when the caller cancels it.
  const stop = new AbortController();
  let stoppedByQuota = false;
  const onExternalAbort = () => stop.abort();
  if (options.signal?.aborted) stop.abort();
  else options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  /** Counts a conversation left unprocessed because the stage stopped, under the reason it stopped. */
  const skipped = () => {
    if (stoppedByQuota) skippedDueToQuota += 1;
    else skippedDueToCancellation += 1;
  };

  const storeFailed = (conversationId: string, action: string, error: unknown) => {
    storeFailures += 1;
    issues.push({
      type: "AI_EXTRACTION_STORE_FAILED",
      severity: "WARNING",
      entityType: "Conversation",
      entityId: conversationId,
      message: `AI extraction for conversation ${conversationId} could not be ${action}: ${error instanceof Error ? error.message : String(error)}`
    });
  };

  await mapWithConcurrency(queued, concurrency, async (conversation) => {
    // Nothing a single conversation does may reject this worker: that would
    // end the whole stage and, with it, the pipeline run.
    try {
      if (stop.signal.aborted) {
        skipped();
        return;
      }
      if (!hasText(conversation.messages)) {
        skippedEmptyTranscript += 1;
        return;
      }

      const hash = conversationHash(conversation.messages);
      let cached;
      try {
        cached = await findCachedExtraction(db, {
          conversationId: conversation.conversationId,
          conversationHash: hash,
          promptVersion: AI_PROMPT_VERSION,
          model: provider.model,
          extractionVersion: AI_EXTRACTION_VERSION
        });
      } catch (error) {
        // Without the lookup we cannot know whether a paid call is needed.
        storeFailed(conversation.conversationId, "looked up, so the model was not called", error);
        return;
      }

      if (cached) {
        cacheHits += 1;
        return;
      }

      modelCalls += 1;
      const result = await extractConversation({
        messages: conversation.messages,
        catalog,
        provider,
        signal: stop.signal,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        ...options.retry
      });

      if (result.outcome === "cancelled") {
        skipped();
        return;
      }

      if (result.outcome === "provider_failed") {
        providerFailures += 1;
        issues.push({
          type: "AI_EXTRACTION_PROVIDER_FAILED",
          severity: "WARNING",
          entityType: "Conversation",
          entityId: conversation.conversationId,
          message: `AI extraction for conversation ${conversation.conversationId} failed after ${result.attempts} attempt(s): ${result.message}`
        });
        if (result.rateLimited) {
          stoppedByQuota = true;
          stop.abort();
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

      try {
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
      } catch (error) {
        storeFailed(conversation.conversationId, "stored", error);
        return;
      }
      successes += 1;

      if (result.evidenceDropped.length > 0) {
        evidenceExcerptsDropped += result.evidenceDropped.length;
        const fields = [...new Set(result.evidenceDropped.map((entry) => entry.field))].join(", ");
        issues.push({
          type: "AI_EVIDENCE_NOT_IN_TRANSCRIPT",
          severity: "WARNING",
          entityType: "Conversation",
          entityId: conversation.conversationId,
          message: `AI extraction for conversation ${conversation.conversationId} returned ${result.evidenceDropped.length} evidence excerpt(s) that do not appear in the transcript (fields: ${fields}). They were not stored; the extracted values were kept.`
        });
      }
    } catch (error) {
      storeFailed(conversation.conversationId, "processed", error);
    }
  });

  options.signal?.removeEventListener("abort", onExternalAbort);
  const cancelledByCaller = Boolean(options.signal?.aborted);
  const stopped = stop.signal.aborted;
  const reasonParts: string[] = [];
  if (skippedDueToLimit > 0) {
    reasonParts.push(`AI_MAX_CONVERSATIONS=${maxConversations}; ${skippedDueToLimit} eligible conversation(s) deferred.`);
  }
  if (stoppedByQuota) {
    reasonParts.push("Stopped after quota/rate-limit errors so remaining conversations are not billed in a retry loop.");
  }
  if (cancelledByCaller) {
    reasonParts.push("Cancelled before every conversation was processed.");
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
      storeFailures,
      skippedDueToLimit,
      skippedDueToQuota,
      skippedDueToCancellation,
      skippedEmptyTranscript,
      evidenceExcerptsDropped,
      provider: provider.name,
      model: provider.model
    }),
    issues
  };
}
