import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fileSearch, isTauri } from "../api/tauri";
import type { ChatAttachment, SkillMeta } from "../types";
import { fuzzyMatch, makeId } from "./model";

const RECENT_SKILLS_KEY = "aris-chat-recent-skills";
const RECENT_FILES_KEY = "aris-chat-recent-files";

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

export function resizeComposerTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "0px";
  const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight) || 320;
  textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
}

async function attachmentFromFile(file: File): Promise<ChatAttachment> {
  if (file.type.startsWith("image/")) {
    const preview = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return { id: makeId("attachment"), kind: "image", name: file.name, mimeType: file.type, preview, content: preview };
  }
  return {
    id: makeId("attachment"),
    kind: "file",
    name: file.name,
    mimeType: file.type || "text/plain",
    content: await file.text(),
  };
}

interface Props {
  input: string;
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
}

export default function ChatComposer({
  input,
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
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pickerMode, setPickerMode] = useState<"skill" | "file" | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [pickerQuery, setPickerQuery] = useState("");
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const recentSkills = loadRecent(RECENT_SKILLS_KEY);
  const recentFiles = loadRecent(RECENT_FILES_KEY);

  const filteredSkills = useMemo(
    () => skills.filter((skill) => fuzzyMatch(pickerQuery, `${skill.name} ${skill.description ?? ""}`)),
    [pickerQuery, skills],
  );
  const skillItems = useMemo(() => {
    const recent = recentSkills
      .map((name) => filteredSkills.find((skill) => skill.name === name))
      .filter((skill): skill is SkillMeta => Boolean(skill));
    const recentNames = new Set(recent.map((skill) => skill.name));
    return [...recent, ...filteredSkills.filter((skill) => !recentNames.has(skill.name))];
  }, [filteredSkills, recentSkills]);
  const fileItems = useMemo(
    () => [...recentFiles.filter((path) => fuzzyMatch(pickerQuery, path)), ...fileResults.filter((path) => !recentFiles.includes(path))],
    [fileResults, pickerQuery, recentFiles],
  );
  const activeItems = pickerMode === "skill" ? skillItems : fileItems;

  useLayoutEffect(() => {
    if (textareaRef.current) resizeComposerTextarea(textareaRef.current);
  }, [input]);

  useLayoutEffect(() => {
    if (!wrapRef.current) return;
    const update = () => onHeightChange(wrapRef.current?.getBoundingClientRect().height ?? 0);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, [onHeightChange]);

  useEffect(() => {
    if (pickerMode !== "file" || !pickerQuery.trim() || !isTauri()) {
      setFileResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      fileSearch(`**/*${pickerQuery}*`)
        .then((results) => setFileResults(results.slice(0, 40)))
        .catch(() => setFileResults([]));
    }, 120);
    return () => window.clearTimeout(timer);
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

  const chooseSkill = (skill: SkillMeta | undefined) => {
    if (!skill) return;
    remember(RECENT_SKILLS_KEY, skill.name);
    replaceActiveToken(`/${skill.name} `);
  };

  const chooseFile = (path: string | undefined) => {
    if (!path) return;
    remember(RECENT_FILES_KEY, path);
    onAttachmentsChange([
      ...attachments.filter((attachment) => attachment.path !== path),
      { id: makeId("attachment"), kind: "file", name: path.replace(/\\/g, "/").split("/").pop() ?? path, path },
    ]);
    replaceActiveToken("");
  };

  const chooseActive = () => {
    if (pickerMode === "skill") chooseSkill(skillItems[pickerIndex]);
    else chooseFile(fileItems[pickerIndex]);
  };

  const addFiles = async (files: File[]) => {
    const next = await Promise.all(files.map(attachmentFromFile));
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
            <span>{pickerMode === "skill" ? "Skills" : "Files"}</span>
            <span>↑↓ select · Enter attach · Esc close</span>
          </div>
          <div className="skill-picker-scroll">
            {activeItems.length === 0 && <div className="picker-empty">No matches</div>}
            {pickerMode === "skill" && skillItems.map((skill, index) => (
              <div key={skill.name}>
                {index === 0 && <div className="picker-group-label">{recentSkills.includes(skill.name) ? "Recent" : "All skills"}</div>}
                {index > 0 && !recentSkills.includes(skill.name) && recentSkills.includes(skillItems[index - 1].name) && <div className="picker-group-label">All skills</div>}
                <button
                  className={`skill-picker-item${index === pickerIndex ? " active" : ""}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    chooseSkill(skill);
                  }}
                >
                  <span className="skill-picker-name">/{skill.name}</span>
                  <span className="skill-picker-desc">{skill.description}</span>
                </button>
              </div>
            ))}
            {pickerMode === "file" && fileItems.map((path, index) => (
              <div key={path}>
                {index === 0 && <div className="picker-group-label">{recentFiles.includes(path) ? "Recent" : "Search results"}</div>}
                {index > 0 && !recentFiles.includes(path) && recentFiles.includes(fileItems[index - 1]) && <div className="picker-group-label">Search results</div>}
                <button
                  className={`file-picker-item${index === pickerIndex ? " active" : ""}`}
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
          disabled={!ready || busy}
          placeholder={ready ? "Message ARIS" : "Configure an API key in Settings first"}
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
                setPickerIndex((index) => Math.min(index + 1, activeItems.length - 1));
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
                event.preventDefault();
                chooseActive();
                return;
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
            <span><kbd>/</kbd> Skills</span>
            <span><kbd>@</kbd> Files</span>
            <span className="chat-input-shortcut">Drop files · Paste images · Shift+Enter newline</span>
          </div>
          {busy ? (
            <button className="chat-send-btn chat-stop-btn" onClick={onStop} aria-label="Stop response">■</button>
          ) : (
            <button
              className="chat-send-btn"
              onClick={onSubmit}
              disabled={!ready || (!input.trim() && attachments.length === 0)}
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
