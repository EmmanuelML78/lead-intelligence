import { aiExtractionJsonSchema } from "../schema";
import {
  AiProviderError,
  type AiExtractionProvider,
  type AiExtractionProviderInput,
  type AiExtractionProviderOptions,
  type AiExtractionProviderOutput
} from "../provider";

// gemini-2.5-flash (the original default) returns HTTP 404 "no longer
// available to new users" for newer API keys as of the Milestone 3.1 live
// validation -- confirmed against the real generateContent endpoint, not
// assumed. gemini-3.6-flash is what Google's own error response recommends
// as the replacement and is what was actually validated end to end.
const DEFAULT_MODEL = "gemini-3.6-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Time allowed for one request, from sending it to having read the whole response body. */
export const DEFAULT_GEMINI_TIMEOUT_MS = 30_000;

export type GeminiProviderConfig = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests -- defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/** `Retry-After` as seconds or an HTTP date, in milliseconds; null when absent or unusable. */
function retryAfterFromHeader(response: Response, now: number): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Gemini reports the wait in the error body as `details[].retryDelay: "23s"`. */
function retryAfterFromBody(body: string): number | null {
  const match = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Math.round(Number(match[1]) * 1000) : null;
}

/**
 * Direct REST call to Gemini's generateContent endpoint -- no SDK
 * dependency, since the request is a single small JSON POST and adding a
 * whole SDK for that would go against the "prefer simplicity" architecture
 * rule. Uses `responseMimeType: application/json` + `responseSchema` for
 * provider-native structured output (spec item 8); the caller still
 * re-validates every response with Zod regardless of what the provider
 * enforces.
 *
 * Every request is bounded: `fetch` has no time limit of its own, so a
 * provider that accepts the connection and never answers would otherwise
 * hold a worker forever. The limit covers the whole exchange, including
 * reading the body, and the caller's signal cancels it at any point.
 */
export class GeminiProvider implements AiExtractionProvider {
  readonly name = "gemini";
  readonly model: string;
  readonly timeoutMs: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GeminiProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_GEMINI_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async extract(
    input: AiExtractionProviderInput,
    options: AiExtractionProviderOptions = {}
  ): Promise<AiExtractionProviderOutput> {
    const url = `${this.baseUrl}/models/${this.model}:generateContent`;
    const caller = options.signal;
    if (caller?.aborted) {
      throw new AiProviderError("Gemini request cancelled before it was sent", { retryable: false, kind: "cancelled" });
    }

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const signal = caller ? AbortSignal.any([timeout.signal, caller]) : timeout.signal;

    /** Turns a failure of the exchange into the right error, whichever step it happened in. */
    const transportError = (error: unknown): AiProviderError => {
      if (caller?.aborted) {
        return new AiProviderError("Gemini request cancelled", { retryable: false, kind: "cancelled", cause: error });
      }
      if (timeout.signal.aborted) {
        return new AiProviderError(`Gemini request timed out after ${this.timeoutMs} ms`, {
          retryable: true,
          kind: "timeout",
          cause: error
        });
      }
      // Network-level failure (DNS, connection reset) -- transient.
      return new AiProviderError(`Gemini request failed: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: true,
        kind: "network",
        cause: error
      });
    };

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: input.systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: input.userPrompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: aiExtractionJsonSchema,
              temperature: 0
            }
          }),
          signal
        });
      } catch (error) {
        throw transportError(error);
      }

      if (!response.ok) {
        let body = "";
        try {
          body = await response.text();
        } catch (error) {
          if (signal.aborted) throw transportError(error);
        }
        // 401/403 (bad key) and 400 (bad request/schema) are permanent --
        // retrying them burns quota for nothing. 408/429/5xx are transient.
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new AiProviderError(`Gemini request failed with status ${response.status}: ${body.slice(0, 500)}`, {
          retryable,
          kind: "http",
          status: response.status,
          retryAfterMs: retryAfterFromHeader(response, Date.now()) ?? retryAfterFromBody(body)
        });
      }

      let payload: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      try {
        // The headers arrived, but the body can still stall or be cut off.
        payload = (await response.json()) as typeof payload;
      } catch (error) {
        if (signal.aborted) throw transportError(error);
        throw new AiProviderError(
          `Gemini response body could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: false, kind: "invalid_response", status: response.status }
        );
      }

      const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new AiProviderError("Gemini response contained no candidate text", {
          retryable: false,
          kind: "invalid_response",
          status: response.status
        });
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        throw new AiProviderError(`Gemini response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
          retryable: false,
          kind: "invalid_response",
          status: response.status
        });
      }

      return { raw };
    } finally {
      clearTimeout(timer);
    }
  }
}
