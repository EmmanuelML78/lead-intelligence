import type { CatalogMotorcycle } from "../normalization/motorcycle";
import { matchMotorcycle } from "../normalization/motorcycle";
import { verifyEvidence, type DroppedEvidence } from "./evidence";
import { AI_PROMPT_VERSION, buildSystemPrompt, buildUserPrompt } from "./prompt";
import { AiProviderError, type AiExtractionProvider } from "./provider";
import { AI_EXTRACTION_VERSION, aiExtractionResultSchema, type AiExtractionResult } from "./schema";
import { buildCanonicalTranscript, conversationHash, type TranscriptMessage } from "./transcript";

export type ExtractConversationInput = {
  messages: TranscriptMessage[];
  catalog: CatalogMotorcycle[];
  provider: AiExtractionProvider;
  /** Cancels the extraction: the request in flight and any wait between attempts. */
  signal?: AbortSignal;
  /** Upper bound on provider calls for this conversation, whatever the reason for retrying. */
  maxAttempts?: number;
  /** Upper bound on calls whose output failed validation. Never above maxAttempts. */
  maxValidationAttempts?: number;
  /** First wait between attempts; it doubles on each retry. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** A provider asking to wait longer than this is not waited for: the conversation fails now. */
  maxRetryAfterMs?: number;
  /** 0..1, for the jitter on the wait. Injectable for tests. */
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type ResolvedExtraction = AiExtractionResult & {
  motorcycleSku: string | null;
  motorcycleMatchConfidence: number | null;
  motorcycleMatchMethod: string | null;
};

export type ExtractConversationResult =
  | {
      outcome: "success";
      data: ResolvedExtraction;
      provider: string;
      model: string;
      promptVersion: string;
      extractionVersion: string;
      conversationHash: string;
      attempts: number;
      /** Evidence excerpts the model returned that are not in the transcript; they are not part of `data`. */
      evidenceDropped: DroppedEvidence[];
    }
  | {
      outcome: "provider_failed";
      message: string;
      attempts: number;
      conversationHash: string;
      /** True when the provider asked to back off (HTTP 429): the caller should stop sending work. */
      rateLimited: boolean;
    }
  | {
      outcome: "validation_failed";
      message: string;
      attempts: number;
      conversationHash: string;
    }
  | {
      /** The caller aborted. Nothing failed and nothing was decided about this conversation. */
      outcome: "cancelled";
      attempts: number;
      conversationHash: string;
    };

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_VALIDATION_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 8_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 20_000;

/** Resolves after `ms`, or rejects at once when the signal aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolves the AI-extracted free-text motorcycle interest against the
 * catalog using the SAME deterministic matcher used for the lead's raw
 * `modelo_interes_texto` (spec item 10). The LLM is never trusted to invent
 * a SKU; if the matcher can't confidently resolve it, it stays unresolved
 * (sku = null) rather than being force-matched.
 */
function resolveMotorcycle(motorcycleInterest: string | null, catalog: CatalogMotorcycle[]) {
  const match = matchMotorcycle(motorcycleInterest, catalog);
  return {
    motorcycleSku: match.sku,
    motorcycleMatchConfidence: match.sku ? match.confidence : null,
    motorcycleMatchMethod: match.sku ? match.method : null
  };
}

/**
 * Calls the provider, validates the response with Zod, checks the evidence
 * against the transcript and resolves the motorcycle interest against the
 * catalog.
 *
 * Retry policy. Every retry is another paid request, so each kind of failure
 * is retried only as far as a retry can plausibly help:
 *
 * - Transient provider failures (network, timeout, 408, 429, 5xx): retried
 *   up to `maxAttempts` calls in total, waiting with exponential backoff and
 *   jitter. When the provider says how long to wait, that is honored; when
 *   it asks for longer than `maxRetryAfterMs` the conversation fails now
 *   instead of holding a worker.
 * - Permanent provider failures (auth, bad request, unusable response): not
 *   retried.
 * - Output that fails validation: the request is deterministic
 *   (temperature 0), so the same answer is the likely result of asking
 *   again. One retry is allowed (`maxValidationAttempts` = 2), not the whole
 *   budget.
 * - Cancellation: stops immediately, including in the middle of a wait.
 */
export async function extractConversation(input: ExtractConversationInput): Promise<ExtractConversationResult> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const maxValidationAttempts = Math.max(1, Math.min(input.maxValidationAttempts ?? DEFAULT_MAX_VALIDATION_ATTEMPTS, maxAttempts));
  const backoffMs = input.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = input.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const maxRetryAfterMs = input.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const random = input.random ?? Math.random;
  const sleep = input.sleep ?? abortableSleep;
  const signal = input.signal;

  const transcript = buildCanonicalTranscript(input.messages);
  const hash = conversationHash(input.messages);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(transcript);

  /** Backoff for the wait after `attempt`: doubles each time, capped, with +/-20% jitter. */
  const backoffAfter = (attempt: number): number => {
    const base = Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 1));
    return Math.round(base * (0.8 + 0.4 * random()));
  };

  /** Waits before the next attempt. Returns false when cancelled during the wait. */
  const waitBeforeRetry = async (ms: number): Promise<boolean> => {
    try {
      await sleep(ms, signal);
      return !signal?.aborted;
    } catch {
      return false;
    }
  };

  let validationAttempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) return { outcome: "cancelled", attempts: attempt - 1, conversationHash: hash };

    let providerOutput;
    try {
      providerOutput = await input.provider.extract({ systemPrompt, userPrompt }, { signal });
    } catch (error) {
      const providerError = error instanceof AiProviderError ? error : null;
      if (providerError?.kind === "cancelled" || signal?.aborted) {
        return { outcome: "cancelled", attempts: attempt, conversationHash: hash };
      }
      const message = error instanceof Error ? error.message : String(error);
      const retryable = providerError ? providerError.retryable : true;
      const rateLimited = providerError?.status === 429;
      const retryAfterMs = providerError?.retryAfterMs ?? null;
      const failed = (detail = ""): ExtractConversationResult => ({
        outcome: "provider_failed",
        message: `${message}${detail}`,
        attempts: attempt,
        conversationHash: hash,
        rateLimited
      });

      if (!retryable || attempt === maxAttempts) return failed();
      if (retryAfterMs !== null && retryAfterMs > maxRetryAfterMs) {
        return failed(` (the provider asked to wait ${Math.ceil(retryAfterMs / 1000)} s, more than this run waits)`);
      }
      if (!(await waitBeforeRetry(Math.max(backoffAfter(attempt), retryAfterMs ?? 0)))) {
        return { outcome: "cancelled", attempts: attempt, conversationHash: hash };
      }
      continue;
    }

    const parsed = aiExtractionResultSchema.safeParse(providerOutput.raw);
    if (!parsed.success) {
      validationAttempts += 1;
      const message = `Extraction failed Zod validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
      if (validationAttempts >= maxValidationAttempts || attempt === maxAttempts) {
        return { outcome: "validation_failed", message, attempts: attempt, conversationHash: hash };
      }
      if (!(await waitBeforeRetry(backoffAfter(attempt)))) {
        return { outcome: "cancelled", attempts: attempt, conversationHash: hash };
      }
      continue;
    }

    const { evidence, dropped } = verifyEvidence(parsed.data.evidence, input.messages);
    const resolved: ResolvedExtraction = {
      ...parsed.data,
      evidence: { ...parsed.data.evidence, ...evidence },
      ...resolveMotorcycle(parsed.data.motorcycleInterest, input.catalog)
    };

    return {
      outcome: "success",
      data: resolved,
      provider: input.provider.name,
      model: input.provider.model,
      promptVersion: AI_PROMPT_VERSION,
      extractionVersion: AI_EXTRACTION_VERSION,
      conversationHash: hash,
      attempts: attempt,
      evidenceDropped: dropped
    };
  }

  // Unreachable: every path of the last attempt returns.
  return { outcome: "provider_failed", message: "Extraction failed for an unknown reason", attempts: maxAttempts, conversationHash: hash, rateLimited: false };
}
