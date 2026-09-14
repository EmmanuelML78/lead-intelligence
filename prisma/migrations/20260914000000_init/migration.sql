-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "LeadChannel" AS ENUM ('WHATSAPP', 'META_ADS', 'WEB_FORM', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('SIN_GESTION', 'CONTACTADO', 'NO_CONTESTA', 'COTIZACION_ENVIADA', 'EN_PROCESO', 'DESCARTADO', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PipelineRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "PipelineIssueSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "Temperature" AS ENUM ('VERY_HOT', 'HOT', 'WARM', 'LOW');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesPoint" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "SalesPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Advisor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "salesPointId" TEXT NOT NULL,
    "dailyCapacity" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL,
    "joinedAt" TIMESTAMP(3),

    CONSTRAINT "Advisor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "normalizedName" TEXT,
    "normalizedPhone" TEXT,
    "normalizedEmail" TEXT,
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "salesPointId" TEXT NOT NULL,
    "customerId" TEXT,
    "registeredAt" TIMESTAMP(3),
    "registeredAtAmbiguous" BOOLEAN NOT NULL DEFAULT false,
    "channel" "LeadChannel" NOT NULL,
    "status" "LeadStatus" NOT NULL,
    "customerNameRaw" TEXT,
    "phoneRaw" TEXT,
    "emailRaw" TEXT,
    "cityRaw" TEXT,
    "motorcycleTextRaw" TEXT,
    "normalizedName" TEXT,
    "normalizedPhone" TEXT,
    "normalizedEmail" TEXT,
    "cityNormalized" TEXT,
    "motorcycleSku" TEXT,
    "motorcycleMatchConfidence" DOUBLE PRECISION,
    "motorcycleMatchMethod" TEXT,
    "firstContactAt" TIMESTAMP(3),
    "firstContactAtAmbiguous" BOOLEAN NOT NULL DEFAULT false,
    "campaign" TEXT,
    "sourceFingerprint" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "sourceLeadId" TEXT NOT NULL,
    "channel" TEXT,
    "startedAt" TIMESTAMP(3),
    "isOrphan" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "sender" TEXT NOT NULL,
    "sentTime" TEXT,
    "text" TEXT NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Motorcycle" (
    "sku" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "line" TEXT NOT NULL,
    "displacement" INTEGER NOT NULL,
    "segment" TEXT NOT NULL,
    "listPrice" INTEGER NOT NULL,

    CONSTRAINT "Motorcycle_pkey" PRIMARY KEY ("sku")
);

-- CreateTable
CREATE TABLE "MotorcycleInventory" (
    "id" TEXT NOT NULL,
    "motorcycleSku" TEXT NOT NULL,
    "salesPointId" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "unitsGlobal" INTEGER NOT NULL,

    CONSTRAINT "MotorcycleInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiExtraction" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "motorcycleInterest" TEXT,
    "budget" INTEGER,
    "downPayment" INTEGER,
    "paymentMethod" TEXT,
    "purchaseIntent" TEXT,
    "mainObjection" TEXT,
    "requestedAppointment" BOOLEAN NOT NULL DEFAULT false,
    "requestedQuote" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "evidence" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadScore" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "propensity" DOUBLE PRECISION NOT NULL,
    "intent" DOUBLE PRECISION NOT NULL,
    "urgency" DOUBLE PRECISION NOT NULL,
    "inventoryBonus" DOUBLE PRECISION NOT NULL,
    "totalScore" DOUBLE PRECISION NOT NULL,
    "temperature" "Temperature" NOT NULL,
    "explanation" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "advisorId" TEXT NOT NULL,
    "assignedFor" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL,
    "status" "PipelineRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "leadsReceived" INTEGER NOT NULL DEFAULT 0,
    "leadsPersisted" INTEGER NOT NULL DEFAULT 0,
    "customersPersisted" INTEGER NOT NULL DEFAULT 0,
    "conversationsPersisted" INTEGER NOT NULL DEFAULT 0,
    "messagesPersisted" INTEGER NOT NULL DEFAULT 0,
    "duplicateLeadIds" INTEGER NOT NULL DEFAULT 0,
    "duplicateCustomerGroups" INTEGER NOT NULL DEFAULT 0,
    "ambiguousDates" INTEGER NOT NULL DEFAULT 0,
    "missingCities" INTEGER NOT NULL DEFAULT 0,
    "unresolvedMotorcycles" INTEGER NOT NULL DEFAULT 0,
    "orphanConversations" INTEGER NOT NULL DEFAULT 0,
    "sourceRecordChanged" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "metadata" JSONB,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineIssue" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "PipelineIssueSeverity" NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "field" TEXT,
    "rawValue" TEXT,
    "message" TEXT NOT NULL,
    "pipelineRunId" TEXT NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenPipelineRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesPoint_companyId_idx" ON "SalesPoint"("companyId");

-- CreateIndex
CREATE INDEX "Advisor_companyId_salesPointId_active_idx" ON "Advisor"("companyId", "salesPointId", "active");

-- CreateIndex
CREATE INDEX "Customer_companyId_normalizedPhone_idx" ON "Customer"("companyId", "normalizedPhone");

-- CreateIndex
CREATE INDEX "Customer_companyId_normalizedEmail_idx" ON "Customer"("companyId", "normalizedEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_companyId_dedupeKey_key" ON "Customer"("companyId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Lead_companyId_salesPointId_status_idx" ON "Lead"("companyId", "salesPointId", "status");

-- CreateIndex
CREATE INDEX "Lead_registeredAt_idx" ON "Lead"("registeredAt");

-- CreateIndex
CREATE INDEX "Lead_customerId_idx" ON "Lead"("customerId");

-- CreateIndex
CREATE INDEX "Conversation_leadId_idx" ON "Conversation"("leadId");

-- CreateIndex
CREATE INDEX "Conversation_isOrphan_idx" ON "Conversation"("isOrphan");

-- CreateIndex
CREATE INDEX "Conversation_sourceLeadId_idx" ON "Conversation"("sourceLeadId");

-- CreateIndex
CREATE INDEX "Message_conversationId_index_idx" ON "Message"("conversationId", "index");

-- CreateIndex
CREATE INDEX "MotorcycleInventory_salesPointId_available_idx" ON "MotorcycleInventory"("salesPointId", "available");

-- CreateIndex
CREATE UNIQUE INDEX "MotorcycleInventory_motorcycleSku_salesPointId_key" ON "MotorcycleInventory"("motorcycleSku", "salesPointId");

-- CreateIndex
CREATE INDEX "AiExtraction_leadId_createdAt_idx" ON "AiExtraction"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadScore_leadId_createdAt_idx" ON "LeadScore"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadScore_totalScore_idx" ON "LeadScore"("totalScore");

-- CreateIndex
CREATE INDEX "Assignment_advisorId_assignedFor_idx" ON "Assignment"("advisorId", "assignedFor");

-- CreateIndex
CREATE UNIQUE INDEX "Assignment_leadId_assignedFor_key" ON "Assignment"("leadId", "assignedFor");

-- CreateIndex
CREATE INDEX "PipelineRun_status_startedAt_idx" ON "PipelineRun"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineIssue_fingerprint_key" ON "PipelineIssue"("fingerprint");

-- CreateIndex
CREATE INDEX "PipelineIssue_pipelineRunId_severity_idx" ON "PipelineIssue"("pipelineRunId", "severity");

-- CreateIndex
CREATE INDEX "PipelineIssue_type_idx" ON "PipelineIssue"("type");

-- AddForeignKey
ALTER TABLE "SalesPoint" ADD CONSTRAINT "SalesPoint_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advisor" ADD CONSTRAINT "Advisor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advisor" ADD CONSTRAINT "Advisor_salesPointId_fkey" FOREIGN KEY ("salesPointId") REFERENCES "SalesPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_salesPointId_fkey" FOREIGN KEY ("salesPointId") REFERENCES "SalesPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_motorcycleSku_fkey" FOREIGN KEY ("motorcycleSku") REFERENCES "Motorcycle"("sku") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MotorcycleInventory" ADD CONSTRAINT "MotorcycleInventory_motorcycleSku_fkey" FOREIGN KEY ("motorcycleSku") REFERENCES "Motorcycle"("sku") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MotorcycleInventory" ADD CONSTRAINT "MotorcycleInventory_salesPointId_fkey" FOREIGN KEY ("salesPointId") REFERENCES "SalesPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiExtraction" ADD CONSTRAINT "AiExtraction_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadScore" ADD CONSTRAINT "LeadScore_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_advisorId_fkey" FOREIGN KEY ("advisorId") REFERENCES "Advisor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineIssue" ADD CONSTRAINT "PipelineIssue_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

