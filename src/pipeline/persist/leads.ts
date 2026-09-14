import type { Prisma, PrismaClient } from "@prisma/client";
import { computeCustomerDedupeKey } from "./customer-identity";
import type { NormalizedLeadRecord } from "./build-lead-record";
import type { PipelineIssueInput } from "./pipeline-issue";

export type LeadPersistOutcome = "created" | "updated" | "unchanged" | "error";

export type LeadPersistResult = {
  leadId: string;
  outcome: LeadPersistOutcome;
  customerId: string | null;
  error?: string;
};

/**
 * Resolves the Customer (deterministic dedupeKey, scoped by companyId) and
 * upserts the Lead (natural key = raw lead_id) inside a single transaction,
 * so a lead never ends up pointing at a half-committed customer.
 *
 * Idempotency: if a Lead with this id already exists and its
 * sourceFingerprint is unchanged, we skip the write entirely ("already
 * ingested"). If it changed, we update the mutable fields and the caller
 * records a SOURCE_RECORD_CHANGED issue.
 */
export async function persistLead(db: PrismaClient, record: NormalizedLeadRecord): Promise<{ result: LeadPersistResult; issues: PipelineIssueInput[] }> {
  try {
    const outcome = await db.$transaction(async (tx) => {
      const dedupeKey = computeCustomerDedupeKey({
        normalizedPhone: record.normalizedPhone,
        normalizedEmail: record.normalizedEmail,
        leadId: record.id
      });

      const customer = await tx.customer.upsert({
        where: { companyId_dedupeKey: { companyId: record.companyId, dedupeKey } },
        update: {
          normalizedName: record.normalizedName,
          normalizedPhone: record.normalizedPhone,
          normalizedEmail: record.normalizedEmail,
          city: record.cityNormalized
        },
        create: {
          companyId: record.companyId,
          dedupeKey,
          normalizedName: record.normalizedName,
          normalizedPhone: record.normalizedPhone,
          normalizedEmail: record.normalizedEmail,
          city: record.cityNormalized
        }
      });

      const existing = await tx.lead.findUnique({ where: { id: record.id }, select: { sourceFingerprint: true } });

      const mutableData = {
        companyId: record.companyId,
        salesPointId: record.salesPointId,
        customerId: customer.id,
        registeredAt: record.registeredAt,
        registeredAtAmbiguous: record.registeredAtAmbiguous,
        channel: record.channel,
        status: record.status,
        customerNameRaw: record.customerNameRaw,
        phoneRaw: record.phoneRaw,
        emailRaw: record.emailRaw,
        cityRaw: record.cityRaw,
        motorcycleTextRaw: record.motorcycleTextRaw,
        normalizedName: record.normalizedName,
        normalizedPhone: record.normalizedPhone,
        normalizedEmail: record.normalizedEmail,
        cityNormalized: record.cityNormalized,
        motorcycleSku: record.motorcycleSku,
        motorcycleMatchConfidence: record.motorcycleMatchConfidence,
        motorcycleMatchMethod: record.motorcycleMatchMethod,
        firstContactAt: record.firstContactAt,
        firstContactAtAmbiguous: record.firstContactAtAmbiguous,
        campaign: record.campaign,
        sourceFingerprint: record.sourceFingerprint,
        rawPayload: record.rawPayload as unknown as Prisma.InputJsonValue
      };

      if (!existing) {
        await tx.lead.create({ data: { id: record.id, ...mutableData } });
        return { outcome: "created" as const, customerId: customer.id };
      }

      if (existing.sourceFingerprint === record.sourceFingerprint) {
        return { outcome: "unchanged" as const, customerId: customer.id };
      }

      await tx.lead.update({ where: { id: record.id }, data: mutableData });
      return { outcome: "updated" as const, customerId: customer.id };
    });

    const issues: PipelineIssueInput[] =
      outcome.outcome === "updated"
        ? [
            {
              type: "SOURCE_RECORD_CHANGED",
              severity: "WARNING",
              entityType: "Lead",
              entityId: record.id,
              field: "sourceFingerprint",
              rawValue: record.sourceFingerprint,
              message: `Lead ${record.id} source row changed since it was first ingested (fingerprint mismatch); mutable fields were updated.`
            }
          ]
        : [];

    return { result: { leadId: record.id, outcome: outcome.outcome, customerId: outcome.customerId }, issues };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      result: { leadId: record.id, outcome: "error", customerId: null, error: message },
      issues: [
        {
          type: "LEAD_PERSIST_ERROR",
          severity: "ERROR",
          entityType: "Lead",
          entityId: record.id,
          message: `Failed to persist lead ${record.id}: ${message}`
        }
      ]
    };
  }
}
