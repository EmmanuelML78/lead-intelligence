export const BUSINESS_TIMEZONE = "America/Bogota";

/**
 * Pinned assessment-demo calendar date. The synthetic snapshot is historical
 * relative to wall-clock execution; pinning ASSIGNMENT_BUSINESS_DATE to this
 * value keeps capacity and assignment stable during evaluation.
 * The engine still uses "today in BUSINESS_TIMEZONE" when the env var is unset.
 */
export const DEMO_ASSIGNMENT_BUSINESS_DATE = "2026-09-14";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export type AssignmentClock = {
  /** Explicit calendar date `YYYY-MM-DD`. Preferred for tests and analysis. */
  businessDate?: string | Date;
  /** Instant used only when `businessDate` is omitted. */
  now?: Date;
  /** IANA timezone used to derive the calendar date from `now`. */
  timeZone?: string;
};

/**
 * Store business dates as UTC midnight of the calendar date. This is a
 * date-only value, not a Bogotá instant. Do not convert it through the
 * business timezone again when reading.
 */
export function parseBusinessDate(value: string): Date {
  const match = DATE_ONLY.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid business date '${value}'. Expected YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid business date '${value}'.`);
  }
  return date;
}

export function formatBusinessDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function calendarDateInTimeZone(instant: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(instant);
}

export function businessDateFromInstant(instant: Date, timeZone: string = BUSINESS_TIMEZONE): Date {
  return parseBusinessDate(calendarDateInTimeZone(instant, timeZone));
}

export function resolveBusinessDate(clock: AssignmentClock = {}): Date {
  const timeZone = clock.timeZone?.trim() || BUSINESS_TIMEZONE;
  if (typeof clock.businessDate === "string") {
    return parseBusinessDate(clock.businessDate);
  }
  if (clock.businessDate instanceof Date) {
    if (Number.isNaN(clock.businessDate.getTime())) {
      throw new Error("Invalid business date Date value.");
    }
    if (isDateOnlyUtcMidnight(clock.businessDate)) {
      return new Date(clock.businessDate.getTime());
    }
    return businessDateFromInstant(clock.businessDate, timeZone);
  }
  return businessDateFromInstant(clock.now ?? new Date(), timeZone);
}

export function isDateOnlyUtcMidnight(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

export function assignmentClockFromEnv(
  env: NodeJS.Dict<string> = process.env,
  now: Date = new Date()
): AssignmentClock {
  const businessDate = env.ASSIGNMENT_BUSINESS_DATE?.trim();
  const timeZone = env.BUSINESS_TIMEZONE?.trim() || BUSINESS_TIMEZONE;
  return businessDate ? { businessDate, timeZone, now } : { now, timeZone };
}
