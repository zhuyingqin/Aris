import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { profileStats, type NewApiAccount } from "../api/tauri";
import { hasNativeBackend } from "../api/transport";
import type { ProfileStats } from "../types";
import type { Language } from "../store";
import {
  prepareProfileAvatar,
  ProfileAvatarError,
  useProfileAvatar,
  writeProfileAvatar,
} from "../profileAvatar";
import { SETTINGS_COPY, type SettingsProfileCopy } from "./i18n";

type HeatmapMode = "daily" | "weekly" | "cumulative";

const HEATMAP_WEEKS = 53;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;

// Uses UTC so the grid date keys line up with the backend's UTC day buckets.
function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

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

function formatDuration(seconds: number | null, unavailable: string, copy: SettingsProfileCopy): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return unavailable;
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
  const backendAvailable = hasNativeBackend();
  const verifiedAccount = backendAvailable ? account : null;
  const avatar = useProfileAvatar();
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [statsUnavailable, setStatsUnavailable] = useState(!backendAvailable);
  const [mode, setMode] = useState<HeatmapMode>("daily");

  useEffect(() => {
    if (!backendAvailable) {
      setStats(null);
      setStatsUnavailable(true);
      return;
    }
    let alive = true;
    setStatsUnavailable(false);
    profileStats()
      .then((next) => {
        if (alive) setStats(next);
      })
      .catch(() => {
        if (alive) setStatsUnavailable(true);
      });
    return () => {
      alive = false;
    };
  }, [backendAvailable]);

  const chooseAvatar = () => {
    setAvatarError("");
    avatarInputRef.current?.click();
  };

  const onAvatarSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setAvatarBusy(true);
    setAvatarError("");
    try {
      const prepared = await prepareProfileAvatar(file);
      if (!writeProfileAvatar(prepared)) setAvatarError(copy.avatarSaveFailed);
    } catch (error) {
      if (error instanceof ProfileAvatarError && error.reason === "too-large") {
        setAvatarError(copy.avatarTooLarge);
      } else {
        setAvatarError(copy.avatarUnsupported);
      }
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = () => {
    setAvatarError("");
    if (!writeProfileAvatar(null)) setAvatarError(copy.avatarSaveFailed);
  };

  const heatmap = useMemo(() => (stats ? buildHeatmap(stats.daily, mode) : null), [stats, mode]);
  const hasActivity = Boolean(stats && stats.daily.some((bucket) => bucket.tokens > 0));

  const displayName = verifiedAccount?.displayName || verifiedAccount?.username || copy.signedOut;
  const handle = verifiedAccount?.username ? `@${verifiedAccount.username}` : "";
  const plan = verifiedAccount?.subscriptionName || verifiedAccount?.group || "";

  const tiles = stats
    ? [
        { label: copy.statCumulative, value: formatTokens(stats.cumulativeTokens, language, copy) },
        { label: copy.statPeak, value: formatTokens(stats.peakDailyTokens, language, copy) },
        { label: copy.statLongestTask, value: formatDuration(stats.longestTaskSeconds, copy.unavailable, copy) },
        { label: copy.statCurrentStreak, value: copy.days(stats.currentStreak) },
        { label: copy.statLongestStreak, value: copy.days(stats.longestStreak) },
      ]
    : [];

  return (
    <div className="sp-profile">
      <div className="sp-profile-hero">
        <div className="sp-profile-identity">
          <button
            className="sp-profile-avatar-button"
            type="button"
            onClick={chooseAvatar}
            aria-label={copy.avatarChoose}
            disabled={avatarBusy}
          >
            <span className="sp-profile-avatar" aria-hidden="true">
              {avatar ? <img src={avatar} alt="" /> : avatarInitial(verifiedAccount)}
            </span>
            <span className="sp-profile-avatar-edit" aria-hidden="true">+</span>
          </button>
          <input
            ref={avatarInputRef}
            className="sp-profile-avatar-input"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label={copy.avatarChoose}
            onChange={(event) => void onAvatarSelected(event)}
          />
          <div className="sp-profile-name-block">
            <div className="sp-profile-name">{displayName}</div>
            <div className="sp-profile-meta">
              {handle && <span>{handle}</span>}
              {handle && plan && <span className="sp-profile-dot">·</span>}
              {plan && <span className="sp-profile-plan">{plan}</span>}
            </div>
            <div className="sp-profile-avatar-actions">
              <button type="button" onClick={chooseAvatar} disabled={avatarBusy}>
                {avatarBusy ? copy.avatarProcessing : avatar ? copy.avatarChange : copy.avatarChoose}
              </button>
              {avatar && <button type="button" onClick={removeAvatar}>{copy.avatarRemove}</button>}
            </div>
            {avatarError && <div className="sp-profile-avatar-error" role="alert">{avatarError}</div>}
          </div>
        </div>
      </div>

      {statsUnavailable ? (
        <div className="sp-profile-unavailable" role="status">{copy.statsUnavailable}</div>
      ) : !stats ? (
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
                <span>{copy.insightReasoning}</span>
                <strong>{stats.topReasoningEffort ?? copy.unavailable}</strong>
              </div>
              <div className="sp-profile-insight-row">
                <span>{copy.insightSkills}</span>
                <strong>{stats.metaLoggingEnabled ? stats.skillsExplored.toLocaleString() : copy.unavailable}</strong>
              </div>
              <div className="sp-profile-insight-row">
                <span>{copy.insightTools}</span>
                <strong>{stats.metaLoggingEnabled ? stats.toolCalls.toLocaleString() : copy.unavailable}</strong>
              </div>
              {!stats.metaLoggingEnabled && <div className="sp-profile-meta-hint">{copy.metaHint}</div>}
            </section>

            <section className="sp-profile-skills">
              <div className="sp-profile-section-title">{copy.topSkillsTitle}</div>
              {stats.topSkills.length > 0 ? (
                <div className="sp-profile-skill-list">
                  {stats.topSkills.map((skill) => (
                    <div className="sp-profile-skill-row" key={skill.name}>
                      <span className="sp-profile-skill-name">/{skill.name}</span>
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
