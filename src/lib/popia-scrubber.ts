const SA_ID_PATTERN = /\b\d{13}\b/g;
const PHONE_PATTERN = /\b(?:\+27|0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ACCOUNT_PATTERN = /\b\d{10,16}\b/g;
const ADDRESS_PATTERN = /\b\d{1,5}\s+[A-Za-z][A-Za-z .'-]{3,}\s+(Road|Street|Avenue|Drive|Lane|Close)\b/gi;

export function scrubPersonalInformation(input: string): string {
  return input
    .replace(SA_ID_PATTERN, "[SA_ID_REDACTED]")
    .replace(PHONE_PATTERN, "[PHONE_REDACTED]")
    .replace(EMAIL_PATTERN, "[EMAIL_REDACTED]")
    .replace(ADDRESS_PATTERN, "[ADDRESS_REDACTED]")
    .replace(ACCOUNT_PATTERN, "[ACCOUNT_REDACTED]");
}