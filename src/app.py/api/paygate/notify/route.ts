import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyPayGateItnChecksum } from '@/lib/paygate';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const body: Record<string, string> = {};
    formData.forEach((v, k) => {
      body[k] = String(v);
    });

    const secret = process.env.PAYGATE_SECRET || 'secret';
    if (!verifyPayGateItnChecksum(body, secret)) {
      return new NextResponse('INVALID CHECKSUM', { status: 400 });
    }

    if (body.TRANSACTION_STATUS === '1' && body.REFERENCE) {
      const taxYear = await prisma.taxYear.findUnique({
        where: { paymentRef: body.REFERENCE },
      });

      if (taxYear && taxYear.status !== 'PAID_UNLOCKED') {
        const isAmendment = body.REFERENCE.includes('_AMD_');
        await prisma.taxYear.update({
          where: { id: taxYear.id },
          data: {
            status: 'PAID_UNLOCKED',
            amendmentCount: isAmendment ? { increment: 1 } : taxYear.amendmentCount,
          },
        });
      }
    }

    return new NextResponse('OK', { status: 200 });
  } catch {
    return new NextResponse('ERROR', { status: 500 });
  }
}
