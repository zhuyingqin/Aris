import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fileSearch, isTauri } from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment, DesktopCommandSpec, PermissionModeView, SkillMeta } from "../types";
import { CHAT_COPY } from "./i18n";
import { fuzzyMatch, fuzzyScore, makeId } from "./model";

interface ContextStatusView {
  kind: "warning" | "compacted";
  message: string;
  detail?: string;
}

const RECENT_SKILLS_KEY = "somniq-chat-recent-skills";
const RECENT_SKILLS_LEGACY_KEY = "aris-chat-recent-skills";
const RECENT_FILES_KEY = "somniq-chat-recent-files";
const RECENT_FILES_LEGACY_KEY = "aris-chat-recent-files";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DROPPED_FILES = 20;
const IMAGE_UNSUPPORTED_MESSAGE = "(Image preview only. Vision input is not supported in desktop Chat yet.)";
const TEXT_FILE_EXTENSION = /\.(?:c|cc|cpp|css|csv|go|h|hpp|html|java|js|json|jsx|md|mjs|py|rs|sh|sql|svg|toml|ts|tsx|txt|xml|yaml|yml)$/i;
const PDF_FILE_EXTENSION = /\.pdf$/i;

function pathFromDraggedFile(file: File): string | undefined {
  const path = (file as File & { path?: unknown }).path;
  return typeof path === "string" && path.trim() ? path : undefined;
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function legacyRecentKey(key: string): string {
  if (key === RECENT_SKILLS_KEY) return RECENT_SKILLS_LEGACY_KEY;
  if (key === RECENT_FILES_KEY) return RECENT_FILES_LEGACY_KEY;
  return key;
}

function loadRecent(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? localStorage.getItem(legacyRecentKey(key)) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function rememberRecent(key: string, value: string, recent: string[]): string[] {
  const next = [value, ...recent.filter((item) => item !== value)].slice(0, 6);
  localStorage.setItem(key, JSON.stringify(next));
  localStorage.removeItem(legacyRecentKey(key));
  return next;
}

function isExactDesktopCommand(input: string, command: DesktopCommandSpec | undefined): boolean {
  return Boolean(command && input.trim().toLowerCase() === `/${command.name.toLowerCase()}`);
}

type SlashPickerItem =
  | { kind: "command"; command: DesktopCommandSpec; group: "System commands" }
  | { kind: "skill"; skill: SkillMeta; group: "Recent skills" | "All skills" };
type SkillSlashPickerItem = Extract<SlashPickerItem, { kind: "skill" }>;

interface RankedSlashItem {
  item: SlashPickerItem;
  label: string;
  score: number;
  index: number;
}

interface RankedSkillSlashItem extends Omit<RankedSlashItem, "item"> {
  item: SkillSlashPickerItem;
}

function slashSearchAliases(text: string): string {
  const lower = text.toLowerCase();
  const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  const aliases: string[] = [];
  if (tokens.has("lit") || lower.includes("literature")) {
    aliases.push("literature related work papers paper search survey bibliography references");
  }
  if (tokens.has("fig") || lower.includes("figure") || lower.includes("plot")) {
    aliases.push("figure plot chart visualization diagram illustration");
  }
  if (tokens.has("exp") || lower.includes("experiment")) {
    aliases.push("experiment evaluation benchmark result ablation training");
  }
  if (tokens.has("rev") || lower.includes("review")) {
    aliases.push("review audit critique reviewer feedback rebuttal");
  }
  if (tokens.has("pdf") || lower.includes("paper")) {
    aliases.push("pdf manuscript latex compile paper writing");
  }
  return aliases.join(" ");
}

function slashSearchText(name: string, description?: string | null): string {
  const base = `${name} ${description ?? ""}`;
  return `${base} ${slashSearchAliases(base)}`;
}

function rankSlashItem(
  query: string,
  label: string,
  searchText: string,
  item: SlashPickerItem,
  index: number,
): RankedSlashItem | null {
  const score = fuzzyScore(query, searchText);
  return score === null ? null : { item, label, score, index };
}

function compareRankedSlashItems(left: RankedSlashItem, right: RankedSlashItem): number {
  return left.score - right.score
    || left.label.localeCompare(right.label)
    || left.index - right.index;
}

function isRankedSkillSlashItem(item: RankedSlashItem | null): item is RankedSkillSlashItem {
  return Boolean(item) && item?.item.kind === "skill";
}

export function resizeComposerTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "0px";
  const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight) || 320;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

export async function attachmentFromFile(file: File): Promise<ChatAttachment> {
  if (file.type.startsWith("image/")) {
    if (file.size > MAX_IMAGE_BYTES) {
      return {
        id: makeId("attachment"),
        kind: "file",
        name: file.name,
        mimeType: file.type,
        content: `(Image omitted because it is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.)`,
      };
    }
    const preview = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return {
      id: makeId("attachment"),
      kind: "image",
      name: file.name,
      mimeType: file.type,
      preview,
      content: IMAGE_UNSUPPORTED_MESSAGE,
    };
  }
  const isPdf = file.type === "application/pdf" || PDF_FILE_EXTENSION.test(file.name);
  const draggedPath = pathFromDraggedFile(file);
  if (isPdf && draggedPath) {
    return {
      id: makeId("attachment"),
      kind: "file",
      name: basename(draggedPath),
      mimeType: file.type || "application/pdf",
      path: draggedPath,
    };
  }
  const isText = file.type.startsWith("text/")
    || file.type === "application/json"
    || file.type === "application/xml"
    || TEXT_FILE_EXTENSION.test(file.name);
  if (!isText) {
    return {
      id: makeId("attachment"),
      kind: "file",
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      content: "(Binary file content omitted. Attach a workspace path with @ to let SomniQ read it safely.)",
    };
  }
  const truncated = file.size > MAX_TEXT_BYTES;
  const content = await file.slice(0, MAX_TEXT_BYTES).text();
  return {
    id: makeId("attachment"),
    kind: "file",
    name: file.name,
    mimeType: file.type || "text/plain",
    content: truncated
      ? `${content}\n\n(File truncated after ${MAX_TEXT_BYTES / 1024 / 1024} MB.)`
      : content,
  };
}

const PERMISSION_OPTIONS = [
  { value: "read-only" },
  { value: "workspace-write" },
  { value: "prompt" },
  { value: "danger-full-access" },
];

const REASONING_OPTIONS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra high" },
];

