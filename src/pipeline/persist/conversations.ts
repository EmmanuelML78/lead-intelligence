import type { Prisma, PrismaClient } from "@prisma/client";
import { conversationHash } from "../../lib/ai/transcript";
import { messageId } from "./fingerprint";
import type { PipelineIssueInput } from "./pipeline-issue";

export type NormalizedMessage = {
  index: number;
  sender: string;
  sentTime: string | null;
  text: string;
};

export type NormalizedConversation = {
  id: string;
  sourceLeadId: string;
  leadId: string | null; // null => orphan (source lead_id not found)
  channel: string | null;
  startedAt: Date | null;
  messages: NormalizedMessage[];
};

export type ConversationPersistResult = {
  conversationId: string;
  isOrphan: boolean;
  /** Messages stored for the conversation after this call: the size of the current transcript. */
  messagesPersisted: number;
  /** Rows inserted by this call. */
  messagesAdded: number;
  /** Rows removed by this call because the source no longer contains them. */
  messagesRemoved: number;
  /** True when the conversation was already stored and this call added or removed message rows. */
  transcriptChanged: boolean;
  transcriptHash: string | null;
  error?: string;
};

/**
 * Makes the stored messages of a conversation equal to the source transcript.
 *
 * Current snapshot: the `Message` rows of a conversation are exactly the
 * messages the source contains now, in the same order. Messages have no
 * source id, so each row's id is derived from the conversation, its position
 * and its content (fingerprint.ts#messageId): a message that is unchanged
 * keeps its row, and a message that was edited, moved or removed is a
 * different id. Rows whose id is not in the incoming transcript are deleted;
 * missing ones are inserted. Nothing is updated in place.
 *
 * History: the transcript's hash is recorded on the conversation, and every
 * distinct transcript is stored once in `ConversationSnapshot`. AI
 * extractions are never deleted; each one carries the hash of the transcript
 * it was made from, so it stays traceable after the messages change, and
 * readers can tell which extraction belongs to the current transcript.
 *
 * "Transcript" here means the canonical transcript (src/lib/ai/transcript.ts):
 * the exact text a model is given. Two sets of messages that differ only in
 * what that text does not carry (spaces around a message, the spelling of
 * the sender) are the same transcript: same hash, same snapshot entry, same
 * extraction, because a model would read the same thing. The `Message`
 * rows, in contrast, always mirror the source exactly.
 *
 * Everything happens in one transaction: a reader sees the old transcript or
 * the new one, never a mixture, and a failure leaves the old one untouched.
 * Persisting the same transcript again writes nothing.
 */
export async function persistConversation(db: PrismaClient, conversation: NormalizedConversation): Promise<{ result: ConversationPersistResult; issues: PipelineIssueInput[] }> {
  const isOrphan = conversation.leadId === null;
  const issues: PipelineIssueInput[] = [];

  if (isOrphan) {
    issues.push({
      type: "ORPHAN_CONVERSATION",
      severity: "WARNING",
      entityType: "Conversation",
      entityId: conversation.id,
      field: "lead_id",
      rawValue: conversation.sourceLeadId,
      message: `Conversation ${conversation.id} references lead_id ${conversation.sourceLeadId}, which does not exist among ingested leads.`
    });
  }

  try {
    const transcriptHash = conversationHash(conversation.messages);
    const rows = conversation.messages.map((message) => ({
      id: messageId({
        conversationId: conversation.id,
        index: message.index,
        sender: message.sender,
        sentTime: message.sentTime,
        text: message.text
      }),
      conversationId: conversation.id,
      index: message.index,
      sender: message.sender,
      sentTime: message.sentTime,
      text: message.text
    }));
    const duplicated = rows.length - new Set(rows.map((row) => row.id)).size;
    if (duplicated > 0) {
      throw new Error(`the transcript repeats a message position (${duplicated} duplicate id(s)); every message needs its own index`);
    }

    const outcome = await db.$transaction(async (tx) => {
      const previous = await tx.conversation.findUnique({
        where: { id: conversation.id },
        select: { transcriptHash: true }
      });

      await tx.conversation.upsert({
        where: { id: conversation.id },
        update: {
          leadId: conversation.leadId,
          channel: conversation.channel,
          startedAt: conversation.startedAt,
          isOrphan,
          transcriptHash
        },
        create: {
          id: conversation.id,
          sourceLeadId: conversation.sourceLeadId,
          leadId: conversation.leadId,
          channel: conversation.channel,
          startedAt: conversation.startedAt,
          isOrphan,
          transcriptHash
        }
      });

      // Compare ids instead of sending the whole transcript in a NOT IN
      // list: an unchanged conversation then costs one read and no write.
      // A row that already exists has, by construction of its id, exactly
      // the same content, so it is kept as it is.
      const stored = await tx.message.findMany({ where: { conversationId: conversation.id }, select: { id: true } });
      const storedIds = new Set(stored.map((row) => row.id));
      const wantedIds = new Set(rows.map((row) => row.id));
      const staleIds = stored.map((row) => row.id).filter((id) => !wantedIds.has(id));
      const missing = rows.filter((row) => !storedIds.has(row.id));

      const removed = staleIds.length > 0 ? await tx.message.deleteMany({ where: { id: { in: staleIds } } }) : { count: 0 };
      const added = missing.length > 0 ? await tx.message.createMany({ data: missing }) : { count: 0 };

      await tx.conversationSnapshot.upsert({
        where: { conversationId_transcriptHash: { conversationId: conversation.id, transcriptHash } },
        update: {},
        create: {
          conversationId: conversation.id,
          transcriptHash,
          messageCount: conversation.messages.length,
          messages: conversation.messages.map((message) => ({
            index: message.index,
            sender: message.sender,
            sentTime: message.sentTime,
            text: message.text
          })) as Prisma.InputJsonValue
        }
      });

      return {
        messagesAdded: added.count,
        messagesRemoved: removed.count,
        transcriptChanged: previous !== null && (added.count > 0 || removed.count > 0)
      };
    });

    return {
      result: {
        conversationId: conversation.id,
        isOrphan,
        messagesPersisted: conversation.messages.length,
        transcriptHash,
        ...outcome
      },
      issues
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: {
        conversationId: conversation.id,
        isOrphan,
        messagesPersisted: 0,
        messagesAdded: 0,
        messagesRemoved: 0,
        transcriptChanged: false,
        transcriptHash: null,
        error: message
      },
      issues: [
        ...issues,
        {
          type: "CONVERSATION_PERSIST_ERROR",
          severity: "ERROR",
          entityType: "Conversation",
          entityId: conversation.id,
          message: `Failed to persist conversation ${conversation.id}: ${message}`
        }
      ]
    };
  }
}
