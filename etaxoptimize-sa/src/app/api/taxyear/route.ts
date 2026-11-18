import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  try {
    const { userId, assessmentYear, classification, age, isSaResident, maritalRegime, scopeFlags } = await req.json();

    if (!userId || !assessmentYear) {
      return NextResponse.json({ error: 'userId and assessmentYear are required.' }, { status: 400 });
    }

    const taxYear = await prisma.taxYear.upsert({
      where: {
        userId_assessmentYear: {
          userId,
          assessmentYear: Number(assessmentYear),
        },
      },
      update: {
        classification: classification || 'SALARIED_EMPLOYEE',
        age: Number(age) || 35,
        isSaResident: isSaResident !== undefined ? Boolean(isSaResident) : true,
        maritalRegime: maritalRegime || 'OUT_OF_COMMUNITY',
        scopeFlags: JSON.stringify(scopeFlags || {}),
      },
      create: {
        userId,
        assessmentYear: Number(assessmentYear),
        classification: classification || 'SALARIED_EMPLOYEE',
        age: Number(age) || 35,
        isSaResident: isSaResident !== undefined ? Boolean(isSaResident) : true,
        maritalRegime: maritalRegime || 'OUT_OF_COMMUNITY',
        scopeFlags: JSON.stringify(scopeFlags || {}),
      },
      include: {
        documents: true,
        transactions: true,
      },
    });

    return NextResponse.json({ taxYear });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to initialize tax year';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

    const taxYears = await prisma.taxYear.findMany({
      where: { userId },
      include: { documents: true, transactions: true },
      orderBy: { assessmentYear: 'desc' },
    });

    return NextResponse.json({ taxYears });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to fetch tax years';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
