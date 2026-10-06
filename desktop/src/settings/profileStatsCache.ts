import { profileStats } from "../api/tauri";
import type { ProfileStats } from "../types";

export const PROFILE_STATS_CACHE_KEY = "somniq-profile-stats-v1";
export const PROFILE_STATS_REFRESH_MS = 30_000;

interface CachedProfileStats {
  stats: ProfileStats;
  updatedAt: number;
}

// Device-wide statistics survive settings unmounts and app restarts. Keep only
// the aggregate returned by the backend, never session content or account data.
let memorySnapshot: CachedProfileStats | null = null;
let pendingRequest: Promise<ProfileStats> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isProfileStats(value: unknown): value is ProfileStats {
  if (!isRecord(value)) return false;
  return ["cumulativeTokens", "peakDailyTokens", "totalTurns", "activeDays",
    "currentStreak", "longestStreak", "skillsExplored", "toolCalls"].every((key) => isCount(value[key]))
    && (value.longestTaskSeconds === null || isCount(value.longestTaskSeconds))
    && (value.since === null || isCount(value.since))
    && (value.topReasoningEffort === null || typeof value.topReasoningEffort === "string")
    && typeof value.metaLoggingEnabled === "boolean"
    && (value.partialData === undefined || typeof value.partialData === "boolean")
    && Array.isArray(value.daily) && value.daily.every((bucket) => isRecord(bucket)
      && typeof bucket.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bucket.date)
      && isCount(bucket.tokens) && isCount(bucket.turns))
    && Array.isArray(value.byModel) && value.byModel.every((model) => isRecord(model)
      && typeof model.model === "string" && typeof model.provider === "string"
      && isCount(model.tokens) && isCount(model.turns))
    && Array.isArray(value.topSkills) && value.topSkills.every((skill) => isRecord(skill)
      && typeof skill.name === "string" && isCount(skill.runs));
}

export function readCachedProfileStats(): CachedProfileStats | null {
  if (memorySnapshot) return memorySnapshot;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PROFILE_STATS_CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const snapshot: unknown = JSON.parse(raw);
    memorySnapshot = isRecord(snapshot) && isCount(snapshot.updatedAt) && isProfileStats(snapshot.stats)
      ? { stats: snapshot.stats, updatedAt: snapshot.updatedAt } : null;
  } catch {
    memorySnapshot = null;
  }
  return memorySnapshot;
}

export function writeCachedProfileStats(snapshot: CachedProfileStats | null): void {
  memorySnapshot = snapshot;
  try {
    if (snapshot) window.localStorage.setItem(PROFILE_STATS_CACHE_KEY, JSON.stringify(snapshot));
    else window.localStorage.removeItem(PROFILE_STATS_CACHE_KEY);
  } catch {
    // A full or disabled local store still leaves an in-memory snapshot.
  }
}

export function refreshProfileStats(): Promise<ProfileStats> {
  // A request remains shared even if its original page unmounts (or React
  // replays its effect). Its result still warms the cache for the next visit.
  if (pendingRequest) return pendingRequest;
  const snapshot = readCachedProfileStats();
  const age = snapshot ? Date.now() - snapshot.updatedAt : Infinity;
  if (snapshot && age >= 0 && age < PROFILE_STATS_REFRESH_MS) return Promise.resolve(snapshot.stats);
  pendingRequest = profileStats().then((stats) => {
    writeCachedProfileStats({ stats, updatedAt: Date.now() });
    return stats;
  }).finally(() => { pendingRequest = null; });
  return pendingRequest;
}
