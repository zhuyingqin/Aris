/**
 * Backend timestamps arrive as unix seconds in most places but unix
 * milliseconds in a few; treat anything above 10_000_000_000 (year 2286 in
 * seconds) as already-milliseconds. Shared so the threshold can't drift
 * between call sites.
 */
export function epochToDate(value: number | null | undefined): Date | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const millis = value > 10_000_000_000 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}
