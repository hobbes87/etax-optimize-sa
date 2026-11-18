import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import { prisma } from '@/lib/prisma';
import { parseBankStatementText } from '@/lib/parser';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const taxYearId = String(formData.get('taxYearId') || '');
    const docCategory = String(formData.get('docCategory') || 'BANK_STATEMENT');

    if (!file || !taxYearId) {
      return NextResponse.json({ error: 'File and taxYearId are required.' }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const sha256Hash = crypto.createHash('sha256').update(buffer).digest('hex');

    let extractedText = '';
    if (file.name.toLowerCase().endsWith('.pdf')) {
      const parsed = await pdfParse(buffer);
      extractedText = parsed.text || '';
    } else {
      extractedText = buffer.toString('utf-8');
    }

    const requiresVisionOcr = extractedText.trim().length < 25;

    const docRecord = await prisma.documentVault.create({
      data: {
        taxYearId,
        fileName: file.name,
        docCategory,
        sha256Hash,
        extractedMeta: JSON.stringify({
          requiresVisionOcr,
          byteSize: buffer.length,
        }),
      },
    });

    let insertedCount = 0;
    if (!requiresVisionOcr && docCategory === 'BANK_STATEMENT') {
      const parsedTxs = parseBankStatementText(extractedText, file.name.slice(0, 8));
      for (const tx of parsedTxs) {
        try {
          await prisma.transaction.create({
            data: {
              taxYearId,
              txFingerprint: tx.txFingerprint,
              txDate: tx.txDate,
              description: tx.description,
              amount: tx.amount,
              txType: tx.txType,
              sarsCode: tx.sarsCode,
              confidence: tx.confidence,
              linkedDocHash: sha256Hash,
            },
          });
          insertedCount++;
        } catch {
          // Unique constraint skips duplicate transactions across overlapping monthly statements
        }
      }
    }

    if (docCategory === 'ITSA') {
      await prisma.taxYear.update({
        where: { id: taxYearId },
        data: { status: 'CLOSED_AND_LOCKED', lockedAt: new Date() },
      });
    }

    const transactions = await prisma.transaction.findMany({
      where: { taxYearId },
      orderBy: { txDate: 'asc' },
    });

    const documents = await prisma.documentVault.findMany({
      where: { taxYearId },
      orderBy: { uploadedAt: 'desc' },
    });

    return NextResponse.json({
      document: docRecord,
      insertedTransactions: insertedCount,
      requiresVisionOcr,
      transactions,
      documents,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Document parsing failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
