export function redactSouthAfricanPII(rawText: string): string {
  return rawText
    .replace(/\b\d{6}\s?\d{4}\s?[01]\s?\d{2}\b/g, '[REDACTED_SA_ID]')
    .replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{2,8}\b/g, '[REDACTED_ACC]')
    .replace(/(?:\+27|0)[6-8]\d[\s-]?\d{3}[\s-]?\d{4}\b/g, '[REDACTED_PHONE]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .trim();
}

export function normalizeSaPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) return `+27${digits.slice(1)}`;
  if (digits.startsWith('27') && digits.length === 11) return `+${digits}`;
  return phone.trim();
}
