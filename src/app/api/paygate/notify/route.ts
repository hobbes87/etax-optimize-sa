import { NextRequest, NextResponse } from "next/server";
import {
  PayGateItnFields,
  verifyPayGateItnChecksum,
} from "@/lib/paygate";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ITN_FIELDS: (keyof PayGateItnFields)[] = [
  "PAYGATE_ID",
  "PAY_REQUEST_ID",
  "REFERENCE",
  "TRANSACTION_STATUS",
  "RESULT_CODE",
  "AUTH_CODE",
  "CURRENCY",
  "AMOUNT",
  "RESULT_DESC",
  "TRANSACTION_ID",
  "RISK_INDICATOR",
  "PAY_METHOD",
  "PAY_METHOD_DETAIL",
];

const ACKNOWLEDGMENT = () => new NextResponse("OK", {
  status: 200,
  headers: { "Content-Type": "text/plain; charset=utf-8" },
});

export async function POST(request: NextRequest) {
  const paygateId = process.env.PAYGATE_ID;
  const secret = process.env.PAYGATE_SECRET;
  if (!paygateId || !secret) {
    return new NextResponse("PayGate configuration is missing", { status: 503 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new NextResponse("Expected form-encoded ITN", { status: 400 });
  }

  const fields = {} as PayGateItnFields;
  for (const name of ITN_FIELDS) {
    const values = form.getAll(name);
    if (values.length !== 1 || typeof values[0] !== "string") {
      return new NextResponse(`Invalid ${name} field`, { status: 400 });
    }
    fields[name] = values[0];
  }
  const checksums = form.getAll("CHECKSUM");
  if (checksums.length !== 1 || typeof checksums[0] !== "string") {
    return new NextResponse("Invalid CHECKSUM field", { status: 400 });
  }

  if (
    fields.PAYGATE_ID !== paygateId ||
    !verifyPayGateItnChecksum(fields, checksums[0], secret)
  ) {
    return new NextResponse("Invalid ITN checksum or merchant", { status: 400 });
  }
  if (!/^\d+$/.test(fields.AMOUNT) || !fields.REFERENCE) {
    return new NextResponse("Invalid payment reference or amount", { status: 400 });
  }

  try {
    await prisma.$transaction(async (transaction) => {
      const payment = await transaction.payment.findUnique({
        where: { reference: fields.REFERENCE },
        include: { taxYear: true },
      });
      if (!payment) throw new ItnProcessingError("Unknown payment reference");
      if (
        payment.amountCents !== Number(fields.AMOUNT) ||
        payment.currency !== fields.CURRENCY ||
        payment.currency !== "ZAR"
      ) {
        throw new ItnProcessingError("Payment amount or currency mismatch");
      }

      if (payment.status === "PAID") {
        return;
      }
      if (payment.status !== "PENDING") {
        throw new ItnProcessingError("Payment is no longer pending");
      }

      if (fields.TRANSACTION_STATUS === "1") {
        const claimed = await transaction.payment.updateMany({
          where: { id: payment.id, status: "PENDING" },
          data: {
            status: "PAID",
            paidAt: new Date(),
            payRequestId: fields.PAY_REQUEST_ID || null,
            transactionId: fields.TRANSACTION_ID || null,
            resultCode: fields.RESULT_CODE,
            resultDesc: fields.RESULT_DESC,
          },
        });
        if (claimed.count !== 1) {
          const current = await transaction.payment.findUnique({
            where: { id: payment.id },
            select: { status: true },
          });
          if (current?.status === "PAID") return;
          throw new ItnProcessingError("Payment is no longer pending");
        }

        if (payment.taxYear.state !== "CLOSED_AND_LOCKED") {
          await transaction.taxYear.update({
            where: { id: payment.taxYearId },
            data: { state: "PAID_UNLOCKED" },
          });
        }
        await transaction.auditEvent.create({
          data: {
            taxYearId: payment.taxYearId,
            action: "PAYGATE_ITN_APPROVED",
            details: JSON.stringify({
              reference: fields.REFERENCE,
              payRequestId: fields.PAY_REQUEST_ID,
              transactionId: fields.TRANSACTION_ID,
              amountCents: payment.amountCents,
            }),
          },
        });
      } else {
        const claimed = await transaction.payment.updateMany({
          where: { id: payment.id, status: "PENDING" },
          data: {
            status: "DECLINED",
            payRequestId: fields.PAY_REQUEST_ID || null,
            transactionId: fields.TRANSACTION_ID || null,
            resultCode: fields.RESULT_CODE,
            resultDesc: fields.RESULT_DESC,
          },
        });
        if (claimed.count !== 1) {
          const current = await transaction.payment.findUnique({
            where: { id: payment.id },
            select: { status: true },
          });
          if (current?.status === "DECLINED") return;
          throw new ItnProcessingError("Payment is no longer pending");
        }
        await transaction.auditEvent.create({
          data: {
            taxYearId: payment.taxYearId,
            action: "PAYGATE_ITN_DECLINED",
            details: JSON.stringify({
              reference: fields.REFERENCE,
              resultCode: fields.RESULT_CODE,
              resultDescription: fields.RESULT_DESC,
            }),
          },
        });
      }
    });
  } catch (error) {
    if (error instanceof ItnProcessingError) {
      return new NextResponse(error.message, { status: 400 });
    }
    console.error("Failed to process verified PayGate ITN", error);
    return new NextResponse("ITN processing failed", { status: 500 });
  }

  return ACKNOWLEDGMENT();
}

class ItnProcessingError extends Error {}
