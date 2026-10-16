import { describe, expect, it } from "vitest";
import { buildProfileHeatmap } from "./profileHeatmap";

describe("Profile heatmap", () => {
  it("keeps 53 Sunday-aligned weeks and masks future dates", () => {
    const weeks = buildProfileHeatmap([], "daily", 0, new Date("2026-10-04T23:59:00Z"));
    expect(weeks).toHaveLength(53);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks.at(-1)?.[0]).toMatchObject({ date: "2026-10-04", future: false });
    expect(weeks.at(-1)?.slice(1).every((cell) => cell.future && cell.tokens === 0)).toBe(true);
  });

  it("shows lifetime cumulative amounts rather than each day's amount", () => {
    const weeks = buildProfileHeatmap([
      { date: "2026-10-02", tokens: 20, turns: 1 },
      { date: "2026-10-03", tokens: 30, turns: 1 },
    ], "cumulative", 1_050, new Date("2026-10-03T12:00:00Z"));
    const cells = weeks.flat();
    expect(cells[0].tokens).toBe(1_000);
    expect(cells.find((cell) => cell.date === "2026-10-02")?.tokens).toBe(1_020);
    expect(cells.at(-1)?.tokens).toBe(1_050);
  });

  it("aggregates weekly totals and excludes future records", () => {
    const weeks = buildProfileHeatmap([
      { date: "2026-10-04", tokens: 20, turns: 1 },
      { date: "2026-10-05", tokens: 30, turns: 1 },
      { date: "2026-10-07", tokens: 900, turns: 1 },
    ], "weekly", 50, new Date("2026-10-05T01:00:00Z"));
    expect(weeks.at(-1)?.[0]).toMatchObject({ tokens: 50, endDate: "2026-10-05" });
    expect(weeks.at(-1)?.[1].tokens).toBe(50);
    expect(weeks.at(-1)?.[3]).toMatchObject({ tokens: 0, future: true });
  });
});
