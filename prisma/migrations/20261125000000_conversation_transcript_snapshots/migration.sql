-- Track the current transcript of a conversation and keep earlier
-- transcripts as history.
--
-- Until now persisting a conversation only added message rows. When the
-- source edited, removed or reordered a message, the old row stayed, so a
-- conversation could show two messages at the same position. Readers also
-- used the newest AiExtraction of a lead even when it had been made from a
-- transcript that no longer exists.
--
-- "Conversation"."transcriptHash" records which transcript the stored
-- messages are. "ConversationSnapshot" keeps every transcript ever seen, so
-- each AiExtraction (identified by its "conversationHash") can still be
-- traced to the text it was made from after the messages change.
--
-- This migration only adds objects and fills the new column. It does not
-- modify or delete any message or extraction.

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "transcriptHash" TEXT;

-- CreateTable
CREATE TABLE "ConversationSnapshot" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "transcriptHash" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "messages" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationSnapshot_conversationId_transcriptHash_key" ON "ConversationSnapshot"("conversationId", "transcriptHash");

-- AddForeignKey
ALTER TABLE "ConversationSnapshot" ADD CONSTRAINT "ConversationSnapshot_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: the transcript hash is computed by the application and cannot be
-- reproduced in SQL, so it is taken from the newest extraction of each
-- conversation, which is the one every reader used until now. Applying this
-- migration therefore changes nothing that is displayed or scored.
-- Conversations without an extraction stay NULL; they have nothing to select.
-- The next pipeline run sets the value from the real messages and writes the
-- first snapshot of every conversation.
UPDATE "Conversation" c
SET "transcriptHash" = latest."conversationHash"
FROM (
    SELECT DISTINCT ON ("conversationId") "conversationId", "conversationHash"
    FROM "AiExtraction"
    ORDER BY "conversationId", "createdAt" DESC, "id" DESC
) latest
WHERE latest."conversationId" = c."id";
