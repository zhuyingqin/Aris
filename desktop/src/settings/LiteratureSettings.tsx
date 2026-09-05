import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isTauri,
  literaturePreferences,
  literatureRenameAttachments,
  literatureSetPreferences,
} from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import type { Language } from "../store";
import {
  CITATION_STYLES,
  readCitationStyle,
  readCitationStyles,
  writeCitationStyle,
  type CitationStyleId,
} from "../literature/citationEngine";

/** Mirrors `runtime::LibraryPreferences`. */
export interface LibraryPreferences {
  attachmentNameTemplate: string;
  renameAttachmentsOnImport: boolean;
}

interface AttachmentRenameEntry {
  recordId: string;
  attachmentId: string;
  from: string;
  to: string;
}

interface AttachmentRenameSkip {
  recordId: string;
  attachmentId: string;
  path: string;
  reason: string;
}

interface AttachmentRenameReport {
  dryRun: boolean;
  renamed: AttachmentRenameEntry[];
  skipped: AttachmentRenameSkip[];
}

const DEFAULT_TEMPLATE = "{creator} - {year} - {title}";

const PLACEHOLDERS = ["creator", "year", "title", "citationKey", "venue", "itemType"] as const;

const COPY = {
  cn: {
    title: "文献库",
    subtitle: "附件命名与引文复制。设置按项目保存。",
    namingTitle: "附件命名",
    namingSub: "下载和导入的文件按模板命名，就像 Zotero 那样。",
    templateLabel: "命名模板",
    placeholdersLabel: "可用占位符",
    placeholderHint: "取不到值的占位符会连同它前面的分隔符一起省略。",
    previewLabel: "示例",
    renameOnImport: "导入和下载时自动重命名",
    renameExisting: "重命名已有附件…",
    previewing: "正在生成预览…",
    applying: "正在重命名…",
    planTitle: (count: number) => `将重命名 ${count} 个附件`,
    planEmpty: "没有需要重命名的附件。",
    skippedTitle: (count: number) => `跳过 ${count} 个`,
    apply: "确认重命名",
    cancel: "取消",
    renamed: (count: number) => `已重命名 ${count} 个附件。`,
    citationTitle: "引文复制",
    citationSub: "Ctrl+Shift+C 复制参考文献条目，Ctrl+Shift+A 复制正文引文；也可以直接把条目拖进编辑器。",
    styleLabel: "引文样式",
    needsDesktop: "该设置需要在桌面应用中使用。",
    saved: "已保存",
  },
  en: {
    title: "Library",
    subtitle: "Attachment naming and citation copying. Saved per project.",
    namingTitle: "Attachment naming",
    namingSub: "Name downloaded and imported files from a template, the way Zotero does.",
    templateLabel: "Naming template",
    placeholdersLabel: "Placeholders",
    placeholderHint: "A placeholder with no value is dropped along with the separator before it.",
    previewLabel: "Example",
    renameOnImport: "Rename on import and download",
    renameExisting: "Rename existing attachments…",
    previewing: "Building preview…",
    applying: "Renaming…",
    planTitle: (count: number) => `${count} attachment(s) will be renamed`,
    planEmpty: "Nothing to rename.",
    skippedTitle: (count: number) => `${count} skipped`,
    apply: "Rename",
    cancel: "Cancel",
    renamed: (count: number) => `Renamed ${count} attachment(s).`,
    citationTitle: "Quick Copy",
    citationSub: "Ctrl+Shift+C copies a bibliography entry, Ctrl+Shift+A copies an in-text citation; items can also be dragged straight into an editor.",
    styleLabel: "Citation style",
    needsDesktop: "This setting needs the desktop app.",
    saved: "Saved",
  },
} as const;

/** Characters Windows forbids in a path component. */
const ILLEGAL_PATH_CHARS = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"];
const RUN_OF_SPACES = /\s+/g;
const EDGE_DOTS = /^[.\s]+|[.\s]+$/g;
/** Rendered client-side so the template field shows its effect immediately,
 * without a round trip for every keystroke. Kept deliberately close to
 * `runtime::render_attachment_stem`: an empty value drops its own separator. */
