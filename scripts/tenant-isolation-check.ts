/**
 * Company isolation check against a populated database.
 * EMP-01 must not retrieve EMP-02 lead detail (and so on).
 * Never prints secrets or raw PII beyond lead ids.
 *
 * Usage: bun run verify:isolation
 */
import { prisma } from "../src/lib/db/client";
import { getLeadDetail } from "../src/lib/dashboard/queries";

async function main() {
  const companies = await prisma.company.findMany({
    select: { id: true },
    orderBy: { id: "asc" }
  });
  if (companies.length < 2) {
    throw new Error("Need at least two companies to verify isolation.");
  }

  const samples: Array<{ companyId: string; leadId: string }> = [];
  for (const company of companies) {
    const lead = await prisma.lead.findFirst({
      where: { companyId: company.id },
      select: { id: true, companyId: true },
      orderBy: { id: "asc" }
    });
    if (lead) samples.push({ companyId: lead.companyId, leadId: lead.id });
  }

  let violations = 0;
  const checks: Array<{ viewer: string; leadId: string; owner: string; leaked: boolean }> = [];

  for (const viewer of samples) {
    for (const target of samples) {
      if (viewer.companyId === target.companyId) continue;
      const detail = await getLeadDetail(prisma, viewer.companyId, target.leadId);
      const leaked = detail !== null;
      if (leaked) violations += 1;
      checks.push({
        viewer: viewer.companyId,
        leadId: target.leadId,
        owner: target.companyId,
        leaked
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        companies: companies.map((row) => row.id),
        checks,
        crossCompanyViolations: violations
      },
      null,
      2
    )
  );

  if (violations !== 0) {
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
