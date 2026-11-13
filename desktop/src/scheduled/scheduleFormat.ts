import type { Language } from "../store";

/** Zones offered as one-click choices next to the free-text zone field. */
export const COMMON_TIME_ZONES = [
  "Asia/Shanghai",
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

/** The device's IANA zone, the default for a new task. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every zone the WebView knows, for the zone field's suggestions. The backend
 *  (chrono-tz) is the authority on what is accepted. */
export function supportedTimeZones(): string[] {
  const supportedValuesOf = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  try {
    return typeof supportedValuesOf === "function" ? supportedValuesOf("timeZone") : COMMON_TIME_ZONES;
  } catch {
    return COMMON_TIME_ZONES;
  }
}

export function localeFor(language: Language): string {
  return language === "cn" ? "zh-CN" : "en-US";
}

function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * An instant on the wall clock of `zone`, with the zone's UTC offset — the
 * form a DST change is visible in ("GMT-4" one day, "GMT-5" the next).
 */
export function formatInZone(
  value: string | number | null | undefined,
  zone: string | null | undefined,
  language: Language,
  options: { withZone?: boolean; withYear?: boolean; withWeekday?: boolean } = {},
): string | null {
  const date = toDate(value);
  if (!date) return null;
  const { withZone = true, withYear = false, withWeekday = true } = options;
  const base: Intl.DateTimeFormatOptions = {
    timeZone: zone || undefined,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(withYear ? { year: "numeric" } : {}),
    ...(withWeekday ? { weekday: "short" } : {}),
  };
  const locale = localeFor(language);
  const attempts: Intl.DateTimeFormatOptions[] = withZone
    ? [{ ...base, timeZoneName: "shortOffset" }, { ...base, timeZoneName: "short" }, base]
    : [base];
  for (const attempt of attempts) {
    try {
      return new Intl.DateTimeFormat(locale, attempt).format(date);
    } catch {
      // An unknown zone or an unsupported option: try the plainer form.
    }
  }
  return date.toISOString();
}

/** `YYYY-MM-DDTHH:MM` of an instant on `zone`'s wall clock — the value an
 *  `<input type="datetime-local">` holds for a rule read in that zone. */
export function wallClockInZone(ms: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16);
  }
}

/** The next whole hour on `zone`'s wall clock, as a datetime-local value. */
export function nextWholeHourInZone(zone: string, now = Date.now()): string {
  const local = wallClockInZone(now + 60 * 60 * 1000, zone);
  return `${local.slice(0, 13)}:00`;
}
