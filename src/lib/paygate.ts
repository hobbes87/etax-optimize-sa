import crypto from "crypto";

export type PayGateInitiationFields = {
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
};

export type PayGateItnFields = {
  PAYGATE_ID: string;
  PAY_REQUEST_ID: string;
  REFERENCE: string;
  TRANSACTION_STATUS: string;
  RESULT_CODE: string;
  AUTH_CODE: string;
  CURRENCY: string;
  AMOUNT: string;
  RESULT_DESC: string;
  TRANSACTION_ID: string;
  RISK_INDICATOR: string;
  PAY_METHOD: string;
  PAY_METHOD_DETAIL: string;
};

const initiationOrder: (keyof PayGateInitiationFields)[] = [
  "PAYGATE_ID",
  "REFERENCE",
  "AMOUNT",
  "CURRENCY",
  "RETURN_URL",
  "TRANSACTION_DATE",
  "LOCALE",
  "COUNTRY",
  "EMAIL",
  "NOTIFY_URL",
];

const itnOrder: (keyof PayGateItnFields)[] = [
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

function checksum(values: string[], secret: string): string {
  return crypto.createHash("md5").update(values.join("") + secret, "utf8").digest("hex");
}

export function createPayGateInitiationChecksum(
  fields: PayGateInitiationFields,
  secret: string
): string {
  return checksum(initiationOrder.map((key) => fields[key]), secret);
}

export function createPayGateItnChecksum(fields: PayGateItnFields, secret: string): string {
  return checksum(itnOrder.map((key) => fields[key]), secret);
}

export function verifyPayGateItnChecksum(
  fields: PayGateItnFields,
  suppliedChecksum: string,
  secret: string
): boolean {
  if (!/^[a-f\d]{32}$/i.test(suppliedChecksum)) return false;
  const expected = createPayGateItnChecksum(fields, secret);
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(suppliedChecksum, "hex")
  );
}
