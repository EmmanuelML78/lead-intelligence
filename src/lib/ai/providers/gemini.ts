import { aiExtractionJsonSchema } from "../schema";
import { AiProviderError, type AiExtractionProvider, type AiExtractionProviderInput, type AiExtractionProviderOutput } from "../provider";

// gemini-2.5-flash (the original default) returns HTTP 404 "no longer
// available to new users" for newer API keys as of the Milestone 3.1 live
// validation -- confirmed against the real generateContent endpoint, not
// assumed. gemini-3.6-flash is what Google's own error response recommends
// as the replacement and is what was actually validated end to end.
const DEFAULT_MODEL = "gemini-3.6-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiProviderConfig = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Injectable for tests -- defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Direct REST call to Gemini's generateContent endpoint -- no SDK
 * dependency, since the request is a single small JSON POST and adding a
 * whole SDK for that would go against the "prefer simplicity" architecture
 * rule. Uses `responseMimeType: application/json` + `responseSchema` for
 * provider-native structured output (spec item 8); the caller still
 * re-validates every response with Zod regardless of what the provider
 * enforces.
 */
export class GeminiProvider implements AiExtractionProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: GeminiProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model?.trim() || DEFAULT_MODEL;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async extract(input: AiExtractionProviderInput): Promise<AiExtractionProviderOutput> {
    const url = `${this.baseUrl}/models/${this.model}:generateContent`;

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
        })
      });
    } catch (error) {
      // Network-level failure (DNS, connection reset, timeout) -- transient.
      throw new AiProviderError(`Gemini request failed: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: true,
        cause: error
      });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 401/403 (bad key) and 400 (bad request/schema) are permanent --
      // retrying them burns quota for nothing. 429/5xx are transient.
      const retryable = response.status === 429 || response.status >= 500;
      throw new AiProviderError(`Gemini request failed with status ${response.status}: ${body.slice(0, 500)}`, {
        retryable
      });
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new AiProviderError("Gemini response contained no candidate text", { retryable: false });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new AiProviderError(`Gemini response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: false
      });
    }

    return { raw };
  }
}
