/** Read-only history and reconciliation forecast. No provider or pipeline imports. */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { prisma } from "../../src/lib/db/client";
import { buildReleaseAudit } from "./release-audit-lib";
import { assertTarget, formatTarget, parseArgs, stringFlag, TargetError } from "./target";
import type { RawConversation } from "../../src/pipeline/types";

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const usage = "Usage: bun run ops:release-audit --expect-host <host> --report <file> [--source <conversaciones.json>]";
  if (flags.has("help")) { console.log(usage); return; }
  if (positional.length || [...flags.keys()].some((key) => !["expect-host", "report", "source"].includes(key))) throw new TargetError(usage);
  const target = assertTarget(process.env.DATABASE_URL, stringFlag(flags, "expect-host"));
  const reportFile = stringFlag(flags, "report");
  if (!reportFile) throw new TargetError(usage);
  console.log(`Target: ${formatTarget(target)}`);
  const bytes = await readFile(stringFlag(flags, "source") ?? new URL("../../data/raw/conversaciones.json", import.meta.url));
  const source = JSON.parse(bytes.toString("utf8")) as RawConversation[];
  const report = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    // to_jsonb supports both the old schema and the additive snapshot migration.
    const conversations = await tx.$queryRaw<Array<{ id: string; transcriptHash: string | null; hasTranscriptHash: boolean }>>`
      SELECT c.id, to_jsonb(c)->>'transcriptHash' AS "transcriptHash", to_jsonb(c) ? 'transcriptHash' AS "hasTranscriptHash" FROM "Conversation" c ORDER BY c.id
    `;
    const messages = await tx.message.findMany({ select: { id: true, conversationId: true, index: true, sender: true, sentTime: true, text: true } });
    const extractions = await tx.aiExtraction.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, leadId: true, conversationId: true, conversationHash: true, budget: true, downPayment: true }
    });
    const legacy = await tx.$queryRaw<Array<{ rows: bigint; md5: string }>>`
      SELECT count(*) AS rows, coalesce(md5(string_agg(md5((to_jsonb(c) - 'transcriptHash')::text), '' ORDER BY md5((to_jsonb(c) - 'transcriptHash')::text))), 'empty') AS md5 FROM "Conversation" c
    `;
    const groups = new Map<string, typeof messages>();
    for (const message of messages) {
      const group = groups.get(message.conversationId) ?? [];
      group.push(message);
      groups.set(message.conversationId, group);
    }
    return {
      sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      conversationLegacyFingerprint: { rows: Number(legacy[0]!.rows), md5: legacy[0]!.md5 },
      ...buildReleaseAudit(conversations.map((c) => ({ id: c.id, transcriptHash: c.hasTranscriptHash ? c.transcriptHash : undefined, messages: groups.get(c.id) ?? [] })), extractions, source)
    };
  }, { isolationLevel: "RepeatableRead", timeout: 60_000 });
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log("Audit complete (read-only). Incompatibilities are reported, not repaired; review the report before approval.");
}

main().catch((error) => {
  console.error(error instanceof TargetError ? error.message : "Release audit failed; stop and inspect the target/source in a secure operator session.");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
