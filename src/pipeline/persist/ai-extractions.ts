import type { Prisma, PrismaClient } from "@prisma/client";
import type { ResolvedExtraction } from "../../lib/ai/extract-conversation";

export type AiExtractionCacheKey = {
  conversationId: string;
  conversationHash: string;
  promptVersion: string;
  model: string;
  extractionVersion: string;
};

/**
 * Cache/idempotency lookup (spec item 6): if a successful extraction
 * already exists for this exact (conversationId, conversationHash,
 * promptVersion, model, extractionVersion) combination, reuse it instead of
 * calling the provider again. Any change to the transcript, prompt version,
 * model, or extraction contract version produces a different key and is
 * treated as a cache miss -- a bump to AI_EXTRACTION_VERSION (shape/semantics
 * of the contract changed) must never silently reuse an extraction produced
 * under the old contract, even if the transcript/model/prompt are unchanged.
 */
export async function findCachedExtraction(db: PrismaClient, key: AiExtractionCacheKey) {
  return db.aiExtraction.findFirst({
    where: {
      conversationId: key.conversationId,
      conversationHash: key.conversationHash,
      promptVersion: key.promptVersion,
      model: key.model,
      extractionVersion: key.extractionVersion
    },
    orderBy: { createdAt: "desc" }
  });
}

export type PersistAiExtractionInput = {
  leadId: string;
  conversationId: string;
  conversationHash: string;
  provider: string;
  model: string;
  promptVersion: string;
  extractionVersion: string;
  data: ResolvedExtraction;
};

/**
 * Always inserts a new row -- AiExtraction history is never overwritten
 * (spec item 5). A cache hit short-circuits before this is ever called; a
 * cache miss (changed transcript/prompt/model) always creates a fresh row
 * so the full audit trail is preserved.
 */
export async function persistAiExtraction(db: PrismaClient, input: PersistAiExtractionInput) {
  return db.aiExtraction.create({
    data: {
      leadId: input.leadId,
      conversationId: input.conversationId,
      conversationHash: input.conversationHash,
      motorcycleInterest: input.data.motorcycleInterest,
      motorcycleSku: input.data.motorcycleSku,
      motorcycleMatchConfidence: input.data.motorcycleMatchConfidence,
      motorcycleMatchMethod: input.data.motorcycleMatchMethod,
      budget: input.data.budget,
      downPayment: input.data.downPayment,
      paymentMethod: input.data.paymentMethod,
      purchaseIntent: input.data.purchaseIntent,
      mainObjection: input.data.mainObjection,
      requestedAppointment: input.data.requestedAppointment,
      requestedQuote: input.data.requestedQuote,
      confidence: input.data.confidence,
      evidence: input.data.evidence as unknown as Prisma.InputJsonValue,
      provider: input.provider,
      model: input.model,
      promptVersion: input.promptVersion,
      extractionVersion: input.extractionVersion
    }
  });
}
