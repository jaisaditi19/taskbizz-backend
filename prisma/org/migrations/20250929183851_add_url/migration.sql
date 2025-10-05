-- DropIndex
DROP INDEX "public"."License_nextReminderAt_idx";

-- DropIndex
DROP INDEX "public"."License_status_expiresOn_idx";

-- AlterTable
ALTER TABLE "public"."License" ALTER COLUMN "holder" DROP NOT NULL,
ALTER COLUMN "gracePeriodDays" DROP NOT NULL,
ALTER COLUMN "muted" DROP NOT NULL,
ALTER COLUMN "responsibleId" DROP NOT NULL,
ALTER COLUMN "status" DROP NOT NULL,
ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "createdById" DROP NOT NULL;
