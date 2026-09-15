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
  extract(input: AiExtractionProviderInput): Promise<AiExtractionProviderOutput>;
}

/**
 * Distinguishes retryable transport/rate-limit failures from permanent
 * ones (auth, bad request) so the caller can bound retries sensibly
 * (spec item 14: don't retry permanent errors indefinitely).
 */
export class AiProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "AiProviderError";
    this.retryable = options.retryable;
  }
}
