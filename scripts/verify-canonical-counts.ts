/**
 * Canonical source-count check for a populated assessment database.
 * Never prints connection strings. Exit 1 on mismatch.
 *
 * Usage: bun run verify:counts
 */
import { prisma } from "../src/lib/db/client";

const EXPECTED = {
  leadsReceived: 1503,
  canonicalLeads: 1501,
  customers: 1452,
  conversations: 677,
  messages: 4310,
  motorcycles: 24,
  advisors: 42,
  duplicateLeadIds: 2,
  orphanConversations: 12,
  missingMotorcycleInterest: 80,
  unresolvedMotorcycles: 134,
  ambiguousDateFields: 481,
  leadsWithAmbiguousDates: 414
} as const;

async function main() {
  const latest = await prisma.pipelineRun.findFirst({
    where: { status: "SUCCESS" },
    orderBy: { startedAt: "desc" }
  });
  if (!latest) {
    throw new Error("No SUCCESS PipelineRun found. Run bun run pipeline first.");
  }

  const observed = {
    leadsReceived: latest.leadsReceived,
    canonicalLeads: latest.leadsPersisted,
    customers: await prisma.customer.count(),
    conversations: await prisma.conversation.count(),
    messages: await prisma.message.count(),
    motorcycles: await prisma.motorcycle.count(),
    advisors: await prisma.advisor.count(),
    duplicateLeadIds: latest.duplicateLeadIds,
    orphanConversations: latest.orphanConversations,
    missingMotorcycleInterest: latest.missingMotorcycleInterest,
    unresolvedMotorcycles: latest.unresolvedMotorcycles,
    ambiguousDateFields: latest.ambiguousDateFields,
    leadsWithAmbiguousDates: latest.leadsWithAmbiguousDates
  };

  const mismatches = (Object.keys(EXPECTED) as Array<keyof typeof EXPECTED>).filter(
    (key) => observed[key] !== EXPECTED[key]
  );

  console.log(JSON.stringify({ expected: EXPECTED, observed, mismatches }, null, 2));
  if (mismatches.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
