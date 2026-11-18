export interface TaxTransactionInput {
  sarsCode: string;
  amount: number;
  txType: 'CREDIT' | 'DEBIT';
}

export interface TaxCalculationInput {
  assessmentYear: number;
  age: number;
  isSaResident: boolean;
  classification: string;
  scopeFlags: {
    ra?: boolean;
    medical?: boolean;
    medicalDependants?: number;
    homeOffice?: boolean;
    homeOfficePct?: number;
    travelLogbook?: boolean;
    businessKm?: number;
    donations18a?: boolean;
    sideBusiness?: boolean;
  };
  irp5Totals: {
    gross3601: number;
    paye4102: number;
    ra4006: number;
    med4005: number;
  };
  transactions: TaxTransactionInput[];
  optimizations?: {
    applyHomeOffice?: boolean;
    applyTravelDeemedRate?: boolean;
    applyOutOfPocketMed?: boolean;
    simulateMaxRaTopUp?: boolean;
  };
}

export interface TaxAssessmentResult {
  grossSalary3601: number;
  tradeIncome3616: number;
  localInterest4201: number;
  interestExemption: number;
  taxableInterest: number;
  raBase4006: number;
  raStatutoryCap: number;
  unusedRaHeadroom: number;
  effectiveRaDeduction: number;
  homeOfficeDeduction4028: number;
  travelDeduction4014: number;
  donationsDeduction4011: number;
  totalDeductionsAndExemptions: number;
  taxableIncome: number;
  grossNormalTax: number;
  ageRebates: number;
  medicalSchemeCredits6A: number;
  additionalMedicalCredits6B: number;
  totalTaxCredits: number;
  finalTaxLiability: number;
  payeWithheld4102: number;
  netRefundOrPayable: number;
  auditRiskScore: number;
  advisories: Array<{
    priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    area: string;
    finding: string;
    actionStep: string;
  }>;
  eFilingSteps: Array<{
    stepNumber: number;
    container: string;
    label: string;
    sarsCode: string;
    value: string;
    instruction: string;
  }>;
}

function sumByCode(transactions: TaxTransactionInput[], code: string): number {
  return transactions
    .filter((t) => t.sarsCode === code)
    .reduce((acc, t) => acc + Math.max(0, Number(t.amount) || 0), 0);
}

function computeProgressiveTax(taxableIncome: number): number {
  const ti = Math.max(0, taxableIncome);
  if (ti <= 237100) return ti * 0.18;
  if (ti <= 370500) return 42678 + (ti - 237100) * 0.26;
  if (ti <= 512800) return 77362 + (ti - 370500) * 0.31;
  if (ti <= 673000) return 121475 + (ti - 512800) * 0.36;
  if (ti <= 857900) return 179147 + (ti - 673000) * 0.39;
  if (ti <= 1817000) return 251258 + (ti - 857900) * 0.41;
  return 644489 + (ti - 1817000) * 0.45;
}

