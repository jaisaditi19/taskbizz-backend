-- CreateEnum
CREATE TYPE "public"."LicenseStatus" AS ENUM ('ACTIVE', 'RENEWAL_DUE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."LicenseAssigneeRole" AS ENUM ('OWNER', 'WATCHER');

-- CreateTable
CREATE TABLE "public"."License" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "licenseNumber" VARCHAR(191),
    "type" TEXT,
    "holder" TEXT NOT NULL,
    "clientId" TEXT,
    "projectId" TEXT,
    "serviceId" TEXT,
    "vendorId" TEXT,
    "issuedOn" TIMESTAMP(3),
    "validFrom" TIMESTAMP(3),
    "expiresOn" TIMESTAMP(3) NOT NULL,
    "remindOffsets" INTEGER[],
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 15,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "responsibleId" TEXT NOT NULL,
    "status" "public"."LicenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextReminderAt" TIMESTAMP(3),
    "lastReminderAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LicenseAssignee" (
    "licenseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "public"."LicenseAssigneeRole" NOT NULL DEFAULT 'WATCHER',

    CONSTRAINT "LicenseAssignee_pkey" PRIMARY KEY ("licenseId","userId")
);

-- CreateTable
CREATE TABLE "public"."LicenseHistory" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "actorId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LicenseHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LicenseAttachment" (
    "id" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "spacesKey" TEXT NOT NULL,
    "cachedUrl" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LicenseAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "License_expiresOn_idx" ON "public"."License"("expiresOn");

-- CreateIndex
CREATE INDEX "License_nextReminderAt_idx" ON "public"."License"("nextReminderAt");

-- CreateIndex
CREATE INDEX "License_status_expiresOn_idx" ON "public"."License"("status", "expiresOn");

-- CreateIndex
CREATE INDEX "LicenseHistory_licenseId_at_idx" ON "public"."LicenseHistory"("licenseId", "at");

-- CreateIndex
CREATE INDEX "LicenseAttachment_licenseId_idx" ON "public"."LicenseAttachment"("licenseId");

-- AddForeignKey
ALTER TABLE "public"."LicenseAssignee" ADD CONSTRAINT "LicenseAssignee_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "public"."License"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LicenseHistory" ADD CONSTRAINT "LicenseHistory_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "public"."License"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LicenseAttachment" ADD CONSTRAINT "LicenseAttachment_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "public"."License"("id") ON DELETE CASCADE ON UPDATE CASCADE;
