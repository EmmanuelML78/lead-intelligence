-- Milestone 5 replaces the unused scoring stub with explicit 0..100
-- components and operational priority bands. Existing rows, if any, remain
-- readable and receive a unique legacy fingerprint.

-- AlterEnum
ALTER TYPE "Temperature" RENAME VALUE 'VERY_HOT' TO 'CRITICAL';
ALTER TYPE "Temperature" RENAME VALUE 'HOT' TO 'HIGH';
ALTER TYPE "Temperature" RENAME VALUE 'WARM' TO 'MEDIUM';
ALTER TYPE "Temperature" RENAME TO "PriorityBand";

-- RenameColumns
ALTER TABLE "LeadScore" RENAME COLUMN "propensity" TO "propensityComponent";
ALTER TABLE "LeadScore" RENAME COLUMN "intent" TO "intentComponent";
ALTER TABLE "LeadScore" RENAME COLUMN "urgency" TO "urgencyComponent";
ALTER TABLE "LeadScore" RENAME COLUMN "inventoryBonus" TO "inventoryComponent";
ALTER TABLE "LeadScore" RENAME COLUMN "temperature" TO "priorityBand";
ALTER TABLE "LeadScore" RENAME COLUMN "modelVersion" TO "scoreVersion";

-- AddInputFingerprint
ALTER TABLE "LeadScore" ADD COLUMN "inputFingerprint" TEXT;
UPDATE "LeadScore"
SET "inputFingerprint" = 'legacy:' || "id"
WHERE "inputFingerprint" IS NULL;
ALTER TABLE "LeadScore" ALTER COLUMN "inputFingerprint" SET NOT NULL;

-- IdempotencyIdentity
CREATE UNIQUE INDEX "LeadScore_leadId_scoreVersion_inputFingerprint_key"
ON "LeadScore"("leadId", "scoreVersion", "inputFingerprint");
