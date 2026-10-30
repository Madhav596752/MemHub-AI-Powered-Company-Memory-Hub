-- Phase 2: Document now stores Cloudinary info + extracted text.
-- Phase 1 had no document endpoints, so the Document table is expected to be empty.
-- If it somehow has rows, the NOT NULL columns below make this migration fail
-- (and roll back) instead of silently losing data.

-- AlterTable
ALTER TABLE "Document" DROP COLUMN "fileType",
DROP COLUMN "filename",
DROP COLUMN "status",
ADD COLUMN     "cloudinaryPublicId" TEXT NOT NULL,
ADD COLUMN     "cloudinaryUrl" TEXT NOT NULL,
ADD COLUMN     "extractedText" TEXT NOT NULL,
ADD COLUMN     "fileName" TEXT NOT NULL,
ADD COLUMN     "mimeType" TEXT NOT NULL,
ADD COLUMN     "originalName" TEXT NOT NULL,
ADD COLUMN     "uploadedBy" TEXT;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_uploadedBy_fkey" FOREIGN KEY ("uploadedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
