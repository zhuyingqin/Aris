import { useEffect, useMemo, useState } from "react";
import { isTauri, profileStats, type NewApiAccount } from "../api/tauri";
import type { ProfileStats } from "../types";
import type { Language } from "../store";
import { SETTINGS_COPY, type SettingsProfileCopy } from "./i18n";

type HeatmapMode = "daily" | "weekly" | "cumulative";

const HEATMAP_WEEKS = 53;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;

// Uses UTC so the grid date keys line up with the backend's UTC day buckets.
function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function buildPreviewStats(): ProfileStats {
  const daily: ProfileStats["daily"] = [];
  const today = new Date();
  let cumulative = 0;
  let peak = 0;
  for (let i = HEATMAP_DAYS - 1; i >= 0; i -= 1) {
    const day = new Date(today);
    day.setUTCDate(today.getUTCDate() - i);
    // Deterministic-ish pseudo activity: busier recently, quiet on some days.
    const wave = Math.max(0, Math.sin(i / 9) + Math.cos(i / 17));
    const recency = Math.max(0, 1 - i / HEATMAP_DAYS);
    const active = (i % 7 !== 0 && wave > 0.35) || recency > 0.82;
    const tokens = active ? Math.round((wave * 0.6 + recency) * 260_000) : 0;
    cumulative += tokens;
    peak = Math.max(peak, tokens);
    daily.push({ date: isoDate(day), tokens, turns: tokens > 0 ? Math.max(1, Math.round(tokens / 42_000)) : 0 });
  }
  return {
    cumulativeTokens: cumulative,
    peakDailyTokens: peak,
    totalTurns: daily.reduce((sum, bucket) => sum + bucket.turns, 0),
    activeDays: daily.filter((bucket) => bucket.tokens > 0).length,
    currentStreak: 2,
    longestStreak: 5,
    longestTaskSeconds: 6 * 3600 + 58 * 60,
    daily,
    byModel: [
      { model: "MiniMax-M3", provider: "openai", tokens: Math.round(cumulative * 0.6), turns: 640 },
      { model: "gpt-5.5", provider: "openai", tokens: Math.round(cumulative * 0.3), turns: 210 },
      { model: "deepseek-v4-pro", provider: "openai", tokens: Math.round(cumulative * 0.1), turns: 74 },
    ],
    topSkills: [
      { name: "openalex-search", runs: 18 },
      { name: "research-wiki", runs: 12 },
      { name: "experiment-bridge", runs: 2 },
    ],
    skillsExplored: 7,
    toolCalls: 1284,
    topReasoningEffort: "xhigh",
    metaLoggingEnabled: true,
    since: Math.floor(today.getTime() / 1000) - HEATMAP_DAYS * 86400,
  };
}

const PREVIEW_PROFILE_STATS = buildPreviewStats();

function formatTokens(value: number, language: Language, copy: SettingsProfileCopy): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (language === "cn") {
    if (value >= 1e8) return copy.compactHundredMillions((value / 1e8).toFixed(value >= 1e9 ? 0 : 1));
    if (value >= 1e4) return copy.compactTenThousands((value / 1e4).toFixed(value >= 1e6 ? 0 : 1));
    return Math.round(value).toLocaleString();
  }
  if (value >= 1e9) return copy.compactBillions((value / 1e9).toFixed(1));
  if (value >= 1e6) return copy.compactMillions((value / 1e6).toFixed(1));
  if (value >= 1e3) return copy.compactThousands((value / 1e3).toFixed(1));
  return Math.round(value).toLocaleString();
}

function formatDuration(seconds: number | null, accruing: string, copy: SettingsProfileCopy): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return accruing;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return copy.durationHoursMinutes(hours, minutes);
  if (minutes > 0) return copy.durationMinutes(minutes);
  return copy.durationSeconds(Math.round(seconds));
}

function avatarInitial(account: NewApiAccount | null): string {
  const source = account?.displayName || account?.username || "";
  const first = source.trim().charAt(0);
  return first ? first.toUpperCase() : "S";
}

