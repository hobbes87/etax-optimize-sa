import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generatePayGateChecksum } from '@/lib/paygate';

export async function POST(req: NextRequest) {
  try {
    const { taxYearId, isAmendment } = await req.json();
    const taxYear = await prisma.taxYear.findUnique({
      where: { id: taxYearId },
      include: { user: true },
    });

    if (!taxYear) return NextResponse.json({ error: 'Tax year not found.' }, { status: 404 });

    let amountCents = 29900;
    if (isAmendment) {
      amountCents = 14900;
    } else if (['PROVISIONAL_IRP6', 'SOLE_PROPRIETOR_SIDE_BUSINESS', 'SMALL_BUSINESS_CORP'].includes(taxYear.classification)) {
      amountCents = 49900;
    }

    const reference = `${taxYear.id}_${isAmendment ? 'AMD' : 'SUB'}_${Date.now()}`;
    await prisma.taxYear.update({
      where: { id: taxYear.id },
      data: { paymentRef: reference },
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const paygateId = process.env.PAYGATE_ID || '10011072130';
    const secret = process.env.PAYGATE_SECRET || 'secret';

    const payloadWithoutChecksum = {
      PAYGATE_ID: paygateId,
      REFERENCE: reference,
      AMOUNT: String(amountCents),
      CURRENCY: 'ZAR',
      RETURN_URL: `${appUrl}/?taxYearId=${taxYear.id}&payment=returned`,
      TRANSACTION_DATE: new Date().toISOString().replace('T', ' ').slice(0, 19),
      LOCALE: 'en-za',
      COUNTRY: 'ZAF',
      EMAIL: taxYear.user.email,
      NOTIFY_URL: `${appUrl}/api/paygate/notify`,
    };

    const CHECKSUM = generatePayGateChecksum(payloadWithoutChecksum, secret);

    return NextResponse.json({
      checkoutEndpoint: 'https://secure.paygate.co.za/payweb3/process.trans',
      fields: { ...payloadWithoutChecksum, CHECKSUM },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'PayGate initiation failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
