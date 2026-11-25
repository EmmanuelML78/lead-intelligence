import type { TranscriptMessage } from "../lib/ai/transcript";
import type { RawConversation } from "./types";

/** Shared by ingestion and the read-only rehearsal forecast. */
export function normalizeSourceMessages(raw: Pick<RawConversation, "mensajes">): TranscriptMessage[] {
  return raw.mensajes.map((m, index) => ({
    index,
    sender: m.emisor?.trim() || "unknown",
    sentTime: m.hora?.trim() || null,
    text: m.texto ?? ""
  }));
}
