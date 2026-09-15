/**
 * Bumped whenever the wording/instructions sent to the model change in a
 * way that could change its output, even if the extraction contract
 * (AI_EXTRACTION_VERSION) stays the same. Part of the cache/idempotency key
 * -- a prompt version change always forces a fresh extraction.
 */
export const AI_PROMPT_VERSION = "v1";

/**
 * System prompt. Kept short and explicit per Milestone 3 spec item 12:
 * facts only, customer priority over advisor proposals, no inference of
 * absent data, UNKNOWN/null when unsupported, evidence from transcript
 * only, and it must never compute a lead priority score itself.
 */
export function buildSystemPrompt(): string {
  return [
    "You extract structured commercial facts from a WhatsApp sales conversation between a motorcycle dealership advisor (ADVISOR) and a customer (CUSTOMER).",
    "",
    "Rules:",
    "1. Extract facts only. Never infer, guess, or complete information that is not explicitly present in the conversation.",
    "2. Prioritize what the CUSTOMER says. Advisor messages provide context (e.g. price quotes, offered appointments) but are never treated as customer intent, requests, or objections unless the customer confirms them.",
    "3. If the customer declines or contradicts something the advisor proposed (e.g. advisor offers an appointment, customer says no), the customer's statement wins.",
    "4. When a field is not clearly supported by the conversation, output null (for free-text/numeric fields) or UNKNOWN (for the enum fields). Do not fabricate a value to avoid a null/UNKNOWN.",
    "5. `evidence` must contain only short excerpts copied from the actual conversation text that support each non-null/non-UNKNOWN field. Never invent or paraphrase evidence that isn't in the transcript. Fields with no supporting text get an empty list.",
    "6. `confidence` reflects how well the conversation supports your extraction (0 = unreliable, 1 = very well supported). It is not a sales-probability estimate.",
    "7. Do NOT calculate or output any lead priority score, ranking, or recommendation -- that is out of scope for this task.",
    "8. Output must be a single JSON object matching exactly the provided schema. No prose, no markdown fences."
  ].join("\n");
}

export function buildUserPrompt(transcript: string): string {
  return [
    "Conversation transcript (chronological order, [HH:MM] role: message):",
    "",
    transcript,
    "",
    "Extract the structured commercial data described in the system instructions from this conversation."
  ].join("\n");
}
