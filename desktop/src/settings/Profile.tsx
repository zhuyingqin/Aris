import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
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
import { buildProfileHeatmap, type HeatmapMode } from "./profileHeatmap";
import "./Profile.css";

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

export default function Profile({
  account,
  language,
  onRefreshAccount,
  accountLoading = false,
  accountError = "",
}: {
  account: NewApiAccount | null;
  language: Language;
  onRefreshAccount?: () => Promise<void>;
  accountLoading?: boolean;
  accountError?: string;
}) {
  const copy = SETTINGS_COPY[language].profile;
  const backendAvailable = hasNativeBackend();
  const verifiedAccount = backendAvailable ? account : null;
  const avatar = useProfileAvatar();
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const heatmapScrollRef = useRef<HTMLDivElement | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [stats, setStats] = useState<ProfileStats | null>(null);
  const [statsUnavailable, setStatsUnavailable] = useState(!backendAvailable);
  const [statsLoading, setStatsLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [mode, setMode] = useState<HeatmapMode>("daily");

  useEffect(() => {
    if (!backendAvailable) {
      setStats(null);
      setStatsUnavailable(true);
      return;
    }
    let alive = true;
    let inFlight = false;
    const refresh = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      setStatsLoading(true);
      try {
        const next = await profileStats();
        if (alive) {
          setStats(next);
          setStatsUnavailable(false);
          setUpdatedAt(new Date());
        }
      } catch {
        if (alive) setStatsUnavailable(true);
      } finally {
        inFlight = false;
        if (alive) setStatsLoading(false);
      }
    };
    void refresh();
    const refreshVisible = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(refreshVisible, 30_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [backendAvailable, refreshVersion]);

  const refreshAll = () => {
    setRefreshVersion((value) => value + 1);
    void onRefreshAccount?.();
  };

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

  const heatmap = useMemo(() => (stats ? buildProfileHeatmap(stats.daily, mode, stats.cumulativeTokens) : null), [stats, mode]);
  const hasActivity = Boolean(stats && (mode === "cumulative" ? stats.cumulativeTokens > 0 : stats.daily.some((bucket) => bucket.tokens > 0)));
  const heatmapStart = heatmap?.[0]?.[0]?.date;

  useLayoutEffect(() => {
    const element = heatmapScrollRef.current;
    if (!element) return;
    const showLatest = () => { element.scrollLeft = Math.max(0, element.scrollWidth - element.clientWidth); };
    showLatest();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(showLatest);
    observer?.observe(element);
    window.addEventListener("resize", showLatest);
    return () => { observer?.disconnect(); window.removeEventListener("resize", showLatest); };
  }, [hasActivity, heatmapStart]);

  const displayName = verifiedAccount?.displayName || verifiedAccount?.username || copy.signedOut;
  const handle = verifiedAccount?.username ? `@${verifiedAccount.username}` : "";
  const plan = verifiedAccount?.subscriptionName || verifiedAccount?.group || "";

  const tiles = stats
    ? [
        { label: copy.statCumulative, value: formatTokens(stats.cumulativeTokens, language, copy), detail: `${stats.cumulativeTokens.toLocaleString()} ${copy.tokenUnit}` },
        { label: copy.statPeak, value: formatTokens(stats.peakDailyTokens, language, copy), detail: `${stats.peakDailyTokens.toLocaleString()} ${copy.tokenUnit}` },
        { label: copy.statLongestTask, value: formatDuration(stats.longestTaskSeconds, copy.unavailable, copy), detail: copy.taskDurationHint },
        { label: copy.statCurrentStreak, value: copy.days(stats.currentStreak), detail: copy.utcDays },
        { label: copy.statLongestStreak, value: copy.days(stats.longestStreak), detail: copy.utcDays },
      ]
    : [];

  return (
    <div className="sp-profile">
      <div className="sp-profile-data-head">
        <div>
          <span>{copy.localScope}</span>
          {updatedAt && <span className="sp-profile-updated">{copy.updatedAt(updatedAt.toLocaleTimeString(language === "cn" ? "zh-CN" : "en-US"))}</span>}
        </div>
        {backendAvailable && <button type="button" className="sp-profile-refresh" onClick={refreshAll} disabled={statsLoading || accountLoading}>
          {statsLoading || accountLoading ? copy.refreshing : copy.refresh}
        </button>}
      </div>
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
      {accountError && <div className="sp-profile-unavailable" role="alert">{copy.accountRefreshFailed} {accountError}</div>}

      {statsUnavailable && <div className="sp-profile-unavailable" role="status">{stats ? copy.statsRefreshFailed : copy.statsUnavailable}</div>}
      {!stats && !statsUnavailable ? (
        <div className="sp-profile-loading">{copy.loading}</div>
      ) : stats ? (
        <>
          {stats.partialData && <div className="sp-profile-unavailable" role="status">{copy.partialData}</div>}
          <div className="sp-profile-tiles">
            {tiles.map((tile) => (
              <div className="sp-profile-tile" key={tile.label} title={tile.detail}>
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
                <div className="sp-profile-heatmap-scroll" ref={heatmapScrollRef} tabIndex={0} role="region" aria-label={copy.activityTitle}>
                  <div className="sp-profile-heatmap" role="img" aria-label={`${copy.activityTitle} · ${copy.utcDays}`}>
                    {heatmap.map((week, weekIndex) => (
                      <div className="sp-profile-heatmap-week" key={weekIndex}>
                        {week.map((cell) => (
                          <span
                            key={cell.date}
                            className="sp-profile-heatmap-cell"
                            data-level={cell.level}
                            data-future={cell.future || undefined}
                            title={cell.future ? undefined : `${mode === "weekly" ? `${week[0].date} – ${cell.endDate}` : cell.date} · ${cell.tokens.toLocaleString(language === "cn" ? "zh-CN" : "en-US")} ${copy.tokenUnit}`}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
            ) : (
              <div className="sp-profile-empty">{copy.activityEmpty}</div>
            )}
            <div className="sp-profile-activity-foot sp-profile-activity-summary">
              <span>{copy.utcDays}{stats.since !== null && ` · ${copy.activitySince(new Date(stats.since * 1000).toISOString().slice(0, 10))}`}</span>
              <span className="sp-profile-legend">{copy.less}{[0, 1, 2, 3, 4].map((level) => <i key={level} className="sp-profile-heatmap-cell" data-level={level} />)}{copy.more}</span>
            </div>
          </section>

          <div className="sp-profile-columns">
            <section className="sp-profile-insights">
              <div className="sp-profile-section-title">{copy.insightsTitle}</div>
              <div className="sp-profile-insight-row">
                <span>{copy.insightTurns}</span><strong>{stats.totalTurns.toLocaleString()}</strong>
              </div>
              <div className="sp-profile-insight-row">
                <span>{copy.insightDays}</span><strong>{copy.days(stats.activeDays)}</strong>
              </div>
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
          <section className="sp-profile-models">
            <div className="sp-profile-section-title">{copy.modelsTitle}</div>
            <div className="sp-profile-meta-hint">{copy.modelsHint}</div>
            {stats.byModel.length > 0 ? <div className="sp-profile-model-list">
              {stats.byModel.map((model) => <div className="sp-profile-model-row" key={`${model.provider}:${model.model}`}>
                <div><strong>{model.model}</strong><span>{model.provider} · {copy.modelTurns(model.turns)}</span></div>
                <div className="sp-profile-model-meter"><span style={{ width: `${Math.min(100, model.tokens / Math.max(1, stats.cumulativeTokens) * 100)}%` }} /></div>
                <span title={model.tokens.toLocaleString()}>{formatTokens(model.tokens, language, copy)} {copy.tokenUnit}</span>
              </div>)}
            </div> : <div className="sp-profile-empty">{copy.modelsEmpty}</div>}
          </section>
        </>
      ) : null}
    </div>
  );
}
