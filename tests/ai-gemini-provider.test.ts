import assert from "node:assert/strict";
import test from "node:test";
import { AiProviderError } from "../src/lib/ai/provider";
import { DEFAULT_GEMINI_TIMEOUT_MS, GeminiProvider } from "../src/lib/ai/providers/gemini";

// The provider is exercised with a simulated `fetch`. No request leaves the
// process and no API quota is used.
const API_KEY = "test-key-never-sent-anywhere";
const input = { systemPrompt: "system", userPrompt: "user" };
const VALID_TEXT = JSON.stringify({ purchaseIntent: "HIGH" });

type FetchCall = { url: string; init: RequestInit };

function geminiBody(text: string): string {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
}

/** A fetch that never answers, but rejects when its signal aborts, like the real one. */
function hangingFetch(calls: FetchCall[] = []): typeof fetch {
  return ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Promise<Response>((_, reject) => {
      const signal = init.signal as AbortSignal;
      const fail = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  }) as unknown as typeof fetch;
}

function respondingFetch(make: () => Response, calls: FetchCall[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return make();
  }) as unknown as typeof fetch;
}

async function rejected(work: Promise<unknown>): Promise<AiProviderError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof AiProviderError, `expected an AiProviderError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the request to fail");
}

/** Fails loudly instead of letting a hung promise stall the suite. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

test("a successful response is returned and the key travels only in its header", async () => {
  const calls: FetchCall[] = [];
  const provider = new GeminiProvider({
    apiKey: API_KEY,
    fetchImpl: respondingFetch(() => new Response(geminiBody(VALID_TEXT), { status: 200 }), calls)
  });
  assert.deepEqual(await provider.extract(input), { raw: { purchaseIntent: "HIGH" } });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.url.includes(API_KEY), "the key must not be in the URL");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"], API_KEY);
  assert.ok(calls[0]!.init.signal instanceof AbortSignal, "every request carries a cancellation signal");
  assert.equal(provider.timeoutMs, DEFAULT_GEMINI_TIMEOUT_MS);
});

test("a request that gets no answer is abandoned at the time limit and reported as a retryable timeout", async () => {
  const provider = new GeminiProvider({ apiKey: API_KEY, timeoutMs: 150, fetchImpl: hangingFetch() });
  const startedAt = Date.now();
  const error = await within(5_000, rejected(provider.extract(input)));
  const elapsed = Date.now() - startedAt;
  assert.equal(error.kind, "timeout");
  assert.equal(error.retryable, true);
  assert.match(error.message, /timed out after 150 ms/);
  assert.ok(elapsed >= 140 && elapsed < 2_000, `gave up after ${elapsed} ms`);
});

test("the time limit also covers a response whose body never finishes arriving", async () => {
  const stalledBody = (signal: AbortSignal) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"candidates":[{"content":{"parts":[{"text":"'));
        signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      }
    });
  const fetchImpl = (async (_url: string, init: RequestInit) =>
    new Response(stalledBody(init.signal as AbortSignal), { status: 200 })) as unknown as typeof fetch;
  const provider = new GeminiProvider({ apiKey: API_KEY, timeoutMs: 150, fetchImpl });
  const error = await within(5_000, rejected(provider.extract(input)));
  assert.equal(error.kind, "timeout");
  assert.equal(error.retryable, true);
});

test("the caller can cancel a request in flight; it is not reported as a failure to retry", async () => {
  const calls: FetchCall[] = [];
  const provider = new GeminiProvider({ apiKey: API_KEY, timeoutMs: 60_000, fetchImpl: hangingFetch(calls) });
  const controller = new AbortController();
  const pending = rejected(provider.extract(input, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 50);
  const error = await within(5_000, pending);
  assert.equal(error.kind, "cancelled");
  assert.equal(error.retryable, false);
  assert.equal((calls[0]!.init.signal as AbortSignal).aborted, true, "the underlying request was aborted");
});

test("a request cancelled before it starts is never sent", async () => {
  const calls: FetchCall[] = [];
  const provider = new GeminiProvider({ apiKey: API_KEY, fetchImpl: hangingFetch(calls) });
  const error = await rejected(provider.extract(input, { signal: AbortSignal.abort() }));
  assert.equal(error.kind, "cancelled");
  assert.equal(calls.length, 0);
});

test("a network failure is retryable and distinct from a timeout", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed: ECONNRESET");
  }) as unknown as typeof fetch;
  const error = await rejected(new GeminiProvider({ apiKey: API_KEY, fetchImpl }).extract(input));
  assert.equal(error.kind, "network");
  assert.equal(error.retryable, true);
});

test("HTTP statuses are classified: transient ones are retryable, client errors are permanent", async () => {
  const expectations: Array<[number, boolean]> = [
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [408, true],
    [429, true],
    [500, true],
    [503, true]
  ];
  for (const [status, retryable] of expectations) {
    const provider = new GeminiProvider({
      apiKey: API_KEY,
      fetchImpl: respondingFetch(() => new Response(`{"error":{"message":"status ${status}"}}`, { status }))
    });
    const error = await rejected(provider.extract(input));
    assert.equal(error.kind, "http");
    assert.equal(error.status, status);
    assert.equal(error.retryable, retryable, `status ${status}`);
    assert.ok(!error.message.includes(API_KEY), "an error message never contains the key");
  }
});

test("the wait requested by the provider is read from Retry-After or from the error body", async () => {
  const withHeader = new GeminiProvider({
    apiKey: API_KEY,
    fetchImpl: respondingFetch(() => new Response("{}", { status: 429, headers: { "Retry-After": "7" } }))
  });
  assert.equal((await rejected(withHeader.extract(input))).retryAfterMs, 7_000);

  const withBody = new GeminiProvider({
    apiKey: API_KEY,
    fetchImpl: respondingFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "RetryInfo", retryDelay: "23s" }] } }),
          { status: 429 }
        )
    )
  });
  assert.equal((await rejected(withBody.extract(input))).retryAfterMs, 23_000);

  const without = new GeminiProvider({ apiKey: API_KEY, fetchImpl: respondingFetch(() => new Response("{}", { status: 503 })) });
  assert.equal((await rejected(without.extract(input))).retryAfterMs, null);
});

test("an unusable 2xx response is a permanent failure, not something to retry", async () => {
  const bodies = [
    "this is not json",
    JSON.stringify({ candidates: [] }),
    JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }),
    geminiBody("{ not json")
  ];
  for (const body of bodies) {
    const provider = new GeminiProvider({ apiKey: API_KEY, fetchImpl: respondingFetch(() => new Response(body, { status: 200 })) });
    const error = await rejected(provider.extract(input));
    assert.equal(error.kind, "invalid_response", body);
    assert.equal(error.retryable, false);
  }
});

test("a finished request leaves no timer behind", async () => {
  const provider = new GeminiProvider({
    apiKey: API_KEY,
    timeoutMs: 60_000,
    fetchImpl: respondingFetch(() => new Response(geminiBody(VALID_TEXT), { status: 200 }))
  });
  const before = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  await provider.extract(input);
  await rejected(new GeminiProvider({ apiKey: API_KEY, timeoutMs: 60_000, fetchImpl: respondingFetch(() => new Response("{}", { status: 500 })) }).extract(input));
  const after = process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  assert.equal(after, before, "a pending 60 s timer would keep the process alive");
});
