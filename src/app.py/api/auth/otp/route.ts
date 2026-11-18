import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { normalizeSaPhone } from '@/lib/popia-scrubber';

function hashOtp(otp: string): string {
  const pepper = process.env.OTP_PEPPER || 'default_dev_pepper';
  return crypto.createHash('sha256').update(`${pepper}:${otp}`).digest('hex');
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'REQUEST_OTP') {
      const { identifier, password, purpose, fullName, email, phone, popiaConsent, specialDataConsent } = body;

      if (purpose === 'REGISTER') {
        if (!popiaConsent) {
          return NextResponse.json({ error: 'Explicit POPIA consent is required.' }, { status: 400 });
        }
        const normPhone = normalizeSaPhone(phone);
        const passwordHash = await bcrypt.hash(password, 12);
        const user = await prisma.user.create({
          data: {
            fullName: fullName.trim(),
            email: email.trim().toLowerCase(),
            phone: normPhone,
            passwordHash,
            popiaConsentAt: new Date(),
            specialDataConsent: Boolean(specialDataConsent),
          },
        });

        const otp = String(crypto.randomInt(100000, 999999));
        await prisma.otpToken.create({
          data: {
            userId: user.id,
            codeHash: hashOtp(otp),
            purpose: 'REGISTER',
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          },
        });

        return NextResponse.json({
          userId: user.id,
          phone: normPhone,
          sandboxOtp: process.env.NODE_ENV !== 'production' ? otp : undefined,
        });
      }

      const normPhone = normalizeSaPhone(identifier || '');
      const user = await prisma.user.findFirst({
        where: { OR: [{ email: (identifier || '').trim().toLowerCase() }, { phone: normPhone }] },
      });

      if (!user) {
        return NextResponse.json({ error: 'Taxpayer account not found.' }, { status: 404 });
      }

      if (purpose === 'LOGIN') {
        const valid = await bcrypt.compare(password || '', user.passwordHash);
        if (!valid) return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 });
      }

      const otp = String(crypto.randomInt(100000, 999999));
      await prisma.otpToken.create({
        data: {
          userId: user.id,
          codeHash: hashOtp(otp),
          purpose: purpose || 'LOGIN',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });

      return NextResponse.json({
        userId: user.id,
        phone: user.phone,
        sandboxOtp: process.env.NODE_ENV !== 'production' ? otp : undefined,
      });
    }

    if (action === 'VERIFY_OTP') {
      const { userId, otp, newPassword } = body;
      const token = await prisma.otpToken.findFirst({
        where: { userId, consumed: false, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      });

      if (!token || token.attempts >= 3) {
        return NextResponse.json({ error: 'OTP expired or maximum attempts exceeded.' }, { status: 400 });
      }

      if (token.codeHash !== hashOtp(String(otp))) {
        await prisma.otpToken.update({
          where: { id: token.id },
          data: { attempts: { increment: 1 } },
        });
        return NextResponse.json({ error: 'Incorrect OTP code.' }, { status: 401 });
      }

      await prisma.otpToken.update({ where: { id: token.id }, data: { consumed: true } });

      const updateData: Record<string, unknown> = { isVerified: true };
      if (token.purpose === 'RESET_PW' && newPassword) {
        updateData.passwordHash = await bcrypt.hash(newPassword, 12);
      }

      const user = await prisma.user.update({ where: { id: userId }, data: updateData });
      return NextResponse.json({
        authenticated: true,
        user: { id: user.id, fullName: user.fullName, email: user.email, phone: user.phone },
      });
    }

    return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Authentication error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
