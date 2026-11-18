import crypto from 'crypto';

export interface PayGateInitPayload {
  PAYGATE_ID: string;
  REFERENCE: string;
  AMOUNT: string;
  CURRENCY: string;
  RETURN_URL: string;
  TRANSACTION_DATE: string;
  LOCALE: string;
  COUNTRY: string;
  EMAIL: string;
  NOTIFY_URL: string;
  CHECKSUM: string;
}

export function generatePayGateChecksum(
  fields: Omit<PayGateInitPayload, 'CHECKSUM'>,
  secretKey: string
): string {
  const concatenated =
    fields.PAYGATE_ID +
    fields.REFERENCE +
    fields.AMOUNT +
    fields.CURRENCY +
    fields.RETURN_URL +
    fields.TRANSACTION_DATE +
    fields.LOCALE +
    fields.COUNTRY +
    fields.EMAIL +
    fields.NOTIFY_URL +
    secretKey;

  return crypto.createHash('md5').update(concatenated).digest('hex');
}

export function verifyPayGateItnChecksum(
  body: Record<string, string>,
  secretKey: string
): boolean {
  const orderedKeys = [
    'PAYGATE_ID',
    'PAY_REQUEST_ID',
    'REFERENCE',
    'TRANSACTION_STATUS',
    'RESULT_CODE',
    'AUTH_CODE',
    'CURRENCY',
    'AMOUNT',
    'RESULT_DESC',
    'TRANSACTION_ID',
    'RISK_INDICATOR',
    'PAY_METHOD',
    'PAY_METHOD_DETAIL',
  ];

  const payload = orderedKeys.map((k) => body[k] ?? '').join('') + secretKey;
  const expected = crypto.createHash('md5').update(payload).digest('hex');
  return expected.toLowerCase() === (body.CHECKSUM || '').toLowerCase();
}
