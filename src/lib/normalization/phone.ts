export type PhoneNormalization = {
  raw: string | null;
  normalized: string | null;
  valid: boolean;
  rule: string;
};

export function normalizeColombianPhone(value: string | null | undefined): PhoneNormalization {
  const raw = value?.trim() || null;
  if (!raw) return { raw, normalized: null, valid: false, rule: "missing" };

  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("57") && digits.length === 12) digits = digits.slice(2);

  if (digits.length === 10 && digits.startsWith("3")) {
    return { raw, normalized: `+57${digits}`, valid: true, rule: "co_mobile" };
  }

  return { raw, normalized: null, valid: false, rule: "unrecognized" };
}
