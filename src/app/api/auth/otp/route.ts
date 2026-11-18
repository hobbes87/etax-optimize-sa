import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const otps = new Map<string, { hash: string; expiresAt: number }>();

export async function POST(request: NextRequest) {
  const { phone, code } = await request.json();
  if (!phone) return NextResponse.json({ error: "Phone number is required" }, { status: 400 });

  if (code) {
    const saved = otps.get(phone);
    if (!saved || saved.expiresAt < Date.now()) {
      return NextResponse.json({ error: "Invalid or expired OTP" }, { status: 400 });
    }
    if (crypto.timingSafeEqual(Buffer.from(saved.hash), Buffer.from(hash(code)))) {
      otps.delete(phone);
      return NextResponse.json({ verified: true });
    }
    return NextResponse.json({ error: "Invalid OTP" }, { status: 400 });
  }

  const generated = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 5 * 60 * 1000;
  otps.set(phone, { hash: hash(generated), expiresAt });
  await prisma.otpCode.create({
    data: { phone, codeHash: hash(generated), expiresAt: new Date(expiresAt) },
  });

  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ sent: true });
  }
  return NextResponse.json({ sent: true, developmentCode: generated });
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}