function ContextRing({ used, max }: { used: number; max: number }) {
  const rawPct = max > 0 ? used / max : 0;
  const pct = Math.min(1, Math.max(0, rawPct));
  const radius = 9;
  const circ = 2 * Math.PI * radius;
  const dash = pct * circ;
  const stroke = rawPct < 0.5 ? "var(--green)" : rawPct < 0.8 ? "var(--amber)" : "var(--red)";
  const label = used === 0 ? "0%" : rawPct < 0.01 ? "<1%" : `${Math.round(rawPct * 100)}%`;
  const usedK = used >= 1000 ? `${(used / 1000).toFixed(0)}k` : String(used);
  const maxK = max >= 1000 ? `${(max / 1000).toFixed(0)}k` : String(max);
  return (
    <div className="ctx-ring" title={`Context window: ${label} used (${usedK} / ${maxK} tokens)`}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r={radius} fill="none" stroke="var(--border)" strokeWidth="2.5" />
        {pct > 0 && (
          <circle
            cx="11" cy="11" r={radius}
            fill="none" stroke={stroke} strokeWidth="2.5"
            strokeDasharray={`${dash} ${circ}`}
            strokeLinecap="round"
            transform="rotate(-90 11 11)"
          />
        )}
      </svg>
      <span className="ctx-ring-label">{label}</span>
    </div>
  );
}

function UploadPlusIcon() {
  return (
    <svg className="chat-upload-icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 2.75v8.5M2.75 7h8.5" />
    </svg>
  );
}

interface Props {
  input: string;
  commands: DesktopCommandSpec[];
  skills: SkillMeta[];
  attachments: ChatAttachment[];
  busy: boolean;
  ready: boolean;
  editing: boolean;
  onInputChange: (value: string) => void;
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onSubmit: () => void;
  onStop: () => void;
  onCancelEdit: () => void;
  onHeightChange: (height: number) => void;
  focusRequest?: number;
  permission?: PermissionModeView | null;
  permissionBusy?: boolean;
  onPermissionChange?: (mode: string) => void;
  modelName?: string | null;
  modelOptions?: { value: string; label: string }[];
  modelBusy?: boolean;
  canSwitchModel?: boolean;
  onModelChange?: (model: string) => void;
  reasoningSupported?: boolean;
  reasoningEffort?: string;
  reasoningBusy?: boolean;
  onReasoningEffortChange?: (effort: string) => void;
  contextUsed?: number;
  contextMax?: number | null;
  contextStatus?: ContextStatusView | null;
}

