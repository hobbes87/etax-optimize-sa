import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { calculateSouthAfricanTax } from '@/lib/tax-engine';

export async function POST(req: NextRequest) {
  try {
    const { taxYearId, irp5Totals, optimizations, forceUnlockSandbox } = await req.json();

    const taxYear = await prisma.taxYear.findUnique({
      where: { id: taxYearId },
      include: { transactions: true },
    });

    if (!taxYear) {
      return NextResponse.json({ error: 'Tax year record not found.' }, { status: 404 });
    }

    let parsedScopeFlags: Record<string, unknown> = {};
    try {
      parsedScopeFlags = JSON.parse(taxYear.scopeFlags || '{}');
    } catch {
      parsedScopeFlags = {};
    }

    const result = calculateSouthAfricanTax({
      assessmentYear: taxYear.assessmentYear,
      age: taxYear.age,
      isSaResident: taxYear.isSaResident,
      classification: taxYear.classification,
      scopeFlags: parsedScopeFlags,
      irp5Totals: irp5Totals || { gross3601: 0, paye4102: 0, ra4006: 0, med4005: 0 },
      transactions: taxYear.transactions.map((t) => ({
        sarsCode: t.sarsCode,
        amount: t.amount,
        txType: t.txType as 'CREDIT' | 'DEBIT',
      })),
      optimizations,
    });

    const nextStatus = forceUnlockSandbox
      ? 'PAID_UNLOCKED'
      : taxYear.status === 'DRAFT'
        ? 'CALCULATED_PREVIEW'
        : taxYear.status;

    const updated = await prisma.taxYear.update({
      where: { id: taxYearId },
      data: {
        status: nextStatus,
        calculationSnapshot: JSON.stringify(result),
      },
    });

    const isUnlocked = ['PAID_UNLOCKED', 'EFILING_IN_PROGRESS', 'ASSESSMENT_VERIFICATION', 'CLOSED_AND_LOCKED'].includes(
      updated.status
    );

    return NextResponse.json({
      status: updated.status,
      previewSummary: {
        totalGrossIncome: result.grossSalary3601 + result.tradeIncome3616 + result.localInterest4201,
        totalDeductionsAndExemptions: result.totalDeductionsAndExemptions,
        totalTaxCredits: result.totalTaxCredits,
        netRefundOrPayable: result.netRefundOrPayable,
        auditRiskScore: result.auditRiskScore,
        advisories: result.advisories,
      },
      unlockedDetails: isUnlocked ? result : null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Calculation failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
