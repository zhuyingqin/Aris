import type { ProfileStats } from "../types";

export type HeatmapMode = "daily" | "weekly" | "cumulative";
const DAY_MS = 86_400_000;
const WEEKS = 53;

export interface HeatmapCell {
  date: string;
  endDate?: string;
  tokens: number;
  level: number;
  future: boolean;
}

export interface ProfileActivityPoint {
  date: string;
  endDate?: string;
  tokens: number;
}

/** One bucket per week for bars, or one lifetime total per elapsed day for a line. */
export function buildProfileActivitySeries(
  daily: ProfileStats["daily"],
  mode: "weekly" | "cumulative",
  cumulativeTokens: number,
  now = new Date(),
): ProfileActivityPoint[] {
  const weeks = buildProfileHeatmap(daily, mode, cumulativeTokens, now);
  const cells = mode === "weekly" ? weeks.map((week) => week[0]) : weeks.flat();
  return cells.filter((cell) => !cell.future).map(({ date, endDate, tokens }) => ({ date, endDate, tokens }));
}

/** UTC buckets match the local ledger. Keep 53 aligned columns, including
 * placeholders after today, and retain lifetime usage before the window. */
export function buildProfileHeatmap(
  daily: ProfileStats["daily"],
  mode: HeatmapMode,
  cumulativeTokens: number,
  now = new Date(),
): HeatmapCell[][] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = today - (now.getUTCDay() + (WEEKS - 1) * 7) * DAY_MS;
  const byDate = new Map<string, number>();
  for (const bucket of daily) {
    const timestamp = Date.parse(`${bucket.date}T00:00:00Z`);
    if (timestamp > today || !Number.isFinite(timestamp) || bucket.tokens <= 0) continue;
    byDate.set(bucket.date, (byDate.get(bucket.date) ?? 0) + bucket.tokens);
  }
  const visibleTotal = [...byDate].reduce((total, [date, tokens]) =>
    Date.parse(`${date}T00:00:00Z`) >= start ? total + tokens : total, 0);
  let cumulative = Math.max(0, cumulativeTokens - visibleTotal);
  const weeks: HeatmapCell[][] = [];
  for (let week = 0; week < WEEKS; week++) {
    const cells: HeatmapCell[] = [];
    for (let day = 0; day < 7; day++) {
      const timestamp = start + (week * 7 + day) * DAY_MS;
      const date = new Date(timestamp).toISOString().slice(0, 10);
      const future = timestamp > today;
      const tokens = future ? 0 : byDate.get(date) ?? 0;
      if (!future) cumulative += tokens;
      cells.push({ date, tokens: mode === "cumulative" && !future ? cumulative : tokens, level: 0, future });
    }
    if (mode === "weekly") {
      const total = cells.reduce((sum, cell) => sum + cell.tokens, 0);
      const endDate = cells.filter((cell) => !cell.future).at(-1)?.date;
      for (const cell of cells) {
        if (!cell.future) { cell.tokens = total; cell.endDate = endDate; }
      }
    }
    weeks.push(cells);
  }
  const max = Math.max(1, ...weeks.flat().map((cell) => cell.tokens));
  for (const cell of weeks.flat()) {
    cell.level = cell.tokens <= 0 || cell.future ? 0 : Math.min(4, Math.max(1, Math.ceil(cell.tokens / max * 4)));
  }
  return weeks;
}
