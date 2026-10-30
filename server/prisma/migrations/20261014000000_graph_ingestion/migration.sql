-- CreateTable
CREATE TABLE "GraphIngestion" (
    "documentId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "entityCount" INTEGER NOT NULL DEFAULT 0,
    "relationshipCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "pipeline" TEXT,
    "processedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphIngestion_pkey" PRIMARY KEY ("documentId")
);

-- CreateIndex
CREATE INDEX "GraphIngestion_companyId_status_idx" ON "GraphIngestion"("companyId", "status");

-- AddForeignKey
ALTER TABLE "GraphIngestion" ADD CONSTRAINT "GraphIngestion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
