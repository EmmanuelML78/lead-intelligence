export type DateParseResult = {
  date: Date | null;
  rule: string;
  ambiguous: boolean;
};

function safeDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) return null;
  return d;
}

export function parseMixedDate(value: string | null | undefined): DateParseResult {
  const raw = value?.trim();
  if (!raw) return { date: null, rule: "missing", ambiguous: false };

  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    return {
      date: safeDate(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)),
      rule: "iso_or_ymd",
      ambiguous: false
    };
  }

  m = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) {
    return { date: safeDate(+m[3], +m[2], +m[1]), rule: "dmy_dash", ambiguous: false };
  }

  m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{2}):(\d{2}))?$/);
  if (m) {
    const a = +m[1], b = +m[2], year = +m[3], hour = +(m[4] ?? 0), minute = +(m[5] ?? 0);
    if (a > 12 && b <= 12) return { date: safeDate(year, b, a, hour, minute), rule: "dmy_slash", ambiguous: false };
    if (b > 12 && a <= 12) return { date: safeDate(year, a, b, hour, minute), rule: "mdy_slash", ambiguous: false };
    // Assessment data is predominantly August 2026. We preserve the ambiguity flag so it is auditable.
    return { date: safeDate(year, b, a, hour, minute), rule: "dmy_slash_assumed", ambiguous: true };
  }

  return { date: null, rule: "unrecognized", ambiguous: false };
}
