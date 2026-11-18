import crypto from 'crypto';
import { redactSouthAfricanPII } from './popia-scrubber';

export interface ParsedTransaction {
  txFingerprint: string;
  txDate: string;
  description: string;
  amount: number;
  txType: 'CREDIT' | 'DEBIT';
  sarsCode: string;
  confidence: number;
}

export function buildTxFingerprint(
  accountHint: string,
  date: string,
  amount: number,
  desc: string,
  dailySeq: number
): string {
  const normalizedDesc = desc.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  const raw = `${accountHint}|${date}|${amount.toFixed(2)}|${normalizedDesc}|${dailySeq}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function classifyMerchantText(
  cleanDesc: string,
  txType: 'CREDIT' | 'DEBIT'
): { sarsCode: string; confidence: number } {
  const u = cleanDesc.toUpperCase();

  if (txType === 'CREDIT') {
    if (/(SALARY|PAYROLL|WAGES|REMUNERATION)/.test(u)) return { sarsCode: '3601', confidence: 98 };
    if (/(INTEREST|INT PAID|CREDIT INT)/.test(u)) return { sarsCode: '4201', confidence: 96 };
    return { sarsCode: '3616', confidence: 62 };
  }

  if (/(DISCOVERY|BONITAS|MOMENTUM HEALTH|MEDSHIELD|BESTMED)/.test(u)) {
    return { sarsCode: '4005', confidence: 98 };
  }
  if (/(ALLAN GRAY|SANLAM|SYGNIA|CORONATION|OLD MUTUAL RA|RETIREMENT)/.test(u)) {
    return { sarsCode: '4006', confidence: 96 };
  }
  if (/(AFRIHOST|WEBAFRICA|OPENWEB|ESKOM|CITY OF|MUNICIPAL|RATES)/.test(u)) {
    return { sarsCode: '4028', confidence: 86 };
  }
  if (/(ENGEN|SHELL|BP |SASOL|CALTEX|TOTALENERGIES|UBER)/.test(u)) {
    return { sarsCode: '4014', confidence: 65 };
  }
  if (/(CLICKS|DIS-CHEM|DISCHEM|MEDIRITE|PHARMACY|DR |DENTAL)/.test(u)) {
    return { sarsCode: '4020', confidence: 68 };
  }
  if (/(CHECKERS|WOOLWORTHS|PICK N PAY|SPAR|NETFLIX|TAKEALOT|MR D)/.test(u)) {
    return { sarsCode: '9999', confidence: 94 };
  }

  return { sarsCode: '9999', confidence: 52 };
}

export function parseBankStatementText(rawText: string, accountHint = 'DEFAULT'): ParsedTransaction[] {
  const lines = rawText.split(/\r?\n/);
  const results: ParsedTransaction[] = [];
  const seqTracker: Record<string, number> = {};

  const lineRegex =
    /^(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{2,4}|\d{2}\s+[A-Za-z]{3}(?:\s+\d{2,4})?)\s+(.+?)\s+(-?[\d\s,]+\.\d{2})(?:\s*(Cr|CR|Dr|DR))?(?:\s+-?[\d\s,]+\.\d{2}(?:\s*(?:Cr|CR|Dr|DR))?)?$/;

  for (const rawLine of lines) {
    const match = rawLine.trim().match(lineRegex);
    if (!match) continue;

    const [, rawDate, rawDesc, rawAmt, crDrFlag] = match;
    const numericAmt = parseFloat(rawAmt.replace(/[\s,]/g, ''));
    if (Number.isNaN(numericAmt) || numericAmt === 0) continue;

    const cleanDesc = redactSouthAfricanPII(rawDesc);
    const isCredit =
      (crDrFlag && crDrFlag.toUpperCase() === 'CR') ||
      (numericAmt > 0 && /(CREDIT|DEPOSIT|SALARY|INTEREST|EFT IN|RTC)/.test(cleanDesc.toUpperCase()));

    const txType: 'CREDIT' | 'DEBIT' = isCredit ? 'CREDIT' : 'DEBIT';
    const absAmt = Math.abs(numericAmt);

    const seqKey = `${rawDate}|${absAmt.toFixed(2)}|${cleanDesc.slice(0, 12)}`;
    seqTracker[seqKey] = (seqTracker[seqKey] || 0) + 1;

    const { sarsCode, confidence } = classifyMerchantText(cleanDesc, txType);

    results.push({
      txFingerprint: buildTxFingerprint(accountHint, rawDate, absAmt, cleanDesc, seqTracker[seqKey]),
      txDate: rawDate,
      description: cleanDesc,
      amount: absAmt,
      txType,
      sarsCode,
      confidence,
    });
  }

  return results;
}
