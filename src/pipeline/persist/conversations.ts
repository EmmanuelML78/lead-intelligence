import type { PrismaClient } from "@prisma/client";
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
  messagesPersisted: number;
  error?: string;
};

/**
 * Conversation id (conversacion_id) and Lead id are already globally
 * unique natural keys from the source, so both upsert cleanly. Messages
 * have no source id, so we derive one deterministically (see
 * fingerprint.ts#messageId) from conversationId + position + content.
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
    await db.$transaction(async (tx) => {
      await tx.conversation.upsert({
        where: { id: conversation.id },
        update: {
          leadId: conversation.leadId,
          channel: conversation.channel,
          startedAt: conversation.startedAt,
          isOrphan
        },
        create: {
          id: conversation.id,
          sourceLeadId: conversation.sourceLeadId,
          leadId: conversation.leadId,
          channel: conversation.channel,
          startedAt: conversation.startedAt,
          isOrphan
        }
      });

      for (const message of conversation.messages) {
        const id = messageId({
          conversationId: conversation.id,
          index: message.index,
          sender: message.sender,
          sentTime: message.sentTime,
          text: message.text
        });

        await tx.message.upsert({
          where: { id },
          update: {
            index: message.index,
            sender: message.sender,
            sentTime: message.sentTime,
            text: message.text,
            conversationId: conversation.id
          },
          create: {
            id,
            conversationId: conversation.id,
            index: message.index,
            sender: message.sender,
            sentTime: message.sentTime,
            text: message.text
          }
        });
      }
    });

    return {
      result: { conversationId: conversation.id, isOrphan, messagesPersisted: conversation.messages.length },
      issues
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { conversationId: conversation.id, isOrphan, messagesPersisted: 0, error: message },
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
