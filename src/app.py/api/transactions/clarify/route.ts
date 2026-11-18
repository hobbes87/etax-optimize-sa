import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest) {
  try {
    const { transactionId, sarsCode } = await req.json();
    if (!transactionId || !sarsCode) {
      return NextResponse.json({ error: 'transactionId and sarsCode are required.' }, { status: 400 });
    }

    const updated = await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        sarsCode: String(sarsCode),
        confidence: 100,
        clarifiedByUser: true,
      },
    });

    return NextResponse.json({ transaction: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to update transaction';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
