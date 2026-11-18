import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createPayGateInitiationChecksum } from "@/lib/paygate";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  let body: { taxYearId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON request body" }, { status: 400 });
  }

  const paygateId = process.env.PAYGATE_ID;
  const secret = process.env.PAYGATE_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "");
  const configuredFee = process.env.PAYGATE_FEE_CENTS;
  if (!paygateId || !secret || !appUrl || !configuredFee) {
    return NextResponse.json({ error: "PayGate credentials are not configured" }, { status: 503 });
  }
  try {
    const parsedUrl = new URL(appUrl);
    if (parsedUrl.protocol !== "https:" && process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "NEXT_PUBLIC_APP_URL must use HTTPS in production" }, { status: 503 });
    }
  } catch {
    return NextResponse.json({ error: "NEXT_PUBLIC_APP_URL is invalid" }, { status: 503 });
  }

  const amountCents = Number(configuredFee);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return NextResponse.json({ error: "PAYGATE_FEE_CENTS is invalid" }, { status: 503 });
  }

  if (typeof body.taxYearId !== "string" || body.taxYearId.length > 128) {
    return NextResponse.json({ error: "taxYearId is required" }, { status: 400 });
  }

  const taxYear = await prisma.taxYear.findUnique({
    where: { id: body.taxYearId },
    include: { user: { select: { email: true } } },
  });
  if (!taxYear) {
    return NextResponse.json({ error: "Tax year not found" }, { status: 404 });
  }
  if (taxYear.state !== "CALCULATED_PREVIEW" && taxYear.state !== "AMENDMENT_PENDING") {
    return NextResponse.json({ error: "Tax year is not eligible for checkout" }, { status: 409 });
  }

  const reference = crypto.randomUUID();
  const values = {
    PAYGATE_ID: paygateId,
    REFERENCE: reference,
    AMOUNT: String(amountCents),
    CURRENCY: "ZAR",
    RETURN_URL: `${appUrl}/payment/complete`,
    TRANSACTION_DATE: new Date().toISOString().replace(/\D/g, "").slice(0, 14),
    LOCALE: "en",
    COUNTRY: "ZAF",
    EMAIL: taxYear.user.email,
    NOTIFY_URL: `${appUrl}/api/paygate/notify`,
  };
  const CHECKSUM = createPayGateInitiationChecksum(values, secret);

  await prisma.payment.create({
    data: {
      taxYearId: taxYear.id,
      reference,
      amountCents,
      currency: "ZAR",
      status: "PENDING",
    },
  });

  return NextResponse.json(
    {
      endpoint: "https://secure.paygate.co.za/payweb3/process.trans",
      fields: { ...values, CHECKSUM },
    },
    { status: 201 }
  );
}