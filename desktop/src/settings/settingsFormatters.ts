import type { Language } from "../store";
import type { NewApiAccount } from "../api/tauri";
import { epochToDate } from "../timestamp";
import { ADMIN_ACCOUNT_CONTAINS_MARKERS, ADMIN_ACCOUNT_EXACT_MARKERS, SETTINGS_COPY } from "./i18n";

export function normalizeLanguage(value: string | null | undefined): Language {
  return value === "en" ? "en" : "cn";
}

export function formatQuota(credits: number): string {
  return `$${(credits / 500000).toFixed(2)}`;
}

export function quotaPercent(account: NewApiAccount): number {
  const total = account.quota + account.usedQuota;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.round((account.usedQuota / total) * 100));
}

export function subscriptionQuotaPercent(account: NewApiAccount): number {
  const used = account.subscriptionUsedQuota ?? 0;
  const remaining = account.subscriptionQuota ?? 0;
  const total = used + remaining;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

export function isAdminAccount(account: NewApiAccount | null): boolean {
  if (!account) return false;
  if (account.isAdmin === true) return true;
  if (typeof account.role === "number" && account.role >= 10) return true;
  const markers = [account.group, account.groupDesc, account.subscriptionName, account.subscriptionDesc];
  return markers.some((value) => {
    const text = value?.trim();
    if (!text) return false;
    const lower = text.toLowerCase();
    return ADMIN_ACCOUNT_EXACT_MARKERS.some((marker) => lower === marker)
      || ADMIN_ACCOUNT_CONTAINS_MARKERS.some((marker) => text.includes(marker));
  });
}

export function formatUpdateBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatUsageExact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return Math.round(value).toLocaleString();
}

export function formatUsageDate(value: number): string {
  const date = epochToDate(value);
  if (!date) return "-";
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortUsageId(value: string): string {
  const text = value.trim();
  if (!text) return "-";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

export function usageLogMeta(status: string, typeLabel: string, language: Language): string {
  const copy = SETTINGS_COPY[language].general;
  const normalizedStatus = status.trim().toLowerCase();
  const statusLabel = normalizedStatus === "success"
    ? copy.usageStatusSuccess
    : normalizedStatus === "failed" || normalizedStatus === "error"
      ? copy.usageStatusFailed
      : status.trim();
  const normalizedType = typeLabel.trim().toLowerCase();
  const type = normalizedType === "consume" ? copy.usageTypeConsume : typeLabel.trim();
  return [type, statusLabel].filter(Boolean).join(" · ");
}
