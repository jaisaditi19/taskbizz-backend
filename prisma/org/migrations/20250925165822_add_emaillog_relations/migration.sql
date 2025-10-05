/*
  Warnings:

  - You are about to drop the column `notifyClients` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the column `clientMailJobId` on the `TaskOccurrence` table. All the data in the column will be lost.
  - You are about to drop the column `clientMailSentAt` on the `TaskOccurrence` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "public"."EmailStatus" AS ENUM ('SENT', 'FAILED', 'PENDING');

-- DropForeignKey
ALTER TABLE "public"."TaskOccurrence" DROP CONSTRAINT "TaskOccurrence_clientId_fkey";

-- DropIndex
DROP INDEX "public"."TaskOccurrence_startDate_clientMailSentAt_clientId_idx";

-- AlterTable
ALTER TABLE "public"."Task" DROP COLUMN "notifyClients",
ADD COLUMN     "clientMailSendCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."TaskOccurrence" DROP COLUMN "clientMailJobId",
DROP COLUMN "clientMailSentAt",
ADD COLUMN     "startEmailSent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "startEmailSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "public"."EmailLog" (
    "id" TEXT NOT NULL,
    "occurrenceId" TEXT,
    "taskId" TEXT,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "status" "public"."EmailStatus" NOT NULL DEFAULT 'SENT',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailLog_occurrenceId_idx" ON "public"."EmailLog"("occurrenceId");

-- CreateIndex
CREATE INDEX "EmailLog_taskId_idx" ON "public"."EmailLog"("taskId");

-- CreateIndex
CREATE INDEX "EmailLog_recipient_idx" ON "public"."EmailLog"("recipient");

-- AddForeignKey
ALTER TABLE "public"."EmailLog" ADD CONSTRAINT "EmailLog_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "public"."TaskOccurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EmailLog" ADD CONSTRAINT "EmailLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "public"."Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
