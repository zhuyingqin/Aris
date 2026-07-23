import { useEffect, useMemo, useState } from "react";
import { isTauri, profileStats, type NewApiAccount } from "../api/tauri";
import type { ProfileStats } from "../types";
import type { Language } from "../store";

type HeatmapMode = "daily" | "weekly" | "cumulative";

const PROFILE_COPY: Record<Language, {
  signedOut: string;
  signedOutSub: string;
  plan: string;
  share: string;
  privateLabel: string;
  edit: string;
  statCumulative: string;
  statPeak: string;
  statLongestTask: string;
  statCurrentStreak: string;
  statLongestStreak: string;
  tokenUnit: string;
  days: (n: number) => string;
  activityTitle: string;
  modeDaily: string;
  modeWeekly: string;
  modeCumulative: string;
  activityEmpty: string;
  activitySince: (date: string) => string;
  insightsTitle: string;
  insightFastMode: string;
  insightReasoning: string;
  insightSkills: string;
  insightTools: string;
  topSkillsTitle: string;
  topSkillsEmpty: string;
  runs: (n: number) => string;
  accruing: string;
  metaHint: string;
  loading: string;
}> = {
  cn: {
    signedOut: "未登录",
    signedOutSub: "登录后显示个人资料与活动统计。",
    plan: "套餐",
    share: "分享",
    privateLabel: "私有",
    edit: "编辑",
    statCumulative: "累计 Token 数",
    statPeak: "峰值 Token 数",
    statLongestTask: "最长任务时长",
    statCurrentStreak: "当前连续天数",
    statLongestStreak: "最长连续天数",
    tokenUnit: "Token",
    days: (n) => `${n} 天`,
    activityTitle: "Token 活动",
    modeDaily: "每日",
    modeWeekly: "每周",
    modeCumulative: "累计",
    activityEmpty: "还没有活动记录，用几次对话后这里会显示 Token 活跃热力图。",
    activitySince: (date) => `自 ${date} 起`,
    insightsTitle: "活动洞察",
    insightFastMode: "快速模式",
    insightReasoning: "最常用的推理强度",
    insightSkills: "已探索的技能",
    insightTools: "工具调用",
    topSkillsTitle: "最常用的插件",
    topSkillsEmpty: "尚无技能调用记录。",
    runs: (n) => `${n} 次运行`,
    accruing: "累积中",
    metaHint: "开启元数据日志后统计更完整",
    loading: "加载中…",
  },
  en: {
    signedOut: "Not signed in",
    signedOutSub: "Sign in to show your profile and activity stats.",
    plan: "Plan",
    share: "Share",
    privateLabel: "Private",
    edit: "Edit",
    statCumulative: "Cumulative tokens",
    statPeak: "Peak tokens",
    statLongestTask: "Longest task",
    statCurrentStreak: "Current streak",
    statLongestStreak: "Longest streak",
    tokenUnit: "tokens",
    days: (n) => `${n} d`,
    activityTitle: "Token activity",
    modeDaily: "Daily",
    modeWeekly: "Weekly",
    modeCumulative: "Cumulative",
    activityEmpty: "No activity yet — run a few chats and your Token heatmap will appear here.",
    activitySince: (date) => `Since ${date}`,
    insightsTitle: "Activity insights",
    insightFastMode: "Fast mode",
    insightReasoning: "Top reasoning effort",
    insightSkills: "Skills explored",
    insightTools: "Tool calls",
    topSkillsTitle: "Most used plugins",
    topSkillsEmpty: "No skill invocations recorded yet.",
    runs: (n) => `${n} runs`,
    accruing: "Accruing",
    metaHint: "Enable metadata logging for fuller stats",
    loading: "Loading…",
  },
};

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

function formatTokens(value: number, language: Language): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (language === "cn") {
    if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e9 ? 0 : 1)}亿`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e6 ? 0 : 1)}万`;
    return Math.round(value).toLocaleString();
  }
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString();
}

function formatDuration(seconds: number | null, language: Language, accruing: string): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return accruing;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (language === "cn") {
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    if (minutes > 0) return `${minutes} 分`;
    return `${Math.round(seconds)} 秒`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.round(seconds)}s`;
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
  const copy = PROFILE_COPY[language];
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
        { label: copy.statCumulative, value: formatTokens(stats.cumulativeTokens, language) },
        { label: copy.statPeak, value: formatTokens(stats.peakDailyTokens, language) },
        { label: copy.statLongestTask, value: formatDuration(stats.longestTaskSeconds, language, copy.accruing) },
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
                          title={`${cell.date} · ${formatTokens(cell.tokens, language)} ${copy.tokenUnit}`}
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
