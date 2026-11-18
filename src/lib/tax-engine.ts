export type TaxInput = {
  grossIncome: number;
  deductions?: number;
  age?: number;
  medicalAidMembers?: number;
  medicalAidAdditions?: number;
  retirementContributions?: number;
  localInterest?: number;
  foreignTaxCredit?: number;
  donations?: number;
  tradeIncome?: number;
  tradeExpenses?: number;
  vatSales?: number;
  vatPurchases?: number;
};

export type TaxResult = {
  taxableIncome: number;
  estimatedTax: number;
  vatAmount: number;
  grossIncome: number;
  totalDeductions: number;
  rebates: number;
  medicalCredits: number;
  netRefundOrPayable: number;
};

const brackets = [
  { limit: 237100, rate: 0.18, base: 0, lower: 0 },
  { limit: 370500, rate: 0.26, base: 42678, lower: 237100 },
  { limit: 512800, rate: 0.31, base: 77362, lower: 370500 },
  { limit: 673000, rate: 0.36, base: 121475, lower: 512800 },
  { limit: 857900, rate: 0.39, base: 179147, lower: 673000 },
  { limit: 1817000, rate: 0.41, base: 251258, lower: 857900 },
  { limit: Infinity, rate: 0.45, base: 644489, lower: 1817000 },
];

export function calculateSouthAfricanTax(input: TaxInput): TaxResult {
  const grossIncome = Math.max(0, Number(input.grossIncome) || 0);
  const tradeIncome = Math.max(0, Number(input.tradeIncome) || 0);
  const tradeExpenses = Math.max(0, Number(input.tradeExpenses) || 0);
  const section11f = Math.min(
    Math.max(0, Number(input.retirementContributions) || 0),
    350000,
    grossIncome * 0.275
  );
  const interestExemption = (Number(input.age) || 0) >= 65 ? 50000 : 23800;
  const interestExemptionDeduction = Math.max(
    0,
    Math.min(Math.max(0, Number(input.localInterest) || 0), interestExemption)
  );
  const donations = Math.min(
    Math.max(0, Number(input.donations) || 0),
    grossIncome * 0.10
  );
  const manualDeductions = Math.max(0, Number(input.deductions) || 0);
  const totalDeductions = manualDeductions + section11f + interestExemptionDeduction
    + donations + tradeExpenses;
  const taxableIncome = Math.max(0, grossIncome + tradeIncome - totalDeductions);

  let tax = 0;
  for (const bracket of brackets) {
    if (taxableIncome <= bracket.limit) {
      tax = bracket.base + (taxableIncome - bracket.lower) * bracket.rate;
      break;
    }
  }

  const age = Math.max(0, Number(input.age) || 0);
  const primaryRebate = 17235;
  const secondaryRebate = age >= 65 ? 9444 : 0;
  const tertiaryRebate = age >= 75 ? 3145 : 0;
  const rebates = primaryRebate + secondaryRebate + tertiaryRebate;

  const members = Math.max(0, Number(input.medicalAidMembers) || 0);
  const mainMemberCredit = members > 0 ? 364 : 0;
  const additionalCredit = Math.max(0, members - 1) * 364;
  const medicalCredits = (mainMemberCredit + additionalCredit) * 12;
  const outOfPocketCredits = calculateOutOfPocketCredits(
    taxableIncome,
    Math.max(0, Number(input.medicalAidAdditions) || 0),
    members,
    age
  );

  tax = Math.max(0, tax - rebates - medicalCredits - outOfPocketCredits
    - Math.max(0, Number(input.foreignTaxCredit) || 0));

  const vatSales = Math.max(0, Number(input.vatSales) || 0);
  const vatPurchases = Math.max(0, Number(input.vatPurchases) || 0);
  const vatAmount = vatSales * 0.15 - vatPurchases * 0.15;

  return {
    taxableIncome: roundMoney(taxableIncome),
    estimatedTax: roundMoney(tax),
    vatAmount: roundMoney(vatAmount),
    grossIncome: roundMoney(grossIncome + tradeIncome),
    totalDeductions: roundMoney(totalDeductions),
    rebates: roundMoney(rebates + medicalCredits + outOfPocketCredits),
    medicalCredits: roundMoney(medicalCredits + outOfPocketCredits),
    netRefundOrPayable: roundMoney(0 - tax),
  };
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function calculateOutOfPocketCredits(
  taxableIncome: number,
  qualifyingExpenses: number,
  members: number,
  age: number
): number {
  if (members === 0 || qualifyingExpenses <= 0) return 0;
  const threshold = taxableIncome * (age >= 65 ? 0.20 : 0.075);
  const excess = Math.max(0, qualifyingExpenses - threshold);
  return excess * 0.25;
}