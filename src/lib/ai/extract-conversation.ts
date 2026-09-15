import type { CatalogMotorcycle } from "../normalization/motorcycle";
import { matchMotorcycle } from "../normalization/motorcycle";
import { AI_PROMPT_VERSION, buildSystemPrompt, buildUserPrompt } from "./prompt";
import { AiProviderError, type AiExtractionProvider } from "./provider";
import { AI_EXTRACTION_VERSION, aiExtractionResultSchema, type AiExtractionResult } from "./schema";
import { buildCanonicalTranscript, conversationHash, type TranscriptMessage } from "./transcript";

export type ExtractConversationInput = {
  messages: TranscriptMessage[];
  catalog: CatalogMotorcycle[];
  provider: AiExtractionProvider;
  /** Small bounded retry budget shared across provider + validation failures (spec item 14). */
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
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
    }
  | {
      outcome: "provider_failed";
      message: string;
      attempts: number;
      conversationHash: string;
    }
  | {
      outcome: "validation_failed";
      message: string;
      attempts: number;
      conversationHash: string;
    };

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 300;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
 * Calls the provider, validates the response with Zod, and resolves the
 * motorcycle interest against the catalog. Retries a small bounded number
 * of times: retryable provider errors (network/429/5xx) and validation
 * failures both consume the same attempt budget; permanent provider errors
 * (auth/bad request) fail immediately without burning the budget.
 */
export async function extractConversation(input: ExtractConversationInput): Promise<ExtractConversationResult> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = input.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = input.sleep ?? defaultSleep;

  const transcript = buildCanonicalTranscript(input.messages);
  const hash = conversationHash(input.messages);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(transcript);

  let lastError: { kind: "provider_failed" | "validation_failed"; message: string } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let providerOutput;
    try {
      providerOutput = await input.provider.extract({ systemPrompt, userPrompt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof AiProviderError ? error.retryable : true;
      lastError = { kind: "provider_failed", message };
      if (!retryable || attempt === maxAttempts) {
        return { outcome: "provider_failed", message, attempts: attempt, conversationHash: hash };
      }
      await sleep(backoffMs * attempt);
      continue;
    }

    const parsed = aiExtractionResultSchema.safeParse(providerOutput.raw);
    if (!parsed.success) {
      const message = `Extraction failed Zod validation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
      lastError = { kind: "validation_failed", message };
      if (attempt === maxAttempts) {
        return { outcome: "validation_failed", message, attempts: attempt, conversationHash: hash };
      }
      await sleep(backoffMs * attempt);
      continue;
    }

    const resolved: ResolvedExtraction = {
      ...parsed.data,
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
      attempts: attempt
    };
  }

  // Unreachable given maxAttempts >= 1, but keeps the type checker honest.
  return {
    outcome: lastError?.kind ?? "provider_failed",
    message: lastError?.message ?? "Extraction failed for an unknown reason",
    attempts: maxAttempts,
    conversationHash: hash
  };
}
