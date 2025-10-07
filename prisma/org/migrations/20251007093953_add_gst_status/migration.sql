-- CreateTable
CREATE TABLE "public"."GstReturnStatus" (
    "id" TEXT NOT NULL,
    "gstin" VARCHAR(15) NOT NULL,
    "period" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "filingDate" TIMESTAMP(3),
    "provider" TEXT NOT NULL,
    "raw" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GstReturnStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GstReturnStatus_gstin_period_idx" ON "public"."GstReturnStatus"("gstin", "period");

-- CreateIndex
CREATE UNIQUE INDEX "GstReturnStatus_gstin_period_form_key" ON "public"."GstReturnStatus"("gstin", "period", "form");