export function previewAttachmentName(
  template: string,
  values: Record<string, string>,
): string {
  let rendered = "";
  let pending = "";
  let rest = template;
  while (true) {
    const start = rest.indexOf("{");
    if (start < 0) break;
    const end = rest.indexOf("}", start);
    if (end < 0) break;
    pending += rest.slice(0, start);
    const value = (values[rest.slice(start + 1, end)] ?? "").trim();
    if (value) {
      if (rendered) rendered += pending;
      rendered += value;
    }
    pending = "";
    rest = rest.slice(end + 1);
  }
  if (rendered) rendered += pending + rest;
  // Mirrors `sanitize_path_component`: only the characters Windows rejects
  // in a path component are dropped. A hyphen is ordinary text and has to
  // survive, or this preview would disagree with the file that gets written.
  const illegal = new Set(ILLEGAL_PATH_CHARS);
  const cleaned = [...rendered]
    .map((character) => (illegal.has(character) ? " " : character))
    .join("")
    .replace(RUN_OF_SPACES, " ")
    .trim()
    .replace(EDGE_DOTS, "");
  return cleaned;
}

export default function LiteratureSettings({ language }: { language: Language }) {
  const copy = COPY[language];
  const [preferences, setPreferences] = useState<LibraryPreferences>({
    attachmentNameTemplate: DEFAULT_TEMPLATE,
    renameAttachmentsOnImport: false,
  });
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [style, setStyle] = useState<CitationStyleId>(() => readCitationStyle());
  const [plan, setPlan] = useState<AttachmentRenameReport | null>(null);
  const [busy, setBusy] = useState<"" | "preview" | "apply">("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const native = isTauri();
  const styles = useMemo(() => (readCitationStyles().length ? readCitationStyles() : CITATION_STYLES), []);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await literaturePreferences<LibraryPreferences>();
        if (cancelled || !loaded) return;
        setPreferences(loaded);
        setTemplate(loaded.attachmentNameTemplate || DEFAULT_TEMPLATE);
      } catch (loadError) {
        if (!cancelled) setError(formatUserFacingError(loadError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [native]);

  const persist = useCallback(
    async (next: LibraryPreferences) => {
      setError(null);
      setPreferences(next);
      if (!native) return;
      try {
        const saved = await literatureSetPreferences<LibraryPreferences>(next);
        if (saved) {
          setPreferences(saved);
          setTemplate(saved.attachmentNameTemplate);
        }
        setStatus(copy.saved);
      } catch (saveError) {
        setError(formatUserFacingError(saveError));
      }
    },
    [copy.saved, native],
  );

  const preview = previewAttachmentName(template, {
    creator: "Sutton",
    year: "1998",
    title: "Reinforcement Learning An Introduction",
    citationKey: "sutton1998reinforcement",
    venue: "MIT Press",
    itemType: "book",
  });

  const runPreview = async () => {
    setError(null);
    setStatus(null);
    setBusy("preview");
    try {
      const report = await literatureRenameAttachments<AttachmentRenameReport>([], true);
      setPlan(report);
    } catch (previewError) {
      setError(formatUserFacingError(previewError));
    } finally {
      setBusy("");
    }
  };

  const applyRename = async () => {
    setError(null);
    setBusy("apply");
    try {
      const report = await literatureRenameAttachments<AttachmentRenameReport>([], false);
      setPlan(null);
      setStatus(copy.renamed(report?.renamed.length ?? 0));
    } catch (applyError) {
      setError(formatUserFacingError(applyError));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="sp-literature-page">
      <section className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.title}</div>
            <div className="sp-section-sub">{copy.subtitle}</div>
          </div>
        </div>
      </section>

      <section className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.namingTitle}</div>
            <div className="sp-section-sub">{copy.namingSub}</div>
          </div>
        </div>

        <label className="sp-field">
          <span className="sp-field-label">{copy.templateLabel}</span>
          <input
            className="sp-input"
            value={template}
            spellCheck={false}
            onChange={(event) => setTemplate(event.target.value)}
            onBlur={() => {
              const next = template.trim() || DEFAULT_TEMPLATE;
              if (next === preferences.attachmentNameTemplate) {
                setTemplate(next);
                return;
              }
              void persist({ ...preferences, attachmentNameTemplate: next });
            }}
          />
        </label>

        <div className="sp-field-hint">
          <span>{copy.placeholdersLabel}:</span>{" "}
          {PLACEHOLDERS.map((name) => (
            <button
              key={name}
              type="button"
              className="sp-token-btn"
              onClick={() => setTemplate((current) => `${current}{${name}}`)}
            >{`{${name}}`}</button>
          ))}
          <div>{copy.placeholderHint}</div>
        </div>

        <div className="sp-field-hint">
          {copy.previewLabel}: <code>{preview || "—"}.pdf</code>
        </div>

        <label className="sp-lit-checkbox">
          <input
            type="checkbox"
            checked={preferences.renameAttachmentsOnImport}
            onChange={(event) =>
              void persist({ ...preferences, renameAttachmentsOnImport: event.target.checked })
            }
          />
          <span>{copy.renameOnImport}</span>
        </label>

        {!native ? (
          <div className="sp-field-hint">{copy.needsDesktop}</div>
        ) : plan ? (
          <div className="sp-rename-plan">
            <div className="sp-rename-plan-title">
              {plan.renamed.length > 0 ? copy.planTitle(plan.renamed.length) : copy.planEmpty}
            </div>
            <ul className="sp-rename-plan-list">
              {plan.renamed.slice(0, 20).map((entry) => (
                <li key={entry.attachmentId}>
                  <code>{entry.from.split("/").at(-1)}</code>
                  {" → "}
                  <code>{entry.to.split("/").at(-1)}</code>
                </li>
              ))}
            </ul>
            {plan.skipped.length > 0 && (
              <details className="sp-rename-plan-skipped">
                <summary>{copy.skippedTitle(plan.skipped.length)}</summary>
                <ul>
                  {plan.skipped.slice(0, 20).map((skip) => (
                    <li key={skip.attachmentId}>
                      <code>{skip.path.split("/").at(-1) || skip.attachmentId}</code> — {skip.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="sp-rename-plan-actions">
              <button
                type="button"
                className="sp-btn sp-btn-primary"
                disabled={busy !== "" || plan.renamed.length === 0}
                onClick={() => void applyRename()}
              >
                {busy === "apply" ? copy.applying : copy.apply}
              </button>
              <button
                type="button"
                className="sp-btn sp-btn-secondary"
                disabled={busy !== ""}
                onClick={() => setPlan(null)}
              >
                {copy.cancel}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="sp-btn sp-btn-secondary"
            disabled={busy !== ""}
            onClick={() => void runPreview()}
          >
            {busy === "preview" ? copy.previewing : copy.renameExisting}
          </button>
        )}
      </section>

      <section className="sp-update-section">
        <div className="sp-section-head">
          <div className="sp-section-head-text">
            <div className="sp-section-title">{copy.citationTitle}</div>
            <div className="sp-section-sub">{copy.citationSub}</div>
          </div>
        </div>
        <label className="sp-field">
          <span className="sp-field-label">{copy.styleLabel}</span>
          <select
            className="sp-input"
            value={style}
            onChange={(event) => {
              const next = event.target.value as CitationStyleId;
              setStyle(next);
              writeCitationStyle(next);
              setStatus(copy.saved);
            }}
          >
            {styles.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
        </label>
      </section>

      {error && (
        <div className="sp-update-message sp-update-message-error" role="status">{error}</div>
      )}
      {!error && status && <div className="sp-field-hint" role="status">{status}</div>}
    </div>
  );
}