interface HeatmapCell {
  date: string;
  tokens: number;
  level: number;
}

/** Bucket daily activity into a 53-week grid with 0–4 intensity levels. */
function buildHeatmap(daily: ProfileStats["daily"], mode: HeatmapMode): { weeks: HeatmapCell[][]; max: number } {
  const byDate = new Map(daily.map((bucket) => [bucket.date, bucket.tokens]));
  const cells: HeatmapCell[] = [];
  const today = new Date();
  // Align the grid so the last column ends on today; first cell starts on a
  // Sunday. All stepping is in UTC to match the backend's UTC day buckets.
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - (HEATMAP_DAYS - 1));
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());

  let runningCumulative = 0;
  const grandTotal = daily.reduce((sum, bucket) => sum + bucket.tokens, 0) || 1;
  const cursor = new Date(start);
  while (cursor <= today) {
    const key = isoDate(cursor);
    const tokens = byDate.get(key) ?? 0;
    runningCumulative += tokens;
    cells.push({ date: key, tokens, level: 0 });
    if (mode === "cumulative") {
      // stash cumulative fraction temporarily in level for later normalization
      cells[cells.length - 1].level = runningCumulative / grandTotal;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const weeks: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  if (mode === "weekly") {
    for (const week of weeks) {
      const weekTotal = week.reduce((sum, cell) => sum + cell.tokens, 0);
      for (const cell of week) cell.tokens = weekTotal;
    }
  }

  const max = Math.max(1, ...cells.map((cell) => (mode === "cumulative" ? 0 : cell.tokens)));
  for (const cell of cells) {
    if (mode === "cumulative") {
      cell.level = cell.level <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(cell.level * 4)));
    } else if (cell.tokens <= 0) {
      cell.level = 0;
    } else {
      cell.level = Math.min(4, Math.max(1, Math.ceil((cell.tokens / max) * 4)));
    }
  }
  return { weeks, max };
}