function ChatComposer({
  input,
  commands,
  skills,
  attachments,
  busy,
  ready,
  editing,
  onInputChange,
  onAttachmentsChange,
  onSubmit,
  onStop,
  onCancelEdit,
  onHeightChange,
  focusRequest = 0,
  permission,
  permissionBusy,
  onPermissionChange,
  modelName,
  modelOptions,
  modelBusy,
  canSwitchModel,
  onModelChange,
  reasoningSupported = false,
  reasoningEffort = "high",
  reasoningBusy = false,
  onReasoningEffortChange,
  contextUsed,
  contextMax,
  contextStatus,
}: Props) {
  const language = useStore((state) => state.language);
  const copy = CHAT_COPY[language];
  const wrapRef = useRef<HTMLDivElement>(null);
  const pickerScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activePickerItemRef = useRef<HTMLButtonElement | null>(null);
  const [pickerMode, setPickerMode] = useState<"skill" | "file" | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerQuery, setPickerQuery] = useState("");
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [permMenuOpen, setPermMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false);
  // These values change only when a picker selection is made. Keeping them in
  // state avoids parsing localStorage (and invalidating the picker memo) for
  // every streamed assistant update.
  const [recentSkills, setRecentSkills] = useState(() => loadRecent(RECENT_SKILLS_KEY));
  const [recentFiles, setRecentFiles] = useState(() => loadRecent(RECENT_FILES_KEY));
  const permMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const reasoningMenuRef = useRef<HTMLDivElement>(null);
  const fileSearchVersion = useRef(0);
  const permissionLabel = permission ? (copy.permissionLabels[permission.mode] ?? permission.label) : "";

  const slashItems = useMemo<SlashPickerItem[]>(() => {
    if (pickerMode !== "skill") return [];
    const commandMatches = commands
      .map((command, index) => rankSlashItem(
        pickerQuery,
        command.name,
        slashSearchText(command.name, command.description),
        { kind: "command" as const, command, group: "System commands" as const },
        index,
      ))
      .filter((item): item is RankedSlashItem => Boolean(item))
      .sort(compareRankedSlashItems)
      .map(({ item }) => item);
    const commandNames = new Set(commands.map((command) => command.name.toLowerCase()));
    const filteredSkills = skills
      .map((skill, index) => {
        if (commandNames.has(skill.name.toLowerCase())) return null;
        return rankSlashItem(
          pickerQuery,
          skill.name,
          slashSearchText(skill.name, skill.description),
          { kind: "skill" as const, skill, group: "All skills" as const },
          index,
        );
      })
      .filter(isRankedSkillSlashItem)
      .sort(compareRankedSlashItems);
    const recent = recentSkills
      .map((name) => filteredSkills.find(({ item }) => item.skill.name === name))
      .filter((match): match is RankedSkillSlashItem => Boolean(match))
      .map(({ item }) => ({
        ...item,
        group: "Recent skills" as const,
      }));
    const recentNames = new Set(recent.map((item) => item.skill.name));
    const rest = filteredSkills
      .map(({ item }) => item)
      .filter((item) => !recentNames.has(item.skill.name));
    return [...commandMatches, ...recent, ...rest];
  }, [commands, pickerMode, pickerQuery, recentSkills, skills]);
  const fileItems = useMemo(
    () => pickerMode === "file"
      ? [...recentFiles.filter((path) => fuzzyMatch(pickerQuery, path)), ...fileResults.filter((path) => !recentFiles.includes(path))]
      : [],
    [fileResults, pickerMode, pickerQuery, recentFiles],
  );
  const activeItems = pickerMode === "skill" ? slashItems : fileItems;
  const isCommandInput = input.trim().startsWith("/");
  const canSubmit = !busy
    && (ready || (isCommandInput && attachments.length === 0))
    && (input.trim().length > 0 || attachments.length > 0);

  useLayoutEffect(() => {
    if (textareaRef.current) resizeComposerTextarea(textareaRef.current);
  }, [input]);
  useEffect(() => {
    if (focusRequest > 0) textareaRef.current?.focus();
  }, [focusRequest]);

  useLayoutEffect(() => {
    const active = activePickerItemRef.current;
    const scroller = pickerScrollRef.current;
    if (!active || !scroller) return;

    const activeTop = active.offsetTop;
    const activeBottom = activeTop + active.offsetHeight;
    const visibleTop = scroller.scrollTop;
    const visibleBottom = visibleTop + scroller.clientHeight;
    if (activeTop < visibleTop) {
      scroller.scrollTop = activeTop;
    } else if (activeBottom > visibleBottom) {
      scroller.scrollTop = activeBottom - scroller.clientHeight;
    }
    active.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeItems.length, pickerIndex, pickerMode]);

  useEffect(() => {
    setPickerIndex((index) => Math.min(index, Math.max(activeItems.length - 1, 0)));
  }, [activeItems.length]);

  useLayoutEffect(() => {
    if (!wrapRef.current) return;
    const update = () => onHeightChange(wrapRef.current?.getBoundingClientRect().height ?? 0);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, [onHeightChange]);

  useEffect(() => {
    if (!permMenuOpen && !modelMenuOpen && !reasoningMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (permMenuOpen && permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) {
        setPermMenuOpen(false);
      }
      if (modelMenuOpen && modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
      if (reasoningMenuOpen && reasoningMenuRef.current && !reasoningMenuRef.current.contains(e.target as Node)) {
        setReasoningMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [permMenuOpen, modelMenuOpen, reasoningMenuOpen]);

  useEffect(() => {
    const version = ++fileSearchVersion.current;
    if (pickerMode !== "file" || !pickerQuery.trim() || !isTauri()) {
      setFileResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      fileSearch(`**/*${pickerQuery}*`)
        .then((results) => {
          if (version === fileSearchVersion.current) setFileResults(results.slice(0, 40));
        })
        .catch(() => {
          if (version === fileSearchVersion.current) setFileResults([]);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      fileSearchVersion.current += 1;
    };
  }, [pickerMode, pickerQuery]);

  const updatePicker = (value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const slash = before.match(/(^|\s)\/([^\s/]*)$/);
    const at = before.match(/(^|\s)@([^\s@]*)$/);
    if (slash) {
      setPickerMode("skill");
      setPickerQuery(slash[2]);
      setPickerIndex(0);
    } else if (at) {
      setPickerMode("file");
      setPickerQuery(at[2]);
      setPickerIndex(0);
    } else {
      setPickerMode(null);
    }
  };

  const replaceActiveToken = (replacement: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart ?? input.length;
    const before = input.slice(0, cursor);
    const token = pickerMode === "skill" ? /(^|\s)\/[^\s/]*$/ : /(^|\s)@[^\s@]*$/;
    const match = before.match(token);
    const start = match ? before.length - match[0].trimStart().length : cursor;
    onInputChange(`${input.slice(0, start)}${replacement}${input.slice(cursor)}`);
    setPickerMode(null);
    window.requestAnimationFrame(() => textarea.focus());
  };

  const chooseSlashItem = (item: SlashPickerItem | undefined) => {
    if (!item) return;
    if (item.kind === "skill") {
      setRecentSkills((current) => rememberRecent(RECENT_SKILLS_KEY, item.skill.name, current));
    }
    replaceActiveToken(`/${item.kind === "command" ? item.command.name : item.skill.name} `);
  };

  const chooseFile = (path: string | undefined) => {
    if (!path) return;
    setRecentFiles((current) => rememberRecent(RECENT_FILES_KEY, path, current));
    onAttachmentsChange([
      ...attachments.filter((attachment) => attachment.path !== path),
      { id: makeId("attachment"), kind: "file", name: basename(path), path },
    ]);
    replaceActiveToken("");
  };

  const chooseActive = () => {
    if (pickerMode === "skill") chooseSlashItem(slashItems[pickerIndex]);
    else chooseFile(fileItems[pickerIndex]);
  };

  const addFiles = async (files: File[]) => {
    const next = await Promise.all(files.slice(0, MAX_DROPPED_FILES).map(async (file) => {
      try {
        return await attachmentFromFile(file);
      } catch {
        return {
          id: makeId("attachment"),
          kind: "file" as const,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          content: "(File content could not be read.)",
        };
      }
    }));
    if (files.length > MAX_DROPPED_FILES) {
      next.push({
        id: makeId("attachment"),
        kind: "file",
        name: "additional-files-omitted.txt",
        mimeType: "text/plain",
        content: `${files.length - MAX_DROPPED_FILES} additional dropped files were omitted.`,
      });
    }
    onAttachmentsChange([...attachments, ...next]);
  };

  return (
    <div
      className={`chat-input-wrap${dragging ? " is-dragging" : ""}`}
      ref={wrapRef}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDragging(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {pickerMode && (
        <div className="skill-picker" role="listbox">
          <div className="skill-picker-header">
            <span>{pickerMode === "skill" ? copy.slashMenu : copy.files}</span>
            <span>{copy.pickerHint}</span>
          </div>
          <div className="skill-picker-scroll" ref={pickerScrollRef}>
            {activeItems.length === 0 && <div className="picker-empty">{copy.noMatches}</div>}
            {pickerMode === "skill" && slashItems.map((item, index) => (
              <div key={`${item.kind}-${item.kind === "command" ? item.command.name : item.skill.name}`}>
                {(index === 0 || slashItems[index - 1].group !== item.group) && <div className="picker-group-label">{item.group}</div>}
                <button
                  className={`skill-picker-item${index === pickerIndex ? " active" : ""}`}
                  ref={index === pickerIndex ? activePickerItemRef : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseSlashItem(item);
                  }}
                >
                  <span className="skill-picker-name">/{item.kind === "command" ? item.command.name : item.skill.name}</span>
                  <span className="skill-picker-desc">
                    {item.kind === "command" ? item.command.description : item.skill.description}
                  </span>
                </button>
              </div>
            ))}
            {pickerMode === "file" && fileItems.map((path, index) => (
              <div key={path}>
                {index === 0 && <div className="picker-group-label">{recentFiles.includes(path) ? copy.recent : copy.searchResults}</div>}
                {index > 0 && !recentFiles.includes(path) && recentFiles.includes(fileItems[index - 1]) && <div className="picker-group-label">{copy.searchResults}</div>}
                <button
                  className={`file-picker-item${index === pickerIndex ? " active" : ""}`}
                  ref={index === pickerIndex ? activePickerItemRef : undefined}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseFile(path);
                  }}
                >
                  <span className="file-picker-name">{path.replace(/\\/g, "/").split("/").pop()}</span>
                  <span className="file-picker-dir">{path}</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {contextStatus && (
        <div className={`chat-context-status chat-context-status-${contextStatus.kind}`}>
          <span className="chat-context-status-dot" aria-hidden="true" />
          <div className="chat-context-status-copy">
            <span>{contextStatus.message}</span>
            {contextStatus.detail && <small>{contextStatus.detail}</small>}
          </div>
        </div>
      )}
      <div className="chat-input">
        {dragging && <div className="chat-drop-overlay">{copy.dropFiles}</div>}
        <input
          ref={fileInputRef}
          className="chat-file-input"
          data-testid="chat-file-input"
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.go,.java,.c,.cc,.cpp,.h,.hpp,.html,.css,.xml,.yaml,.yml,.toml,.sh,.sql,.svg"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length > 0) void addFiles(files);
          }}
        />
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((attachment) => (
              <span
                className={`chat-attachment ${attachment.kind === "image" ? "is-image" : "is-file"}`}
                key={attachment.id}
              >
                {attachment.preview ? (
                  <img src={attachment.preview} alt={attachment.name} />
                ) : (
                  <span className="chat-attachment-file-icon" aria-hidden="true" />
                )}
                <span className="chat-attachment-name">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => onAttachmentsChange(attachments.filter((item) => item.id !== attachment.id))}
                  aria-label={copy.removeAttachment(attachment.name)}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        )}
        {editing && (
          <div className="chat-edit-banner">
            {copy.editingNotice}
            <button onClick={onCancelEdit}>{copy.cancel}</button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          disabled={busy}
          placeholder={ready ? copy.messagePlaceholder : copy.configurePlaceholder}
          onChange={(event) => {
            onInputChange(event.target.value);
            updatePicker(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length > 0) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (pickerMode) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setPickerIndex((index) => Math.min(index + 1, Math.max(activeItems.length - 1, 0)));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setPickerIndex((index) => Math.max(index - 1, 0));
                return;
              }
              if (event.key === "Escape") {
                setPickerMode(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                if (activeItems.length === 0) {
                  setPickerMode(null);
                } else {
                  event.preventDefault();
                }
                const activeSlashItem = slashItems[pickerIndex];
                if (
                  pickerMode === "skill"
                  && activeSlashItem?.kind === "command"
                  && isExactDesktopCommand(input, activeSlashItem.command)
                ) {
                  setPickerMode(null);
                  if (canSubmit) onSubmit();
                  return;
                }
                if (activeItems.length > 0) {
                  chooseActive();
                  return;
                }
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSubmit) onSubmit();
            }
          }}
        />
        <div className="chat-input-footer">
          <div className="chat-footer-left">
            {permission != null && onPermissionChange && (
              <div className="chat-pill-wrap" ref={permMenuRef}>
                <button
                  className={`chat-pill chat-perm-pill chat-perm-${permission.mode}`}
                  onClick={() => setPermMenuOpen((v) => !v)}
                  disabled={permissionBusy || busy}
                  title={permission.description ?? copy.permissionMode}
                >
                  {permissionLabel}
                  <span className="chat-pill-chevron">▾</span>
                </button>
                {permMenuOpen && (
                  <div className="chat-pill-menu" role="menu">
                    {PERMISSION_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        className={`chat-pill-menu-item${permission.mode === opt.value ? " active" : ""}`}
                        role="menuitem"
                        onClick={() => {
                          void onPermissionChange(opt.value);
                          setPermMenuOpen(false);
                        }}
                      >
                        {copy.permissionLabels[opt.value] ?? opt.value}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              className="chat-upload-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              title={copy.attachFiles}
              aria-label={copy.attachFiles}
            >
              <UploadPlusIcon />
            </button>
          </div>
          <div className="chat-footer-right">
            {contextMax != null && contextMax > 0 && (
              <ContextRing used={contextUsed ?? 0} max={contextMax} />
            )}
            {modelName && (
              <div className="chat-pill-wrap" ref={modelMenuRef}>
                <button
                  className="chat-pill chat-model-pill"
                  onClick={() => { if (canSwitchModel) setModelMenuOpen((v) => !v); }}
                  disabled={modelBusy || !canSwitchModel}
                  title={canSwitchModel ? (busy ? copy.switchModelNextTurn : copy.switchModel) : copy.activeModel}
                >
                  {modelName}
                  {canSwitchModel && <span className="chat-pill-chevron">▾</span>}
                </button>
                {modelMenuOpen && modelOptions && modelOptions.length > 0 && (
                  <div className="chat-pill-menu chat-pill-menu-right" role="menu">
                    {modelOptions.map((opt) => (
                      <button
                        key={opt.value}
                        className={`chat-pill-menu-item${modelName === opt.value ? " active" : ""}`}
                        role="menuitem"
                        onClick={() => {
                          void onModelChange?.(opt.value);
                          setModelMenuOpen(false);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {reasoningSupported && (
              <div className="chat-pill-wrap" ref={reasoningMenuRef}>
                <button
                  type="button"
                  className="chat-pill chat-reasoning-pill"
                  onClick={() => setReasoningMenuOpen((v) => !v)}
                  disabled={busy || reasoningBusy}
                  title="Reasoning effort"
                  aria-label="Reasoning effort"
                >
                  {REASONING_OPTIONS.find((opt) => opt.value === reasoningEffort)?.label ?? reasoningEffort}
                  <span className="chat-pill-chevron">▾</span>
                </button>
                {reasoningMenuOpen && (
                  <div className="chat-pill-menu chat-pill-menu-right" role="menu">
                    {REASONING_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        className={`chat-pill-menu-item${reasoningEffort === opt.value ? " active" : ""}`}
                        role="menuitem"
                        onClick={() => {
                          onReasoningEffortChange?.(opt.value);
                          setReasoningMenuOpen(false);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {busy ? (
              <button className="chat-send-btn chat-stop-btn" onClick={onStop} aria-label={copy.stopResponse}>■</button>
            ) : (
              <button
                className="chat-send-btn"
                onClick={onSubmit}
                disabled={!canSubmit}
                aria-label={editing ? copy.resendEditedMessage : copy.sendMessage}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(ChatComposer);
