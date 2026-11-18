-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "popiaConsentAt" TIMESTAMP(3) NOT NULL,
    "specialDataConsent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxYear" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assessmentYear" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "classification" TEXT NOT NULL DEFAULT 'SALARIED_EMPLOYEE',
    "age" INTEGER NOT NULL DEFAULT 35,
    "isSaResident" BOOLEAN NOT NULL DEFAULT true,
    "maritalRegime" TEXT NOT NULL DEFAULT 'OUT_OF_COMMUNITY',
    "scopeFlags" TEXT NOT NULL DEFAULT '{}',
    "coveredMonths" TEXT NOT NULL DEFAULT '[]',
    "calculationSnapshot" TEXT,
    "paymentRef" TEXT,
    "amendmentCount" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVault" (
    "id" TEXT NOT NULL,
    "taxYearId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "docCategory" TEXT NOT NULL,
    "sha256Hash" TEXT NOT NULL,
    "extractedMeta" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "taxYearId" TEXT NOT NULL,
    "txFingerprint" TEXT NOT NULL,
    "txDate" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "txType" TEXT NOT NULL,
    "sarsCode" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "clarifiedByUser" BOOLEAN NOT NULL DEFAULT false,
    "linkedDocHash" TEXT,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metaHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "TaxYear_paymentRef_key" ON "TaxYear"("paymentRef");

-- CreateIndex
CREATE UNIQUE INDEX "TaxYear_userId_assessmentYear_key" ON "TaxYear"("userId", "assessmentYear");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_taxYearId_txFingerprint_key" ON "Transaction"("taxYearId", "txFingerprint");

-- AddForeignKey
ALTER TABLE "OtpToken" ADD CONSTRAINT "OtpToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxYear" ADD CONSTRAINT "TaxYear_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVault" ADD CONSTRAINT "DocumentVault_taxYearId_fkey" FOREIGN KEY ("taxYearId") REFERENCES "TaxYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_taxYearId_fkey" FOREIGN KEY ("taxYearId") REFERENCES "TaxYear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

