-- Milestone 3: AI conversation intelligence.
--
-- AiExtraction never had any rows written to it before this migration (no
-- extraction pipeline existed yet), so switching loose String? columns to
-- required enums / NOT NULL is safe -- there is no existing data to
-- backfill or lose.

-- CreateEnum
CREATE TYPE "AiPaymentMethod" AS ENUM ('CASH', 'CREDIT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AiPurchaseIntent" AS ENUM ('HIGH', 'MEDIUM', 'LOW', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AiMainObjection" AS ENUM ('PRICE', 'CREDIT', 'AVAILABILITY', 'MODEL', 'TIMING', 'COMPARISON', 'OTHER', 'NONE', 'UNKNOWN');

-- AlterTable: link extraction to the source Conversation, add the
-- conversation-content hash used for AI-call caching/idempotency, add
-- post-extraction motorcycle catalog resolution fields, and tighten the
-- extraction-contract columns to match the required Zod schema exactly.
ALTER TABLE "AiExtraction"
  ADD COLUMN     "conversationId" TEXT NOT NULL,
  ADD COLUMN     "conversationHash" TEXT NOT NULL,
  ADD COLUMN     "extractionVersion" TEXT NOT NULL,
  ADD COLUMN     "motorcycleSku" TEXT,
  ADD COLUMN     "motorcycleMatchConfidence" DOUBLE PRECISION,
  ADD COLUMN     "motorcycleMatchMethod" TEXT,
  DROP COLUMN    "paymentMethod",
  ADD COLUMN     "paymentMethod" "AiPaymentMethod" NOT NULL,
  DROP COLUMN    "purchaseIntent",
  ADD COLUMN     "purchaseIntent" "AiPurchaseIntent" NOT NULL,
  DROP COLUMN    "mainObjection",
  ADD COLUMN     "mainObjection" "AiMainObjection" NOT NULL,
  ALTER COLUMN   "requestedAppointment" DROP DEFAULT,
  ALTER COLUMN   "requestedQuote" DROP DEFAULT,
  ALTER COLUMN   "confidence" SET NOT NULL,
  ALTER COLUMN   "evidence" SET NOT NULL,
  ALTER COLUMN   "provider" SET NOT NULL,
  ALTER COLUMN   "model" SET NOT NULL;

-- CreateIndex: cache/idempotency lookup key (see
-- src/pipeline/persist/ai-extractions.ts) -- given the same conversation
-- content, prompt version, model AND extraction contract version, reuse the
-- latest extraction instead of calling the provider again. extractionVersion
-- is part of the key so a contract change (AI_EXTRACTION_VERSION bump) never
-- silently reuses an extraction produced under the old contract.
CREATE INDEX "AiExtraction_conversationId_conversationHash_promptVersion__idx" ON "AiExtraction"("conversationId", "conversationHash", "promptVersion", "model", "extractionVersion");

-- AddForeignKey
ALTER TABLE "AiExtraction" ADD CONSTRAINT "AiExtraction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
