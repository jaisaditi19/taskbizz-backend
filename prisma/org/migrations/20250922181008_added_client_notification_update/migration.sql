/*
  Warnings:

  - You are about to drop the column `clientMailSendCount` on the `Task` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."Task" DROP COLUMN "clientMailSendCount",
ADD COLUMN     "notifyClients" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "public"."TaskOccurrence" ADD COLUMN     "clientMailJobId" TEXT,
ADD COLUMN     "clientMailSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "TaskOccurrence_startDate_clientMailSentAt_clientId_idx" ON "public"."TaskOccurrence"("startDate", "clientMailSentAt", "clientId");

-- AddForeignKey
ALTER TABLE "public"."TaskOccurrence" ADD CONSTRAINT "TaskOccurrence_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
