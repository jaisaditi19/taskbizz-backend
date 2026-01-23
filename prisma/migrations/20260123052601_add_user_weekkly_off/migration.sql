-- CreateEnum
CREATE TYPE "public"."WeekDay" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- CreateTable
CREATE TABLE "public"."WeeklyOff" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" "public"."WeekDay" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyOff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WeeklyOff_userId_idx" ON "public"."WeeklyOff"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyOff_userId_day_key" ON "public"."WeeklyOff"("userId", "day");

-- AddForeignKey
ALTER TABLE "public"."WeeklyOff" ADD CONSTRAINT "WeeklyOff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
