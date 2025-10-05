-- CreateEnum
CREATE TYPE "public"."ReminderStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."ScheduledReminder" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "orgLocalDay" TIMESTAMP(3) NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "status" "public"."ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "meta" JSONB,

    CONSTRAINT "ScheduledReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledReminder_runAt_status_idx" ON "public"."ScheduledReminder"("runAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledReminder_licenseId_offsetDays_key" ON "public"."ScheduledReminder"("licenseId", "offsetDays");

-- AddForeignKey
ALTER TABLE "public"."ScheduledReminder" ADD CONSTRAINT "ScheduledReminder_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "public"."License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
