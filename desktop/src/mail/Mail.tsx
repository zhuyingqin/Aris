import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type UIEvent,
} from "react";
import arisIcon from "../assets/app-logo.png";
import avatarManBlue from "../assets/mail/avatar-man-blue-shirt.png";
import avatarWomanBlazer from "../assets/mail/avatar-woman-navy-blazer.png";
import avatarManNavy from "../assets/mail/avatar-man-navy-sweater.png";
import avatarWomanPeach from "../assets/mail/avatar-woman-peach.png";
import {
  mailAccountsGet,
  mailFolders,
  mailList,
  mailModify,
  mailRead,
  mailSend,
  onMailNewMessage,
  isTauri,
} from "../api/tauri";
import { useStore } from "../store";
import type { Language } from "../store";
import type {
  MailAccount,
  MailDraft,
  MailFolder,
  MailMessageFull,
  MailMessageSummary,
} from "../types";
import { MAIL_INBOX_COPY, type MailCopy } from "./i18n";
import "./Mail.css";

const FOLDER_ORDER = [
  "inbox",
  "important",
  "starred",
  "sent",
  "drafts",
  "archive",
  "spam",
  "trash",
  "promotions",
  "social",
  "updates",
  "forums",
  "custom",
];

const SYSTEM_LABELS = new Set([
  "INBOX",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
  "SENT",
  "DRAFT",
  "TRASH",
  "SPAM",
  "CATEGORY_PERSONAL",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);

type IconName =
  | "archive"
  | "back"
  | "bell"
  | "bot"
  | "calendar"
  | "check"
  | "chevronDown"
  | "chevronLeft"
  | "chevronRight"
  | "clock"
  | "close"
  | "drafts"
  | "edit"
  | "file"
  | "filter"
  | "forward"
  | "help"
  | "inbox"
  | "label"
  | "markUnread"
  | "more"
  | "paperclip"
  | "refresh"
  | "reply"
  | "replyAll"
  | "search"
  | "send"
  | "settings"
  | "sparkle"
  | "spam"
  | "star"
  | "starOutline"
  | "trash";

const ICON_PATHS: Record<IconName, string> = {
  archive:
    "M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM5.12 5l.82-1h12l.93 1H5.12zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5z",
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  bell:
    "M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z",
  bot:
    "M12 2a2 2 0 0 1 2 2v1h3a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3h3V4a2 2 0 0 1 2-2zm-4 9.5A1.5 1.5 0 1 0 8 8.5a1.5 1.5 0 0 0 0 3zm8 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM8.5 15h7v-2h-7v2z",
  calendar:
    "M7 2h2v2h6V2h2v2h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3V2zm13 8H4v10h16V10z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z",
  chevronDown: "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z",
  chevronLeft: "M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12l4.58-4.59z",
  chevronRight: "M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z",
  clock:
    "M12 2a10 10 0 1 0 .01 0H12zm1 5v5.2l4.2 2.5-1 1.65-5.2-3.1V7h2z",
  close:
    "M18.3 5.71 12 12l6.3 6.29-1.41 1.41L10.59 13.41 4.29 19.71 2.88 18.3 9.17 12 2.88 5.71 4.29 4.29l6.3 6.3 6.29-6.3 1.42 1.42z",
  drafts:
    "M21.99 8c0-.72-.37-1.35-.94-1.7L12 1 2.95 6.3C2.38 6.65 2 7.28 2 8v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2L21.99 8zM12 13 3.74 7.84 12 3l8.26 4.84L12 13z",
  edit:
    "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  file:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z",
  filter:
    "M3 5h18v2H3V5zm4 6h10v2H7v-2zm3 6h4v2h-4v-2z",
  forward:
    "M12 8V4l8 8-8 8v-4H4v-8h8z",
  help:
    "M11 18h2v-2h-2v2zm1-16a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm0-14a3.5 3.5 0 0 0-3.5 3.5h2A1.5 1.5 0 1 1 12 11c-1.1 0-2 .9-2 2v1h2v-1c0-.55.45-1 1-1a3 3 0 0 0-1-6z",
  inbox:
    "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14v10z",
  label:
    "M17.63 5.84C17.27 5.33 16.67 5 16 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11c.67 0 1.27-.33 1.63-.84L22 12l-4.37-6.16z",
  markUnread:
    "M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z",
  more:
    "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  paperclip:
    "M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6h-1.5z",
  refresh:
    "M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 16.22 7.78L13 11h7V4l-2.35 2.35z",
  reply:
    "M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
  replyAll:
    "M7 9V5l-7 7 7 7v-4.2c3.2 0 5.8.8 8 2.8C14.2 13.1 11.5 9.5 7 9zm6 0V5l7 7-7 7v-4.1c-1.1 0-2.1.08-3 .25V13.1c.9-.07 1.9-.1 3-.1z",
  search:
    "M9.5 3a6.5 6.5 0 0 1 5.17 10.44l.28.27h.79l5 4.99-1.5 1.5-4.99-5v-.79l-.27-.28A6.5 6.5 0 1 1 9.5 3zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z",
  send: "M2 21 23 12 2 3v7l15 2-15 2v7z",
  settings:
    "M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65-2-3.46-2.49 1a7.28 7.28 0 0 0-1.69-.98L15 3h-4l-.36 2.93c-.6.23-1.16.56-1.69.98l-2.49-1-2 3.46 2.11 1.65c-.04.32-.07.65-.07.98s.02.66.07.98l-2.11 1.65 2 3.46 2.49-1c.53.41 1.09.74 1.69.98L11 21h4l.36-2.93c.6-.23 1.16-.56 1.69-.98l2.49 1 2-3.46-2.11-1.65zM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5z",
  sparkle:
    "M12 2 9.7 8.1 3.5 10.4l6.2 2.3L12 19l2.3-6.3 6.2-2.3-6.2-2.3L12 2zm-7 13-1 2.7L1.3 19l2.7 1 1 2.7 1-2.7 2.7-1-2.7-1L5 15zm14 1-1.2 3.2-3.2 1.2 3.2 1.2L19 25l1.2-3.4 3.2-1.2-3.2-1.2L19 16z",
  spam:
    "M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27L15.73 3zM11 7h2v6h-2V7zm1 10.3a1.3 1.3 0 1 1 0-2.6 1.3 1.3 0 0 1 0 2.6z",
  star: "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27z",
  starOutline:
    "m22 9.24-7.19-.62L12 2 9.19 8.62 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z",
  trash:
    "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8 4l1-1h6l1 1h3v2H5V4h3z",
};

function navFallbacks(
  copy: MailCopy,
): Array<{ id: string; kind: string; name: string; unreadCount: number }> {
  return [
    { id: "INBOX", kind: "inbox", name: copy.folderLabels.inbox, unreadCount: 0 },
    { id: "sent", kind: "sent", name: copy.folderLabels.sent, unreadCount: 0 },
    { id: "drafts", kind: "drafts", name: copy.folderLabels.drafts, unreadCount: 0 },
    { id: "archive", kind: "archive", name: copy.folderLabels.archive, unreadCount: 0 },
    { id: "spam", kind: "spam", name: copy.folderLabels.spam, unreadCount: 0 },
  ];
}

const AVATAR_COLORS = [
  "#2563eb",
  "#7c3aed",
  "#059669",
  "#ea580c",
  "#dc2626",
  "#0f766e",
  "#9333ea",
  "#0284c7",
];

const AVATAR_IMAGES = [avatarManBlue, avatarWomanBlazer, avatarManNavy, avatarWomanPeach];

interface ComposeState {
  to: string;
  cc: string;
  subject: string;
  body: string;
}

const EMPTY_COMPOSE: ComposeState = { to: "", cc: "", subject: "", body: "" };

const PREVIEW_ACCOUNT_ID = "preview-account";
const PREVIEW_ACCOUNT_EMAIL = "preview.mail@aris.local";

function previewAccount(copy: MailCopy): MailAccount {
  return {
    id: PREVIEW_ACCOUNT_ID,
    provider: "imap",
    email: PREVIEW_ACCOUNT_EMAIL,
    displayName: copy.demo.accountDisplayName,
    connected: true,
  };
}

function previewFolders(copy: MailCopy): MailFolder[] {
  return [
    { id: "INBOX", kind: "inbox", name: copy.folderLabels.inbox, unreadCount: 3 },
    { id: "sent", kind: "sent", name: copy.folderLabels.sent, unreadCount: 0 },
    { id: "drafts", kind: "drafts", name: copy.folderLabels.drafts, unreadCount: 1 },
    { id: "archive", kind: "archive", name: copy.folderLabels.archive, unreadCount: 0 },
    { id: "trash", kind: "trash", name: copy.folderLabels.trash, unreadCount: 0 },
    { id: "important", kind: "important", name: copy.folderLabels.important, unreadCount: 1 },
  ];
}

interface MailViewCache {
  accounts: MailAccount[];
  accountId: string;
  folders: MailFolder[];
  folder: string;
  messages: MailMessageSummary[];
  nextPageToken: string | null;
  selectedId: string;
  open: MailMessageFull | null;
  query: string;
  searchInput: string;
  listKey: string;
  assistantOpen: boolean;
}

const MAIL_VIEW_CACHE: MailViewCache = {
  accounts: [],
  accountId: "",
  folders: [],
  folder: "INBOX",
  messages: [],
  nextPageToken: null,
  selectedId: "",
  open: null,
  query: "",
  searchInput: "",
  listKey: "",
  assistantOpen: true,
};

function mailListKey(accountId: string, folder: string, query: string): string {
  return `${accountId}\n${folder}\n${query.trim()}`;
}

function previewMessagesFor(folder: string, query: string, copy: MailCopy): MailMessageSummary[] {
  const lowerQuery = query.trim().toLowerCase();
  if (folder !== "INBOX" && folder !== "important") return [];
  return copy.demo.messages.filter((message) => {
    const inFolder = folder !== "important" || message.labels.includes(copy.demo.importantLabel);
    const matchesQuery =
      !lowerQuery ||
      `${message.fromName} ${message.from} ${message.subject} ${message.snippet}`
        .toLowerCase()
        .includes(lowerQuery);
    return inFolder && matchesQuery;
  });
}

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="currentColor">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

function folderRank(kind: string): number {
  const index = FOLDER_ORDER.indexOf(kind);
  return index === -1 ? FOLDER_ORDER.length : index;
}

function formatDate(raw: string, language: Language): string {
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  const locale = language === "en" ? "en-US" : "zh-CN";
  const now = new Date();
  if (parsed.toDateString() === now.toDateString()) {
    return parsed.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  }
  if (parsed.getFullYear() === now.getFullYear()) {
    return parsed.toLocaleDateString(locale, { month: "short", day: "numeric" });
  }
  return parsed.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Epoch ms for chronological sorting; unparseable dates sink to the bottom. */
function messageTime(message: MailMessageSummary): number {
  const ms = Date.parse(message.date);
  return Number.isNaN(ms) ? 0 : ms;
}

const PANE_MIN = 220;
const PANE_MAX = 480;
const MAIL_LIST_WIDTH_KEY = "somniq-mail-list-width";
const MAIL_LIST_WIDTH_LEGACY_KEY = "aris-mail-list-width";
const MAIL_ASSISTANT_WIDTH_KEY = "somniq-mail-assistant-width";
const MAIL_ASSISTANT_WIDTH_LEGACY_KEY = "aris-mail-assistant-width";

function clampPane(value: number): number {
  return Math.min(PANE_MAX, Math.max(PANE_MIN, value));
}

function readStoredWidth(key: string, legacyKey: string, fallback: number): number {
  if (typeof localStorage === "undefined") return fallback;
  const raw = Number(localStorage.getItem(key) ?? localStorage.getItem(legacyKey));
  return Number.isFinite(raw) && raw > 0 ? clampPane(raw) : fallback;
}

/**
 * Thin draggable divider between workspace panes. Adjusts a pixel width
 * anchored at drag start; `invert` is used for the right-hand assistant pane,
 * where dragging left should *grow* it.
 */
function PaneResizer({
  value,
  invert = false,
  onChange,
  className = "",
  label,
}: {
  value: number;
  invert?: boolean;
  onChange: (next: number) => void;
  className?: string;
  label: string;
}) {
  const drag = useRef<{ startX: number; startValue: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    drag.current = { startX: event.clientX, startValue: value };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("am-resizing");
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = event.clientX - drag.current.startX;
    onChange(clampPane(drag.current.startValue + (invert ? -delta : delta)));
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    document.body.classList.remove("am-resizing");
  };

  return (
    <div
      className={`am-pane-resizer ${className}`.trim()}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    />
  );
}

function folderMeta(folder: MailFolder, copy: MailCopy): { label: string; icon: IconName } {
  const raw = folder.name.replace(/^\[Gmail\][\\/]?/i, "").trim();
  // User-created labels (Gmail surfaces these with kind "custom") keep their
  // own name. Only system folders get normalized to localized labels —
  // otherwise distinct user labels like "归档", "工作归档", "Archive" all
  // collapse onto a single "已归档" entry in the sidebar.
  if (folder.kind === "custom") {
    return { label: raw || folder.name, icon: "label" };
  }
  const key = `${folder.kind} ${raw}`.toLowerCase();
  if (/inbox|\u6536\u4ef6/.test(key)) return { label: copy.folderLabels.inbox, icon: "inbox" };
  if (/sent|\u5df2\u53d1\u9001|\u53d1\u4ef6/.test(key)) return { label: copy.folderLabels.sent, icon: "send" };
  if (/draft|\u8349\u7a3f/.test(key)) return { label: copy.folderLabels.drafts, icon: "drafts" };
  if (/archive|\u5f52\u6863|all mail|\u6240\u6709\u90ae\u4ef6/.test(key)) return { label: copy.folderLabels.archive, icon: "archive" };
  if (/spam|junk|\u5783\u573e/.test(key)) return { label: copy.folderLabels.spam, icon: "spam" };
  if (/trash|deleted|bin|\u5df2\u5220\u9664/.test(key)) return { label: copy.folderLabels.trash, icon: "trash" };
  if (/starred|\u661f\u6807/.test(key)) return { label: copy.folderLabels.starred, icon: "star" };
  if (/important|\u91cd\u8981/.test(key)) return { label: copy.folderLabels.important, icon: "label" };
  return { label: raw || folder.name, icon: "label" };
}

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function avatarImage(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_IMAGES[Math.abs(hash) % AVATAR_IMAGES.length];
}

function initial(name: string, email: string): string {
  const source = (name || email || "?").trim();
  return source.charAt(0).toUpperCase();
}

/** Round avatar that shows a deterministic photo with an initial fallback. */
function Avatar({
  seed,
  label,
  className,
  title,
}: {
  seed: string;
  label: string;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={`am-avatar am-avatar-image${className ? ` ${className}` : ""}`}
      style={{ background: avatarColor(seed) }}
      title={title}
    >
      <span>{label}</span>
      <img src={avatarImage(seed)} alt="" loading="lazy" decoding="async" />
    </span>
  );
}

function initialsFromAccount(account?: MailAccount): string {
  if (!account) return "?";
  return initial(account.displayName, account.email);
}

function unreadTotal(folders: MailFolder[]): number {
  return folders.reduce((sum, item) => sum + Math.max(0, item.unreadCount), 0);
}

function visibleLabels(labels: string[]): string[] {
  return labels
    .filter((label) => {
      const value = label.trim();
      return (
        value &&
        !value.startsWith("\\") &&
        !/^Label_\d+$/i.test(value) &&
        !SYSTEM_LABELS.has(value.toUpperCase()) &&
        !value.startsWith("CATEGORY_")
      );
    })
    .slice(0, 3);
}

function attachmentKind(filename: string, mimeType: string): "pdf" | "sheet" | "file" {
  const value = `${filename} ${mimeType}`.toLowerCase();
  if (value.includes("pdf")) return "pdf";
  if (value.includes("spreadsheet") || /\.(xls|xlsx|csv)\b/.test(value)) return "sheet";
  return "file";
}

function prettySize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function cleanSubject(subject?: string | null): string {
  const value = (subject ?? "").trim();
  return looksLikeMailArtifact(value) ? "" : value;
}

function looksLikeMailArtifact(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  return (
    /^(content-type|content-transfer-encoding|mime-version|received|--[-=_])/i.test(text) ||
    /^[-_]{2,}=_/i.test(text) ||
    /^w2lt[a-z0-9+/_=-]{12,}/i.test(text) ||
    /^[a-z0-9+/_=-]{28,}$/i.test(text)
  );
}

function cleanSnippet(snippet?: string | null): string {
  const value = (snippet ?? "").trim();
  return looksLikeMailArtifact(value) ? "" : value;
}

function replySubject(message: MailMessageFull, copy: MailCopy): string {
  const subject = fullTitle(message, copy);
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function forwardSubject(message: MailMessageFull, copy: MailCopy): string {
  const subject = fullTitle(message, copy);
  return /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

function quotedBody(message: MailMessageFull, copy: MailCopy, language: Language): string {
  const sender = message.fromName || message.from;
  const body = message.bodyText || copy.noBodyText;
  return copy.quotedBodyTemplate(
    sender,
    message.from,
    formatDate(message.date, language),
    fullTitle(message, copy),
    body,
  );
}

function summaryTitle(message: MailMessageSummary, copy: MailCopy): string {
  return cleanSubject(message.subject) || cleanSnippet(message.snippet) || copy.noTitleMail;
}

function fullTitle(message: MailMessageFull, copy: MailCopy): string {
  return cleanSubject(message.subject) || copy.noTitleMail;
}

export default function Mail() {
  const setGlobalError = useStore((s) => s.setError);
  const setTab = useStore((s) => s.setTab);
  const language = useStore((s) => s.language);
  const copy = MAIL_INBOX_COPY[language];
  const previewMode = !isTauri();

  if (previewMode && MAIL_VIEW_CACHE.accounts.length === 0) {
    MAIL_VIEW_CACHE.accounts = [previewAccount(copy)];
    MAIL_VIEW_CACHE.accountId = PREVIEW_ACCOUNT_ID;
    MAIL_VIEW_CACHE.folders = previewFolders(copy);
    MAIL_VIEW_CACHE.folder = "INBOX";
    MAIL_VIEW_CACHE.messages = previewMessagesFor("INBOX", "", copy);
    MAIL_VIEW_CACHE.listKey = mailListKey(PREVIEW_ACCOUNT_ID, "INBOX", "");
  }

  const [accounts, setAccounts] = useState<MailAccount[]>(() =>
    previewMode && MAIL_VIEW_CACHE.accounts.length === 0
      ? [previewAccount(copy)]
      : MAIL_VIEW_CACHE.accounts,
  );
  const [accountId, setAccountId] = useState(() =>
    previewMode && !MAIL_VIEW_CACHE.accountId ? PREVIEW_ACCOUNT_ID : MAIL_VIEW_CACHE.accountId,
  );
  const [folders, setFolders] = useState<MailFolder[]>(() =>
    previewMode && MAIL_VIEW_CACHE.folders.length === 0
      ? previewFolders(copy)
      : MAIL_VIEW_CACHE.folders,
  );
  const [folder, setFolder] = useState(() => MAIL_VIEW_CACHE.folder || "INBOX");
  const [messages, setMessages] = useState<MailMessageSummary[]>(() => {
    if (MAIL_VIEW_CACHE.messages.length > 0) return MAIL_VIEW_CACHE.messages;
    return previewMode
      ? previewMessagesFor(MAIL_VIEW_CACHE.folder || "INBOX", MAIL_VIEW_CACHE.query, copy)
      : [];
  });
  const [nextPageToken, setNextPageToken] = useState<string | null>(() => MAIL_VIEW_CACHE.nextPageToken);
  const [selectedId, setSelectedId] = useState(() => MAIL_VIEW_CACHE.selectedId);
  const [open, setOpen] = useState<MailMessageFull | null>(() => MAIL_VIEW_CACHE.open);
  const [query, setQuery] = useState(() => MAIL_VIEW_CACHE.query);
  const [searchInput, setSearchInput] = useState(() => MAIL_VIEW_CACHE.searchInput);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(
    !previewMode && MAIL_VIEW_CACHE.accounts.length === 0,
  );
  const [error, setError] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [sending, setSending] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(() => MAIL_VIEW_CACHE.assistantOpen);
  const [listWidth, setListWidth] = useState(() => readStoredWidth(MAIL_LIST_WIDTH_KEY, MAIL_LIST_WIDTH_LEGACY_KEY, 300));
  const [assistantWidth, setAssistantWidth] = useState(() =>
    readStoredWidth(MAIL_ASSISTANT_WIDTH_KEY, MAIL_ASSISTANT_WIDTH_LEGACY_KEY, 260),
  );
  const listLoadingRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(MAIL_LIST_WIDTH_KEY, String(listWidth));
    localStorage.removeItem(MAIL_LIST_WIDTH_LEGACY_KEY);
  }, [listWidth]);
  useEffect(() => {
    localStorage.setItem(MAIL_ASSISTANT_WIDTH_KEY, String(assistantWidth));
    localStorage.removeItem(MAIL_ASSISTANT_WIDTH_LEGACY_KEY);
  }, [assistantWidth]);

  const connected = useMemo(() => accounts.filter((account) => account.connected), [accounts]);
  const activeAccount = connected.find((account) => account.id === accountId) ?? connected[0];
  const sortedFolders = useMemo(() => {
    const source = folders.length > 0 ? folders : (navFallbacks(copy) as MailFolder[]);
    return [...source].sort((a, b) => folderRank(a.kind) - folderRank(b.kind));
  }, [folders, copy]);
  const activeFolder = useMemo(
    () => sortedFolders.find((item) => item.id === folder),
    [folder, sortedFolders],
  );
  // Providers (and pagination across pages) don't guarantee a chronological
  // list, and the shown date is the sender's Date header. Sort newest-first by
  // that same displayed date so the visible order matches the visible times.
  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => messageTime(b) - messageTime(a)),
    [messages],
  );
  const fail = useCallback((e: unknown) => setError(String(e)), []);

  useEffect(() => {
    listLoadingRef.current = loadingList;
  }, [loadingList]);

  useEffect(() => {
    MAIL_VIEW_CACHE.accounts = accounts;
    MAIL_VIEW_CACHE.accountId = accountId;
    MAIL_VIEW_CACHE.folders = folders;
    MAIL_VIEW_CACHE.folder = folder;
    MAIL_VIEW_CACHE.messages = messages;
    MAIL_VIEW_CACHE.nextPageToken = nextPageToken;
    MAIL_VIEW_CACHE.selectedId = selectedId;
    MAIL_VIEW_CACHE.open = open;
    MAIL_VIEW_CACHE.query = query;
    MAIL_VIEW_CACHE.searchInput = searchInput;
    MAIL_VIEW_CACHE.assistantOpen = assistantOpen;
  }, [
    accounts,
    accountId,
    assistantOpen,
    folders,
    folder,
    messages,
    nextPageToken,
    open,
    query,
    searchInput,
    selectedId,
  ]);

  useEffect(() => {
    if (previewMode) {
      setAccounts([previewAccount(copy)]);
      setAccountId(PREVIEW_ACCOUNT_ID);
      setFolders(previewFolders(copy));
      setFolder("INBOX");
      setLoadingAccounts(false);
      return;
    }
    setLoadingAccounts(true);
    mailAccountsGet()
      .then((list) => {
        setAccounts(list);
        const first = list.find((account) => account.connected);
        if (first) setAccountId(first.id);
      })
      .catch(fail)
      .finally(() => setLoadingAccounts(false));
  }, [copy, fail, previewMode]);

  useEffect(() => {
    if (!accountId) return;
    if (previewMode) return;
    mailFolders(accountId)
      .then((list) => {
        setFolders(list);
        if (!list.some((item) => item.id === folder)) {
          const inbox = list.find((item) => item.kind === "inbox") ?? list[0];
          if (inbox) setFolder(inbox.id);
        }
      })
      .catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, fail]);

  const loadList = useCallback(
    (reset: boolean) => {
      if (!accountId) return;
      if (!reset && (!nextPageToken || listLoadingRef.current)) return;
      if (reset && listLoadingRef.current) return;
      const listKey = mailListKey(accountId, folder, query);
      const hasWarmList =
        reset && MAIL_VIEW_CACHE.listKey === listKey && MAIL_VIEW_CACHE.messages.length > 0;
      listLoadingRef.current = true;
      setLoadingList(!hasWarmList);
      setError(null);
      if (previewMode) {
        const visible = previewMessagesFor(folder, query, copy);
        MAIL_VIEW_CACHE.listKey = listKey;
        setMessages((prev) => (reset ? visible : [...prev, ...visible]));
        setNextPageToken(null);
        listLoadingRef.current = false;
        setLoadingList(false);
        return;
      }
      mailList(accountId, folder, query, reset ? null : nextPageToken)
        .then((page) => {
          MAIL_VIEW_CACHE.listKey = listKey;
          setMessages((prev) => (reset ? page.messages : [...prev, ...page.messages]));
          setNextPageToken(page.nextPageToken ?? null);
        })
        .catch(fail)
        .finally(() => {
          listLoadingRef.current = false;
          setLoadingList(false);
        });
    },
    [accountId, copy, fail, folder, nextPageToken, previewMode, query],
  );

  const handleMessageListScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!nextPageToken || listLoadingRef.current) return;
      const target = event.currentTarget;
      const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceToBottom < 180) {
        loadList(false);
      }
    },
    [loadList, nextPageToken],
  );

  useEffect(() => {
    if (previewMode || !accountId) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onMailNewMessage((event) => {
      if (event.accountId !== accountId) return;
      setFolders((prev) =>
        prev.map((item) =>
          item.id === event.folder
            ? { ...item, unreadCount: item.unreadCount + (event.message.unread ? 1 : 0) }
            : item,
        ),
      );
      if (event.folder !== folder || query.trim()) return;
      setMessages((prev) =>
        prev.some((message) => message.id === event.message.id)
          ? prev
          : [event.message, ...prev],
      );
      MAIL_VIEW_CACHE.listKey = mailListKey(accountId, folder, query);
    })
      .then((handler) => {
        if (disposed) handler();
        else unlisten = handler;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [accountId, folder, previewMode, query]);

  useEffect(() => {
    if (!accountId) return;
    const nextListKey = mailListKey(accountId, folder, query);
    const hasWarmList =
      MAIL_VIEW_CACHE.listKey === nextListKey && MAIL_VIEW_CACHE.messages.length > 0;
    if (!hasWarmList) {
      setMessages([]);
      setNextPageToken(null);
      setOpen(null);
      setSelectedId("");
    }
    loadList(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, folder, query]);

  const openMessage = useCallback(
    (summary: MailMessageSummary) => {
      if (!accountId) return;
      setSelectedId(summary.id);
      setLoadingMessage(true);
      setError(null);
      if (previewMode) {
        window.setTimeout(() => {
          const full = copy.demo.fullMessages[summary.id];
          if (!full) {
            setError(copy.notFoundInPreview);
            setLoadingMessage(false);
            return;
          }
          setOpen({ ...full, unread: false });
          setMessages((prev) =>
            prev.map((message) =>
              message.id === summary.id ? { ...message, unread: false } : message,
            ),
          );
          setFolders((prev) =>
            prev.map((item) =>
              item.id === folder
                ? { ...item, unreadCount: Math.max(0, item.unreadCount - 1) }
                : item,
            ),
          );
          setLoadingMessage(false);
        }, 140);
        return;
      }
      mailRead(accountId, summary.id)
        .then((full) => {
          setOpen(full);
          if (full.unread) {
            void mailModify(accountId, summary.id, { unread: false }).catch(() => undefined);
            setMessages((prev) =>
              prev.map((message) =>
                message.id === summary.id ? { ...message, unread: false } : message,
              ),
            );
            setFolders((prev) =>
              prev.map((item) =>
                item.id === folder
                  ? { ...item, unreadCount: Math.max(0, item.unreadCount - 1) }
                  : item,
              ),
            );
          }
        })
        .catch(fail)
        .finally(() => setLoadingMessage(false));
    },
    [accountId, copy, fail, folder, previewMode],
  );

  const applyMessagePatch = useCallback(
    (id: string, patch: Parameters<typeof mailModify>[2], removeFromList: boolean) => {
      if (!accountId) return;
      const previousMessages = messages;
      const previousOpen = open;
      const previousSelectedId = selectedId;
      if (removeFromList) {
        setMessages((prev) => prev.filter((message) => message.id !== id));
        if (selectedId === id) {
          setOpen(null);
          setSelectedId("");
        }
      } else {
        setMessages((prev) =>
          prev.map((message) =>
            message.id === id
              ? {
                  ...message,
                  unread: patch.unread ?? message.unread,
                  starred: patch.starred ?? message.starred,
                }
              : message,
          ),
        );
        setOpen((prev) =>
          prev && prev.id === id
            ? {
                ...prev,
                unread: patch.unread ?? prev.unread,
                starred: patch.starred ?? prev.starred,
              }
            : prev,
        );
      }
      if (previewMode) {
        setError(null);
        return;
      }
      void mailModify(accountId, id, patch)
        .then(() => {
          setError(null);
        })
        .catch((error) => {
          setMessages(previousMessages);
          setOpen(previousOpen);
          setSelectedId(previousSelectedId);
          fail(error);
        });
    },
    [accountId, fail, messages, open, previewMode, selectedId],
  );

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setQuery(searchInput.trim());
  };

  const sendDraft = () => {
    if (!accountId || !compose) return;
    if (previewMode) {
      setCompose(null);
      setGlobalError(null);
      return;
    }
    const draft: MailDraft = {
      to: compose.to,
      cc: compose.cc,
      subject: compose.subject,
      body: compose.body,
    };
    setSending(true);
    mailSend(accountId, draft)
      .then(() => {
        setCompose(null);
        setGlobalError(null);
      })
      .catch(fail)
      .finally(() => setSending(false));
  };

  if (loadingAccounts) {
    return (
      <div className="agent-mail-empty">
        <div className="agent-mail-empty-card">
          <img src={arisIcon} alt="" decoding="async" />
          <h2>{copy.loadingMailboxTitle}</h2>
          <p>{copy.loadingMailboxDesc}</p>
        </div>
      </div>
    );
  }

  if (connected.length === 0) {
    return (
      <div className="agent-mail-empty">
        <div className="agent-mail-empty-card">
          <img src={arisIcon} alt="" decoding="async" />
          <h2>{previewMode ? copy.previewNoMailboxTitle : copy.connectMailboxTitle}</h2>
          <p>{previewMode ? copy.previewNoMailboxDesc : copy.connectMailboxDesc}</p>
          <button className="am-primary" onClick={() => setTab("settings")}>
            {copy.openMailSettings}
          </button>
          {error && <div className="am-error">{error}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="agent-mail">
      <aside className="am-sidebar">
        <div className="am-brand">
          <img src={arisIcon} alt="" decoding="async" />
          <span>SomniQ Mail</span>
        </div>

        <button className="am-compose" onClick={() => setCompose(EMPTY_COMPOSE)}>
          <Icon name="edit" />
          <span>{copy.compose}</span>
          <span className="am-compose-split" />
          <Icon name="chevronDown" size={18} />
        </button>

        <nav className="am-folder-list" aria-label={copy.folderNavAriaLabel}>
          {sortedFolders.map((item) => {
            const meta = folderMeta(item, copy);
            const isActive = item.id === folder;
            return (
              <button
                key={item.id}
                className={`am-folder${isActive ? " active" : ""}`}
                title={meta.label}
                onClick={() => setFolder(item.id)}
              >
                <Icon name={meta.icon} />
                <span>{meta.label}</span>
                {item.unreadCount > 0 && <b>{item.unreadCount}</b>}
              </button>
            );
          })}
          <button className="am-folder soft" type="button">
            <Icon name="settings" />
            <span>{copy.settingsNav}</span>
          </button>
        </nav>

        <div className="am-sidebar-card am-overview-card">
          <div className="am-card-kicker">{copy.overviewKicker}</div>
          <div className="am-overview-grid">
            <span>
              <strong>{unreadTotal(folders)}</strong>
              {copy.unreadLabel}
            </span>
            <span>
              <strong>{folders.length}</strong>
              {copy.foldersLabel}
            </span>
          </div>
          <p>
            {activeFolder
              ? copy.overviewSummary(folderMeta(activeFolder, copy).label, messages.length)
              : copy.overviewSummaryEmpty}
          </p>
        </div>

        <div className="am-assist-note">
          <Icon name="bot" size={18} />
          <div>
            <strong>{copy.assistantTitle}</strong>
            <span>{copy.assistantSidebarDesc}</span>
          </div>
        </div>

        <div className="am-account">
          <Avatar
            seed={activeAccount?.email ?? ""}
            label={initialsFromAccount(activeAccount)}
          />
          <div>
            <strong>{activeAccount?.displayName || activeAccount?.email}</strong>
            <small>{activeAccount?.email}</small>
          </div>
          {connected.length > 1 && (
            <select value={activeAccount?.id} onChange={(event) => setAccountId(event.target.value)}>
              {connected.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          )}
        </div>
      </aside>

      <section className="am-stage">
        <header className="am-topbar">
          <button className="am-compose-top" type="button" onClick={() => setCompose(EMPTY_COMPOSE)}>
            <Icon name="edit" size={18} />
            <span>{copy.compose}</span>
          </button>
          <form className="am-search" onSubmit={submitSearch}>
            <button type="submit" aria-label={copy.searchAriaLabel}>
              <Icon name="search" size={18} />
            </button>
            <input
              value={searchInput}
              placeholder={copy.searchPlaceholder}
              onChange={(event) => setSearchInput(event.target.value)}
            />
            <kbd>Cmd+K</kbd>
          </form>
          {previewMode && <span className="am-preview-badge">{copy.previewBadge}</span>}
          <div className="am-top-actions">
            <button
              className={assistantOpen ? "active" : ""}
              title={copy.toggleAssistant(assistantOpen)}
              aria-label={copy.toggleAssistant(assistantOpen)}
              onClick={() => setAssistantOpen((value) => !value)}
            >
              <Icon name="bot" />
            </button>
            <button title={copy.notifications} aria-label={copy.notifications}>
              <Icon name="bell" />
            </button>
            <button title={copy.help} aria-label={copy.help}>
              <Icon name="help" />
            </button>
            <Avatar
              className="small"
              seed={activeAccount?.email ?? ""}
              label={initialsFromAccount(activeAccount)}
              title={activeAccount?.email}
            />
          </div>
        </header>

        <div
          className={`am-workspace${assistantOpen ? "" : " assistant-closed"}`}
          style={
            {
              "--am-list-width": `${listWidth}px`,
              "--am-assistant-width": `${assistantWidth}px`,
            } as CSSProperties
          }
        >
          <section className="am-list-pane">
            <div className="am-list-tabs">
              <button className="active">
                {activeFolder ? folderMeta(activeFolder, copy).label : copy.folderLabels.genericMail}
              </button>
              <span className="am-list-count">{copy.mailCountSuffix(messages.length)}</span>
              <button className="am-filter" title={copy.refresh} onClick={() => loadList(true)}>
                <Icon name="refresh" size={18} />
                {copy.refresh}
              </button>
            </div>

            {error && <div className="am-error inline">{error}</div>}

            <div className="am-message-list" onScroll={handleMessageListScroll}>
              {sortedMessages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  active={message.id === selectedId}
                  onOpen={() => openMessage(message)}
                  onStar={() =>
                    applyMessagePatch(message.id, { starred: !message.starred }, false)
                  }
                />
              ))}
              {messages.length === 0 && !loadingList && (
                <div className="am-list-empty">
                  <Icon name="inbox" size={42} />
                  <strong>{query ? copy.noMatchingMail : copy.emptyFolder}</strong>
                  <span>{query ? copy.tryDifferentKeyword : copy.newMailHint}</span>
                </div>
              )}
              {loadingList && <div className="am-loading">{copy.loadingMail}</div>}
              {nextPageToken && !loadingList && (
                <button className="am-load-more" onClick={() => loadList(false)}>
                  {copy.loadMore}
                </button>
              )}
            </div>
          </section>

          <PaneResizer
            value={listWidth}
            onChange={setListWidth}
            label={copy.resizeListLabel}
          />

          <ReadingView
            open={open}
            loading={loadingMessage}
            activeFolder={activeFolder}
            onCompose={setCompose}
            onBack={() => {
              setOpen(null);
              setSelectedId("");
            }}
            onPatch={applyMessagePatch}
          />

          {assistantOpen && (
            <>
              <PaneResizer
                className="am-assistant-resizer"
                value={assistantWidth}
                invert
                onChange={setAssistantWidth}
                label={copy.resizeAssistantLabel}
              />
              <AssistantPanel
                open={open}
                onClose={() => setAssistantOpen(false)}
                onCompose={setCompose}
                onPatch={applyMessagePatch}
              />
            </>
          )}
        </div>
      </section>

      {compose && (
        <ComposeModal
          compose={compose}
          sending={sending}
          setCompose={setCompose}
          onClose={() => setCompose(null)}
          onSend={sendDraft}
        />
      )}
    </div>
  );
}

function MessageRow({
  message,
  active,
  onOpen,
  onStar,
}: {
  message: MailMessageSummary;
  active: boolean;
  onOpen: () => void;
  onStar: () => void;
}) {
  const language = useStore((s) => s.language);
  const copy = MAIL_INBOX_COPY[language];
  return (
    <article
      className={`am-message-row${active ? " active" : ""}${message.unread ? " unread" : ""}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
      }}
    >
      <span className="am-select-dot" aria-hidden="true" />
      <div className="am-message-main">
        <div className="am-message-head">
          <strong>{message.fromName || message.from}</strong>
          <time>{formatDate(message.date, language)}</time>
        </div>
        <div className={`am-message-subject${cleanSubject(message.subject) ? "" : " empty"}`}>
          {summaryTitle(message, copy)}
        </div>
        <p>{cleanSnippet(message.snippet) || copy.noPreviewContent}</p>
      </div>
      <div className="am-message-badges">
        {message.hasAttachments && <Icon name="paperclip" size={16} />}
        {message.unread && <span className="blue">{copy.unreadBadge}</span>}
        {visibleLabels(message.labels).map((label) => (
          <span key={label}>{label}</span>
        ))}
        <button
          className={`am-star${message.starred ? " on" : ""}`}
          title={copy.toggleStar(message.starred)}
          onClick={(event) => {
            event.stopPropagation();
            onStar();
          }}
        >
          <Icon name={message.starred ? "star" : "starOutline"} size={18} />
        </button>
      </div>
    </article>
  );
}

function ReadingView({
  open,
  loading,
  activeFolder,
  onCompose,
  onBack,
  onPatch,
}: {
  open: MailMessageFull | null;
  loading: boolean;
  activeFolder?: MailFolder;
  onCompose: (next: ComposeState) => void;
  onBack: () => void;
  onPatch: (id: string, patch: Parameters<typeof mailModify>[2], remove: boolean) => void;
}) {
  const language = useStore((s) => s.language);
  const copy = MAIL_INBOX_COPY[language];
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replyMode, setReplyMode] = useState<"reply" | "replyAll">("reply");
  const [menuOpen, setMenuOpen] = useState<"toolbar" | "message" | "attachments" | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setReplyOpen(false);
    setReplyText("");
    setReplyMode("reply");
    setMenuOpen(null);
    setNotice("");
  }, [open?.id]);

  if (loading) {
    return (
      <section className="am-reading-pane">
        <Toolbar onBack={onBack} />
        <div className="am-reading-empty">{copy.openingMail}</div>
      </section>
    );
  }

  if (!open) {
    return (
      <section className="am-reading-pane">
        <Toolbar onBack={onBack} />
        <div className="am-reading-empty">
          <Icon name="markUnread" size={52} />
          <strong>{activeFolder ? folderMeta(activeFolder, copy).label : copy.folderLabels.inbox}</strong>
          <span>{copy.selectMailPrompt}</span>
        </div>
      </section>
    );
  }

  const startReply = (mode: "reply" | "replyAll") => {
    setReplyMode(mode);
    setReplyOpen(true);
    setMenuOpen(null);
    setNotice("");
  };
  const startForward = () => {
    onCompose({
      to: "",
      cc: "",
      subject: forwardSubject(open, copy),
      body: quotedBody(open, copy, language),
    });
    setMenuOpen(null);
    setNotice(copy.forwardOpenedNotice);
  };
  const handleSnooze = () => {
    onPatch(open.id, { unread: true }, false);
    setMenuOpen(null);
    setNotice(copy.snoozeNotice);
  };
  const replyPlaceholder = copy.quickReplyPlaceholder(replyMode === "replyAll");

  return (
    <section className="am-reading-pane">
      <Toolbar
        onBack={onBack}
        onArchive={() => onPatch(open.id, { archive: true }, true)}
        onTrash={() => onPatch(open.id, { trash: true }, true)}
        onUnread={() => onPatch(open.id, { unread: !open.unread }, false)}
        menuOpen={menuOpen === "toolbar"}
        onToggleMenu={() => setMenuOpen((value) => (value === "toolbar" ? null : "toolbar"))}
      />

      <article className={`am-reading${replyOpen ? " reply-active" : ""}`}>
        <div className="am-subject-line">
          <h1 className={cleanSubject(open.subject) ? "" : "empty"}>{fullTitle(open, copy)}</h1>
          {open.unread && <span className="tag blue">{copy.unreadBadge}</span>}
          {open.starred && <span className="tag amber">{copy.starredBadge}</span>}
          {visibleLabels(open.labels).map((label) => (
            <span className="tag neutral" key={label}>
              {label}
            </span>
          ))}
          <button
            className={`am-star large${open.starred ? " on" : ""}`}
            title={copy.toggleStar(open.starred)}
            onClick={() => onPatch(open.id, { starred: !open.starred }, false)}
          >
            <Icon name={open.starred ? "star" : "starOutline"} />
          </button>
        </div>

        <div className="am-sender">
          <Avatar
            seed={open.from || open.fromName}
            label={initial(open.fromName, open.from)}
          />
          <div>
            <strong>{open.fromName || open.from}</strong>
            {open.fromName && <span>&lt;{open.from}&gt;</span>}
            <small>{copy.recipientsLine(open.to, open.cc)}</small>
          </div>
          <time>{formatDate(open.date, language)}</time>
          <button title={copy.reply} onClick={() => startReply("reply")}>
            <Icon name="reply" size={18} />
          </button>
          <button title={copy.forward} onClick={startForward}>
            <Icon name="forward" size={18} />
          </button>
        </div>

        <div className="am-message-actions">
          <button onClick={() => startReply("reply")}>
            <Icon name="reply" size={18} />
            {copy.reply}
          </button>
          <button onClick={() => startReply("replyAll")}>
            <Icon name="replyAll" size={18} />
            {copy.replyAll}
          </button>
          <button onClick={startForward}>
            <Icon name="forward" size={18} />
            {copy.forward}
          </button>
          <button onClick={handleSnooze}>
            <Icon name="clock" size={18} />
            {copy.snooze}
          </button>
          <div className="am-menu-wrap">
            <button
              aria-label={copy.moreMailActionsAria}
              onClick={() => setMenuOpen((value) => (value === "message" ? null : "message"))}
            >
              <Icon name="more" size={18} />
            </button>
            {menuOpen === "message" && (
              <div className="am-action-menu">
                <button onClick={() => onPatch(open.id, { unread: !open.unread }, false)}>
                  {copy.toggleUnreadLabel(open.unread)}
                </button>
                <button onClick={() => onPatch(open.id, { starred: !open.starred }, false)}>
                  {copy.toggleStar(open.starred)}
                </button>
                <button onClick={() => onPatch(open.id, { archive: true }, true)}>{copy.archive}</button>
                <button onClick={() => onPatch(open.id, { trash: true }, true)}>{copy.deleteAction}</button>
              </div>
            )}
          </div>
        </div>

        {notice && <div className="am-action-notice">{notice}</div>}

        <MailBody html={open.bodyHtml ?? null} text={open.bodyText} />

        {open.attachments.length > 0 && (
          <section className="am-attachments">
            <div className="am-section-title">
              <span>{copy.attachmentsHeading(open.attachments.length)}</span>
              <div className="am-menu-wrap">
                <button
                  title={copy.moreAttachmentActionsTitle}
                  onClick={() =>
                    setMenuOpen((value) => (value === "attachments" ? null : "attachments"))
                  }
                >
                  <Icon name="more" size={18} />
                </button>
                {menuOpen === "attachments" && (
                  <div className="am-action-menu right">
                    <button onClick={() => setNotice(copy.viewAttachmentNotice)}>
                      {copy.viewAttachment}
                    </button>
                    <button onClick={() => setNotice(copy.downloadAllNotice)}>
                      {copy.downloadAll}
                    </button>
                  </div>
                )}
              </div>
            </div>
            <div className="am-attachment-grid">
              {open.attachments.map((attachment) => {
                const kind = attachmentKind(attachment.filename, attachment.mimeType);
                return (
                  <div className={`am-attachment ${kind}`} key={attachment.id || attachment.filename}>
                    <span>
                      <Icon name="file" size={22} />
                    </span>
                    <div>
                      <strong>{attachment.filename}</strong>
                      <small>{prettySize(attachment.size)}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div className="am-reading-fill" aria-hidden="true" />

        {replyOpen && (
          <div className="am-quick-reply am-quick-reply-open">
            <textarea
              placeholder={replyPlaceholder}
              value={replyText}
              onChange={(event) => setReplyText(event.target.value)}
            />
            <div>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setReplyOpen(false);
                  setReplyText("");
                  setNotice(copy.replySentNotice(replyMode === "replyAll"));
                }}
              >
                <Icon name="send" size={16} />
                {copy.send}
              </button>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  setReplyOpen(false);
                  setReplyText("");
                }}
              >
                {copy.cancel}
              </button>
            </div>
          </div>
        )}
      </article>
    </section>
  );
}

function Toolbar({
  onBack,
  onArchive,
  onTrash,
  onUnread,
  menuOpen = false,
  onToggleMenu,
}: {
  onBack: () => void;
  onArchive?: () => void;
  onTrash?: () => void;
  onUnread?: () => void;
  menuOpen?: boolean;
  onToggleMenu?: () => void;
}) {
  const language = useStore((s) => s.language);
  const copy = MAIL_INBOX_COPY[language];
  return (
    <div className="am-toolbar">
      <button title={copy.back} onClick={onBack}>
        <Icon name="back" size={18} />
        {copy.back}
      </button>
      <span />
      <button title={copy.archive} disabled={!onArchive} onClick={onArchive}>
        <Icon name="archive" size={18} />
        {copy.archive}
      </button>
      <button title={copy.deleteAction} disabled={!onTrash} onClick={onTrash}>
        <Icon name="trash" size={18} />
        {copy.deleteAction}
      </button>
      <button title={copy.mark} disabled={!onUnread} onClick={onUnread}>
        <Icon name="markUnread" size={18} />
        {copy.mark}
      </button>
      <div className="am-menu-wrap">
        <button title={copy.more} disabled={!onToggleMenu} onClick={onToggleMenu}>
          <Icon name="more" size={18} />
          {copy.more}
        </button>
        {menuOpen && (
          <div className="am-action-menu">
            <button disabled={!onUnread} onClick={onUnread}>{copy.toggleReadStatus}</button>
            <button disabled={!onArchive} onClick={onArchive}>{copy.archive}</button>
            <button disabled={!onTrash} onClick={onTrash}>{copy.deleteAction}</button>
          </div>
        )}
      </div>
      <div className="am-toolbar-pager">
        <button aria-label={copy.prevMail}>
          <Icon name="chevronLeft" size={18} />
        </button>
        <button aria-label={copy.nextMail}>
          <Icon name="chevronRight" size={18} />
        </button>
      </div>
    </div>
  );
}

function MailBody({ html, text }: { html: string | null; text: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);
  const language = useStore((s) => s.language);
  const copy = MAIL_INBOX_COPY[language];
  if (!html) return <pre className="am-body-text">{text || copy.noBodyText}</pre>;
  return (
    <iframe
      ref={ref}
      className="am-body-frame"
      sandbox=""
      title={copy.mailBodyIframeTitle}
      srcDoc={html}
    />
  );
}

function AssistantPanel({
  open,
  onClose,
  onCompose,
  onPatch,
}: {
  open: MailMessageFull | null;
  onClose: () => void;
  onCompose: (next: ComposeState) => void;
  onPatch: (id: string, patch: Parameters<typeof mailModify>[2], remove: boolean) => void;
}) {
  const language = useStore((s) => s.language);
  const copy = MAIL_INBOX_COPY[language];
  const [assistantText, setAssistantText] = useState("");
  const [assistantResult, setAssistantResult] = useState("");
  const subject = open ? fullTitle(open, copy) : copy.currentMailFallback;

  useEffect(() => {
    setAssistantText("");
    setAssistantResult("");
  }, [open?.id]);

  const submitAssistant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!assistantText.trim()) return;
    setAssistantResult(copy.assistantContextNotice);
    setAssistantText("");
  };

  return (
    <aside className="am-assistant">
      <div className="am-assistant-head">
        <strong>{copy.assistantTitle}</strong>
        <button aria-label={copy.closeAssistantAria} onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <section className="am-ai-card">
        <h3>
          <Icon name="sparkle" size={18} />
          {copy.mailInfoHeading}
        </h3>
        {open ? (
          <dl className="am-message-facts">
            <div>
              <dt>{copy.subjectLabel}</dt>
              <dd>{subject}</dd>
            </div>
            <div>
              <dt>{copy.fromLabel}</dt>
              <dd>{open.fromName || open.from}</dd>
            </div>
            <div>
              <dt>{copy.attachmentsLabel}</dt>
              <dd>{copy.attachmentsCount(open.attachments.length)}</dd>
            </div>
          </dl>
        ) : (
          <p className="am-assistant-empty">{copy.assistantEmptyHint}</p>
        )}
      </section>

      {open && (
        <>
          <section className="am-ai-card">
            <h3>
              <Icon name="markUnread" size={18} />
              {copy.quickActionsHeading}
            </h3>
            <TaskRow
              icon="reply"
              title={copy.replyToMailTitle}
              action={copy.reply}
              onAction={() =>
                onCompose({
                  to: open.from,
                  cc: "",
                  subject: replySubject(open, copy),
                  body: "",
                })
              }
            />
            <TaskRow
              icon="archive"
              title={copy.archiveMailTitle}
              action={copy.archive}
              onAction={() => onPatch(open.id, { archive: true }, true)}
            />
            <TaskRow
              icon="star"
              title={copy.toggleStarActionTitle}
              action={copy.starActionLabel(open.starred)}
              onAction={() => onPatch(open.id, { starred: !open.starred }, false)}
            />
          </section>

          {assistantResult && <p className="am-assistant-result">{assistantResult}</p>}

          <form className="am-assistant-input" onSubmit={submitAssistant}>
            <input
              value={assistantText}
              placeholder={copy.askAboutMailPlaceholder}
              onChange={(event) => setAssistantText(event.target.value)}
            />
            <button type="submit" aria-label={copy.sendToAssistantAria}>
              <Icon name="send" size={18} />
            </button>
          </form>
        </>
      )}
    </aside>
  );
}

function TaskRow({
  icon,
  title,
  action,
  onAction,
  disabled = false,
}: {
  icon: IconName;
  title: string;
  action: string;
  onAction?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="am-task-row">
      <Icon name={icon} size={17} />
      <span>{title}</span>
      <button disabled={disabled || !onAction} onClick={onAction}>{action}</button>
    </div>
  );
}

function ComposeModal({
  compose,
  sending,
  setCompose,
  onClose,
  onSend,
}: {
  compose: ComposeState;
  sending: boolean;
  setCompose: (next: ComposeState | null) => void;
  onClose: () => void;
  onSend: () => void;
}) {
  const language = useStore((s) => s.language);
  const copy = MAIL_INBOX_COPY[language];
  return (
    <div className="am-compose-overlay" onClick={() => !sending && onClose()}>
      <section className="am-compose-card" onClick={(event) => event.stopPropagation()}>
        <header>
          <span>{copy.composeNewTitle}</span>
          <button disabled={sending} onClick={onClose} aria-label={copy.closeAria}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <input
          placeholder={copy.toFieldPlaceholder}
          value={compose.to}
          onChange={(event) => setCompose({ ...compose, to: event.target.value })}
        />
        <input
          placeholder={copy.ccFieldPlaceholder}
          value={compose.cc}
          onChange={(event) => setCompose({ ...compose, cc: event.target.value })}
        />
        <input
          placeholder={copy.subjectFieldPlaceholder}
          value={compose.subject}
          onChange={(event) => setCompose({ ...compose, subject: event.target.value })}
        />
        <textarea
          placeholder={copy.bodyPlaceholder}
          value={compose.body}
          onChange={(event) => setCompose({ ...compose, body: event.target.value })}
        />
        <footer>
          <button className="am-primary" disabled={sending || !compose.to.trim()} onClick={onSend}>
            {sending ? copy.sending : copy.send}
          </button>
        </footer>
      </section>
    </div>
  );
}
