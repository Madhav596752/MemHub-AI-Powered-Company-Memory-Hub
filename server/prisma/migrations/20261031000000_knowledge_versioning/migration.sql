-- Module 9.4: company-level knowledge-base versioning. Purely additive: nothing existing is changed or dropped.

-- AlterTable
ALTER TABLE "Company" ADD COLUMN "knowledgeVersion" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "KnowledgeChange" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeChange_companyId_expiresAt_idx" ON "KnowledgeChange"("companyId", "expiresAt");

-- AddForeignKey
ALTER TABLE "KnowledgeChange" ADD CONSTRAINT "KnowledgeChange_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