export function calculateSouthAfricanTax(input: TaxCalculationInput): TaxAssessmentResult {
  const { age, isSaResident, scopeFlags, irp5Totals, transactions, optimizations } = input;

  const grossSalary3601 = Math.max(irp5Totals.gross3601 || 0, sumByCode(transactions, '3601'));
  const tradeIncome3616 = sumByCode(transactions, '3616');
  const totalGrossIncome = grossSalary3601 + tradeIncome3616;

  const localInterest4201 = sumByCode(transactions, '4201');
  const interestCap = age >= 65 ? 34500 : 23800;
  const interestExemption = Math.min(localInterest4201, interestCap);
  const taxableInterest = Math.max(0, localInterest4201 - interestExemption);

  const raBase4006 = Math.max(irp5Totals.ra4006 || 0, sumByCode(transactions, '4006'));
  const raStatutoryCap = Math.min(totalGrossIncome * 0.275, 350000);
  const unusedRaHeadroom = Math.max(0, raStatutoryCap - raBase4006);
  const effectiveRaDeduction = Math.min(
    raBase4006 + (optimizations?.simulateMaxRaTopUp ? unusedRaHeadroom : 0),
    raStatutoryCap
  );

  const rawUtilities4028 = sumByCode(transactions, '4028');
  const homeOfficePct = Math.min(Math.max(scopeFlags.homeOfficePct || 0, 0), 50);
  const homeOfficeDeduction4028 =
    scopeFlags.homeOffice && (optimizations?.applyHomeOffice ?? true)
      ? Number((rawUtilities4028 * (homeOfficePct / 100)).toFixed(2))
      : 0;

  const businessKm = Math.max(0, scopeFlags.businessKm || 0);
  const travelDeduction4014 =
    scopeFlags.travelLogbook && (optimizations?.applyTravelDeemedRate ?? true)
      ? Number((businessKm * 4.84).toFixed(2))
      : 0;

  const rawDonations4011 = sumByCode(transactions, '4011');
  const preDonationTaxable = Math.max(
    0,
    totalGrossIncome + taxableInterest - (effectiveRaDeduction + homeOfficeDeduction4028 + travelDeduction4014)
  );
  const donationsDeduction4011 = scopeFlags.donations18a
    ? Math.min(rawDonations4011, preDonationTaxable * 0.1)
    : 0;

  const totalDeductionsAndExemptions = Number(
    (
      interestExemption +
      effectiveRaDeduction +
      homeOfficeDeduction4028 +
      travelDeduction4014 +
      donationsDeduction4011
    ).toFixed(2)
  );

  const taxableIncome = Math.max(
    0,
    Number((totalGrossIncome + localInterest4201 - totalDeductionsAndExemptions).toFixed(2))
  );

  const grossNormalTax = Number(computeProgressiveTax(taxableIncome).toFixed(2));
  let ageRebates = 0;
  if (isSaResident) {
    ageRebates += 17235;
    if (age >= 65) ageRebates += 9444;
    if (age >= 75) ageRebates += 3145;
  }

  const deps = Math.max(0, scopeFlags.medicalDependants || 0);
  let medicalSchemeCredits6A = 0;
  if (scopeFlags.medical) {
    const monthlyMtc = 364 + (deps >= 1 ? 364 : 0) + Math.max(0, deps - 1) * 246;
    medicalSchemeCredits6A = monthlyMtc * 12;
  }

  const rawOutOfPocket4020 = sumByCode(transactions, '4020');
  const medContributions4005 = Math.max(irp5Totals.med4005 || 0, sumByCode(transactions, '4005'));
  let additionalMedicalCredits6B = 0;
  if (scopeFlags.medical && (optimizations?.applyOutOfPocketMed ?? true) && rawOutOfPocket4020 > 0) {
    if (age >= 65) {
      const excessContrib = Math.max(0, medContributions4005 - 3 * medicalSchemeCredits6A);
      additionalMedicalCredits6B = Number(((excessContrib + rawOutOfPocket4020) * 0.333).toFixed(2));
    } else {
      const excessContrib = Math.max(0, medContributions4005 - 4 * medicalSchemeCredits6A);
      const pool = Math.max(0, excessContrib + rawOutOfPocket4020 - taxableIncome * 0.075);
      additionalMedicalCredits6B = Number((pool * 0.25).toFixed(2));
    }
  }

  const totalTaxCredits = Number((ageRebates + medicalSchemeCredits6A + additionalMedicalCredits6B).toFixed(2));
  const finalTaxLiability = Math.max(0, Number((grossNormalTax - totalTaxCredits).toFixed(2)));
  const payeWithheld4102 = Math.max(0, irp5Totals.paye4102 || 0);
  const netRefundOrPayable = Number((payeWithheld4102 - finalTaxLiability).toFixed(2));

  let auditRiskScore = 10;
  const advisories: TaxAssessmentResult['advisories'] = [];

  if (payeWithheld4102 === 0 && grossSalary3601 > 95750) {
    auditRiskScore += 15;
    advisories.push({
      priority: 'CRITICAL',
      area: 'Missing IRP5 PAYE Credit (Code 4102)',
      finding: 'Gross remuneration exceeds the tax threshold, but R0.00 in PAYE withholding was detected.',
      actionStep: 'Upload your official IRP5/IT3(a) certificate in Stage 2 to offset your assessed tax liability.',
    });
  }

  if (unusedRaHeadroom > 1500) {
    advisories.push({
      priority: 'HIGH',
      area: 'Section 11F Retirement Annuity Headroom',
      finding: `You have R ${unusedRaHeadroom.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} in unused tax-deductible RA capacity.`,
      actionStep: 'Top up your RA before 28 February and upload the updated IT3(f) certificate to reduce taxable income.',
    });
  }

  if (homeOfficeDeduction4028 > 0) {
    auditRiskScore += 18;
    advisories.push({
      priority: 'MEDIUM',
      area: 'Section 23(b) Home Office Audit Defense',
      finding: `Claiming R ${homeOfficeDeduction4028.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} in home office expenses frequently triggers SARS verification.`,
      actionStep: 'Retain your floor-plan diagram, utility/fibre invoices, and employer confirmation letter in your vault.',
    });
  }

  if (travelDeduction4014 > 0) {
    auditRiskScore += 20;
    advisories.push({
      priority: 'MEDIUM',
      area: 'Section 8(1) Travel Logbook Substantiation',
      finding: `Travel deduction of R ${travelDeduction4014.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} requires a SARS-compliant logbook.`,
      actionStep: 'Ensure opening/closing odometer readings and trip descriptions match the 1 March – 28 Feb period.',
    });
  }

  const eFilingSteps: TaxAssessmentResult['eFilingSteps'] = [
    {
      stepNumber: 1,
      container: 'Form Wizard',
      label: 'Foreign Tax Credits / Offshore Income',
      sarsCode: 'WIZ_FOREIGN',
      value: 'No',
      instruction: 'In the ITR12 Form Wizard, select "No" for Foreign Tax Credits unless offshore IT3(c) certificates were uploaded.',
    },
    {
      stepNumber: 2,
      container: 'Form Wizard',
      label: 'Local Business / Trade Income',
      sarsCode: 'WIZ_TRADE',
      value: tradeIncome3616 > 0 ? 'Yes' : 'No',
      instruction: `Select "${tradeIncome3616 > 0 ? 'Yes' : 'No'}" for Local Business, Trade, or Sole Proprietor Income.`,
    },
    {
      stepNumber: 3,
      container: 'Income (IRP5/IT3a)',
      label: 'Gross Remuneration',
      sarsCode: '3601',
      value: grossSalary3601.toFixed(2),
      instruction: `Verify or enter Gross Remuneration under SARS Source Code 3601: R ${grossSalary3601.toFixed(2)}.`,
    },
    {
      stepNumber: 4,
      container: 'Investment Income',
      label: 'Local Interest Received',
      sarsCode: '4201',
      value: localInterest4201.toFixed(2),
      instruction: `Enter total Local Interest under Source Code 4201: R ${localInterest4201.toFixed(2)} (SARS automatically applies the R${interestCap} exemption).`,
    },
    {
      stepNumber: 5,
      container: 'Retirement Contributions',
      label: 'Retirement Annuity Fund Contributions',
      sarsCode: '4006',
      value: effectiveRaDeduction.toFixed(2),
      instruction: `Enter Retirement Annuity contributions under Source Code 4006: R ${effectiveRaDeduction.toFixed(2)}.`,
    },
    {
      stepNumber: 6,
      container: 'Medical Deductions',
      label: 'Medical Scheme Contributions & Out-of-Pocket',
      sarsCode: '4005 / 4020',
      value: `${medContributions4005.toFixed(2)} | ${rawOutOfPocket4020.toFixed(2)}`,
      instruction: `Verify Medical Scheme Contributions (4005): R ${medContributions4005.toFixed(2)} and Out-of-Pocket Expenses (4020): R ${rawOutOfPocket4020.toFixed(2)}.`,
    },
    {
      stepNumber: 7,
      container: 'Other Deductions',
      label: 'Home Office / Trade Expenses',
      sarsCode: '4028',
      value: homeOfficeDeduction4028.toFixed(2),
      instruction: `Enter apportioned Home Office / Trade Expenditure under Source Code 4028: R ${homeOfficeDeduction4028.toFixed(2)}.`,
    },
  ];

  return {
    grossSalary3601,
    tradeIncome3616,
    localInterest4201,
    interestExemption,
    taxableInterest,
    raBase4006,
    raStatutoryCap,
    unusedRaHeadroom,
    effectiveRaDeduction,
    homeOfficeDeduction4028,
    travelDeduction4014,
    donationsDeduction4011,
    totalDeductionsAndExemptions,
    taxableIncome,
    grossNormalTax,
    ageRebates,
    medicalSchemeCredits6A,
    additionalMedicalCredits6B,
    totalTaxCredits,
    finalTaxLiability,
    payeWithheld4102,
    netRefundOrPayable,
    auditRiskScore,
    advisories,
    eFilingSteps,
  };
}
