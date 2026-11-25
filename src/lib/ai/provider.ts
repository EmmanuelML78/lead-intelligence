/**
 * Small seam between business logic (src/lib/ai/extract-conversation.ts)
 * and whichever concrete AI SDK/API we call. Business logic never imports a
 * provider SDK directly -- only this interface. Swapping providers means
 * writing one new class here, nothing else changes.
 */
export type AiExtractionProviderInput = {
  systemPrompt: string;
  userPrompt: string;
};

export type AiExtractionProviderOptions = {
  /**
   * Cancels the request. A provider must stop waiting and reject with a
   * "cancelled" AiProviderError as soon as this signal aborts.
   */
  signal?: AbortSignal;
};

/** Raw provider output before Zod validation -- deliberately `unknown`, validation happens one layer up. */
export type AiExtractionProviderOutput = {
  raw: unknown;
};

export interface AiExtractionProvider {
  readonly name: string;
  /**
   * The exact model identifier this provider instance will call, known
   * upfront (before any request). Part of the cache/idempotency key, so it
   * must be resolvable without having made a call yet -- see
   * src/pipeline/ai-stage.ts.
   */
  readonly model: string;
  extract(input: AiExtractionProviderInput, options?: AiExtractionProviderOptions): Promise<AiExtractionProviderOutput>;
}

/**
 * Whether a failure means "stop sending requests".
 *
 * When the provider answered, its status decides: only 429 is a rate limit.
 * A 500 whose body happens to mention a quota is a server error, not a
 * reason to stop a whole batch. The text is consulted only when there is no
 * status to go by.
 */
export function isRateLimitFailure(status: number | null, message: string): boolean {
  if (status !== null) return status === 429;
  return /(?:\b429\b|RESOURCE_EXHAUSTED|quota|rate[\s_-]?limit)/i.test(message);
}

export type AiProviderErrorKind =
  /** The request never produced a response: DNS, connection reset, TLS. */
  | "network"
  /** No complete response within the provider's time limit. */
  | "timeout"
  /** The caller aborted the request; nothing is wrong with the provider. */
  | "cancelled"
  /** The provider answered with an error status. */
  | "http"
  /** The provider answered 2xx with a body that cannot be used. */
  | "invalid_response";

/**
 * Distinguishes retryable transport/rate-limit failures from permanent
 * ones (auth, bad request) so the caller can bound retries sensibly
 * (spec item 14: don't retry permanent errors indefinitely).
 */
export class AiProviderError extends Error {
  readonly retryable: boolean;
  readonly kind: AiProviderErrorKind;
  /** HTTP status, when the provider answered. */
  readonly status: number | null;
  /** How long the provider asked the caller to wait before trying again, when it said so. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      kind?: AiProviderErrorKind;
      status?: number;
      retryAfterMs?: number | null;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.name = "AiProviderError";
    this.retryable = options.retryable;
    this.kind = options.kind ?? "network";
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}
