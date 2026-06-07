import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fileSearch, isTauri } from "../api/tauri";
import type { ChatAttachment, DesktopCommandSpec, SkillMeta } from "../types";
import { fuzzyMatch, makeId } from "./model";

const RECENT_SKILLS_KEY = "aris-chat-recent-skills";
const RECENT_FILES_KEY = "aris-chat-recent-files";
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

function loadRecent(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function remember(key: string, value: string) {
  const next = [value, ...loadRecent(key).filter((item) => item !== value)].slice(0, 6);
  localStorage.setItem(key, JSON.stringify(next));
}

function isExactDesktopCommand(input: string, command: DesktopCommandSpec | undefined): boolean {
  return Boolean(command && input.trim().toLowerCase() === `/${command.name.toLowerCase()}`);
}

type SlashPickerItem =
  | { kind: "command"; command: DesktopCommandSpec; group: "System commands" }
  | { kind: "skill"; skill: SkillMeta; group: "Recent skills" | "All skills" };

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
      content: "(Binary file content omitted. Attach a workspace path with @ to let ARIS read it safely.)",
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
}

export default function ChatComposer({
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
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pickerScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activePickerItemRef = useRef<HTMLButtonElement | null>(null);
  const [pickerMode, setPickerMode] = useState<"skill" | "file" | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerQuery, setPickerQuery] = useState("");
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileSearchVersion = useRef(0);
  const recentSkills = loadRecent(RECENT_SKILLS_KEY);
  const recentFiles = loadRecent(RECENT_FILES_KEY);

  const slashItems = useMemo<SlashPickerItem[]>(() => {
    const commandMatches = commands
      .filter((command) => fuzzyMatch(pickerQuery, `${command.name} ${command.description ?? ""}`))
      .map((command) => ({ kind: "command" as const, command, group: "System commands" as const }));
    const commandNames = new Set(commands.map((command) => command.name.toLowerCase()));
    const filteredSkills = skills.filter((skill) => (
      !commandNames.has(skill.name.toLowerCase())
      && fuzzyMatch(pickerQuery, `${skill.name} ${skill.description ?? ""}`)
    ));
    const recent = recentSkills
      .map((name) => filteredSkills.find((skill) => skill.name === name))
      .filter((skill): skill is SkillMeta => Boolean(skill))
      .map((skill) => ({ kind: "skill" as const, skill, group: "Recent skills" as const }));
    const recentNames = new Set(recent.map((item) => item.skill.name));
    const rest = filteredSkills
      .filter((skill) => !recentNames.has(skill.name))
      .map((skill) => ({ kind: "skill" as const, skill, group: "All skills" as const }));
    return [...commandMatches, ...recent, ...rest];
  }, [commands, pickerQuery, recentSkills, skills]);
  const fileItems = useMemo(
    () => [...recentFiles.filter((path) => fuzzyMatch(pickerQuery, path)), ...fileResults.filter((path) => !recentFiles.includes(path))],
    [fileResults, pickerQuery, recentFiles],
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
    if (item.kind === "skill") remember(RECENT_SKILLS_KEY, item.skill.name);
    replaceActiveToken(`/${item.kind === "command" ? item.command.name : item.skill.name} `);
  };

  const chooseFile = (path: string | undefined) => {
    if (!path) return;
    remember(RECENT_FILES_KEY, path);
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
        setDragging(false);
        void addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {pickerMode && (
        <div className="skill-picker" role="listbox">
          <div className="skill-picker-header">
            <span>{pickerMode === "skill" ? "Slash menu" : "Files"}</span>
            <span>Up/Down select · Enter use · Esc close</span>
          </div>
          <div className="skill-picker-scroll" ref={pickerScrollRef}>
            {activeItems.length === 0 && <div className="picker-empty">No matches</div>}
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
                {index === 0 && <div className="picker-group-label">{recentFiles.includes(path) ? "Recent" : "Search results"}</div>}
                {index > 0 && !recentFiles.includes(path) && recentFiles.includes(fileItems[index - 1]) && <div className="picker-group-label">Search results</div>}
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
      <div className="chat-input">
        {dragging && <div className="chat-drop-overlay">Drop files to attach</div>}
        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((attachment) => (
              <span className="chat-attachment" key={attachment.id}>
                {attachment.preview && <img src={attachment.preview} alt="" />}
                <span>{attachment.name}</span>
                <button
                  onClick={() => onAttachmentsChange(attachments.filter((item) => item.id !== attachment.id))}
                  aria-label={`Remove ${attachment.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {editing && (
          <div className="chat-edit-banner">
            Editing an earlier message. Sending will replace later turns.
            <button onClick={onCancelEdit}>Cancel</button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          disabled={busy}
          placeholder={ready ? "Message ARIS" : "Configure an API key, or type /help"}
          onChange={(event) => {
            onInputChange(event.target.value);
            updatePicker(event.target.value, event.target.selectionStart ?? event.target.value.length);
          }}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (images.length > 0) {
              event.preventDefault();
              void addFiles(images);
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
                  onSubmit();
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
              onSubmit();
            }
          }}
        />
        <div className="chat-input-footer">
          <div className="chat-input-hints">
            <span><kbd>/</kbd> Commands and skills</span>
            <span><kbd>@</kbd> Files</span>
            <span className="chat-input-shortcut">Drop files · Paste images · Shift+Enter newline</span>
          </div>
          {busy ? (
            <button className="chat-send-btn chat-stop-btn" onClick={onStop} aria-label="Stop response">■</button>
          ) : (
            <button
              className="chat-send-btn"
              onClick={onSubmit}
              disabled={!canSubmit}
              aria-label={editing ? "Resend edited message" : "Send message"}
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