export default function Profile({
  account,
  language,
}: {
  account: NewApiAccount | null;
  language: Language;
}) {
  const copy = SETTINGS_COPY[language].profile;
  const [stats, setStats] = useState<ProfileStats | null>(() => (isTauri() ? null : PREVIEW_PROFILE_STATS));
  const [mode, setMode] = useState<HeatmapMode>("daily");

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    profileStats()
      .then((next) => {
        if (alive) setStats(next);
      })
      .catch(() => {
        // Backend command may be unavailable on older builds; show empty state.
        if (alive) {
          setStats({
            cumulativeTokens: 0,
            peakDailyTokens: 0,
            totalTurns: 0,
            activeDays: 0,
            currentStreak: 0,
            longestStreak: 0,
            longestTaskSeconds: null,
            daily: [],
            byModel: [],
            topSkills: [],
            skillsExplored: 0,
            toolCalls: 0,
            topReasoningEffort: null,
            metaLoggingEnabled: false,
            since: null,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const heatmap = useMemo(() => (stats ? buildHeatmap(stats.daily, mode) : null), [stats, mode]);
  const hasActivity = Boolean(stats && stats.daily.some((bucket) => bucket.tokens > 0));

  const displayName = account?.displayName || account?.username || copy.signedOut;
  const handle = account?.username ? `@${account.username}` : "";
  const plan = account?.subscriptionName || account?.group || "";

  const tiles = stats
    ? [
        { label: copy.statCumulative, value: formatTokens(stats.cumulativeTokens, language, copy) },
        { label: copy.statPeak, value: formatTokens(stats.peakDailyTokens, language, copy) },
        { label: copy.statLongestTask, value: formatDuration(stats.longestTaskSeconds, copy.accruing, copy) },
        { label: copy.statCurrentStreak, value: copy.days(stats.currentStreak) },
        { label: copy.statLongestStreak, value: copy.days(stats.longestStreak) },
      ]
    : [];

  return (
    <div className="sp-profile">
      <div className="sp-profile-hero">
        <div className="sp-profile-identity">
          <div className="sp-profile-avatar" aria-hidden="true">{avatarInitial(account)}</div>
          <div className="sp-profile-name-block">
            <div className="sp-profile-name">{displayName}</div>
            <div className="sp-profile-meta">
              {handle && <span>{handle}</span>}
              {handle && plan && <span className="sp-profile-dot">·</span>}
              {plan && <span className="sp-profile-plan">{plan}</span>}
            </div>
          </div>
        </div>
        <div className="sp-profile-hero-actions">
          <button type="button" className="sp-btn sp-btn-secondary" disabled>{copy.share}</button>
          <button type="button" className="sp-btn sp-btn-secondary" disabled>{copy.privateLabel}</button>
          <button type="button" className="sp-btn sp-btn-secondary" disabled>{copy.edit}</button>
        </div>
      </div>

      {!stats ? (
        <div className="sp-profile-loading">{copy.loading}</div>
      ) : (
        <>
          <div className="sp-profile-tiles">
            {tiles.map((tile) => (
              <div className="sp-profile-tile" key={tile.label}>
                <strong>{tile.value}</strong>
                <span>{tile.label}</span>
              </div>
            ))}
          </div>

          <section className="sp-profile-activity">
            <div className="sp-profile-section-head">
              <div className="sp-profile-section-title">{copy.activityTitle}</div>
              <div className="sp-profile-mode-toggle" role="tablist">
                {([
                  { id: "daily" as const, label: copy.modeDaily },
                  { id: "weekly" as const, label: copy.modeWeekly },
                  { id: "cumulative" as const, label: copy.modeCumulative },
                ]).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="tab"
                    aria-selected={mode === option.id}
                    className={`sp-profile-mode${mode === option.id ? " active" : ""}`}
                    onClick={() => setMode(option.id)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            {hasActivity && heatmap ? (
              <>
                <div className="sp-profile-heatmap" role="img" aria-label={copy.activityTitle}>
                  {heatmap.weeks.map((week, weekIndex) => (
                    <div className="sp-profile-heatmap-week" key={weekIndex}>
                      {week.map((cell) => (
                        <span
                          key={cell.date}
                          className="sp-profile-heatmap-cell"
                          data-level={cell.level}
                          title={`${cell.date} · ${formatTokens(cell.tokens, language, copy)} ${copy.tokenUnit}`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                {stats.since && (
                  <div className="sp-profile-activity-foot">
                    {copy.activitySince(new Date(stats.since * 1000).toLocaleDateString())}
                  </div>
                )}
              </>
            ) : (
              <div className="sp-profile-empty">{copy.activityEmpty}</div>
            )}
          </section>

          <div className="sp-profile-columns">
            <section className="sp-profile-insights">
              <div className="sp-profile-section-title">{copy.insightsTitle}</div>
              <div className="sp-profile-insight-row">
                <span>{copy.insightFastMode}</span>
                <strong>{copy.accruing}</strong>
              </div>
              <div className="sp-profile-insight-row">
                <span>{copy.insightReasoning}</span>
                <strong>{stats.topReasoningEffort ?? copy.accruing}</strong>
              </div>
              <div className="sp-profile-insight-row">
                <span>{copy.insightSkills}</span>
                <strong>{stats.skillsExplored || copy.accruing}</strong>
              </div>
              <div className="sp-profile-insight-row">
                <span>{copy.insightTools}</span>
                <strong>{stats.toolCalls ? stats.toolCalls.toLocaleString() : copy.accruing}</strong>
              </div>
              {!stats.metaLoggingEnabled && <div className="sp-profile-meta-hint">{copy.metaHint}</div>}
            </section>

            <section className="sp-profile-skills">
              <div className="sp-profile-section-title">{copy.topSkillsTitle}</div>
              {stats.topSkills.length > 0 ? (
                <div className="sp-profile-skill-list">
                  {stats.topSkills.map((skill) => (
                    <div className="sp-profile-skill-row" key={skill.name}>
                      <span className="sp-profile-skill-name">${skill.name}</span>
                      <span className="sp-profile-skill-runs">{copy.runs(skill.runs)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="sp-profile-empty">{copy.topSkillsEmpty}</div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
