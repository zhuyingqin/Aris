// What an upgrade card lets the user check before the click: try each new
// page with the project's real data (changes stay in memory), and read every
// file that changes, line by line. Both read the draft checked against the
// digest the card approves, so what is tried is exactly what would run.
import { useState } from "react";
import { pluginsDraftChanges, type ActiveUiPanel, type PackageFileChange, type PluginApprovalCard } from "../api/plugins";
import { SvgIcon } from "../SvgIcon";
import type { Language } from "../store";
import { externalTextDiff } from "../typeset/externalChangeDiff";
import PluginPageFrame, { GLANCE_HEIGHT } from "./PluginPageFrame";
import { uiText } from "./useChatPluginPanels";
import "./PluginUpgradeReview.css";

const COPY = {
  cn: {
    tryPage: (title: string, where: string) => `试用“${title}”· ${where}`, hidePage: "收起试用",
    slots: { "nav.page": "页面", "chat.sidebar": "侧栏", "chat.brief": "摘要小组件" } as Record<string, string>, trying: "试用中：这里的操作只在内存里，不会保存，也不会触发任何动作。",
    files: (n: number) => `查看改动的文件（${n}）`, hideFiles: "收起文件改动", loading: "正在读取改动…",
    change: { added: "新增", removed: "删除", changed: "修改" }, binary: (a: number, b: number) => `二进制文件 · ${size(a)} → ${size(b)}`,
    tooLarge: "改动太大，无法逐行显示。", noText: "没有可显示的文本。",
  },
  en: {
    tryPage: (title: string, where: string) => `Try "${title}" · ${where}`, hidePage: "Close preview",
    slots: { "nav.page": "page", "chat.sidebar": "sidebar", "chat.brief": "summary glance" } as Record<string, string>, trying: "Preview: what you do here stays in memory; nothing is saved and no action runs.",
    files: (n: number) => `Show changed files (${n})`, hideFiles: "Hide file changes", loading: "Reading changes…",
    change: { added: "Added", removed: "Removed", changed: "Changed" }, binary: (a: number, b: number) => `Binary file · ${size(a)} → ${size(b)}`,
    tooLarge: "Too large to show line by line.", noText: "No text to show.",
  },
};

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function FileDiff({ file, language }: { file: PackageFileChange; language: Language }) {
  const copy = COPY[language];
  const [open, setOpen] = useState(false);
  if (file.binary) return <li className="plugin-review-file"><span className={`plugin-review-badge is-${file.change}`}>{copy.change[file.change]}</span><code>{file.path}</code><small>{copy.binary(file.beforeBytes, file.afterBytes)}</small></li>;
  // Line endings are not a change worth reading (a draft written on another OS).
  const lines = (text?: string) => (text ?? "").replace(/\r\n?/g, "\n");
  const diff = externalTextDiff(lines(file.before), lines(file.after));
  return <li className="plugin-review-file">
    <button type="button" className="plugin-review-file-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <SvgIcon name={open ? "chevronDown" : "chevronRight"} size={11} />
      <span className={`plugin-review-badge is-${file.change}`}>{copy.change[file.change]}</span>
      <code>{file.path}</code>
      <small><span className="is-add">+{diff.added}</span> <span className="is-del">−{diff.removed}</span></small>
    </button>
    {open && (diff.tooLargeToChunk ? <p className="plugin-review-note">{copy.tooLarge}</p>
      : diff.hunks.length === 0 ? <p className="plugin-review-note">{copy.noText}</p>
        : <pre className="plugin-review-diff">{diff.hunks.map((hunk, index) => <div key={index} className="plugin-review-hunk">
          <span className="plugin-review-hunk-head">@@ −{hunk.oldStart} +{hunk.newStart} @@</span>
          {hunk.lines.map((line, at) => <span key={at} className={`plugin-review-line is-${line.kind}`}>{line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}{line.text}{"\n"}</span>)}
        </div>)}</pre>)}
  </li>;
}

export default function PluginUpgradeReview({ card, projectPath, language }: {
  card: PluginApprovalCard; projectPath: string; language: Language;
}) {
  const copy = COPY[language];
  const [trying, setTrying] = useState<string | null>(null);
  const [glanceHeight, setGlanceHeight] = useState(120);
  const [files, setFiles] = useState<PackageFileChange[] | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [error, setError] = useState("");
  const pages = card.pagePanels ?? [];
  const listed = card.files ?? [];
  const draft = { source: card.source, digest: card.digest };
  const showFiles = () => {
    setFilesOpen((value) => !value);
    if (!files) pluginsDraftChanges(projectPath, card.source, card.digest).then(setFiles, (failure) => setError(String(failure)));
  };
  const tried = pages.find((page) => page.id === trying);
  const framed: ActiveUiPanel | null = tried ? {
    pluginName: card.name, packageDigest: card.digest, id: tried.id, slot: tried.slot as ActiveUiPanel["slot"],
    title: tried.title, order: 0, scope: "project", widgets: [],
  } : null;
  if (!pages.length && !listed.length) return null;
  return <div className="plugin-review">
    <div className="plugin-review-actions">
      {pages.map((page) => <button key={page.id} type="button" className={`plugin-review-button${trying === page.id ? " is-active" : ""}`} aria-pressed={trying === page.id}
        onClick={() => setTrying((value) => value === page.id ? null : page.id)}>
        <SvgIcon name="play" size={13} />{trying === page.id ? copy.hidePage : copy.tryPage(uiText(page.title, language), copy.slots[page.slot] ?? page.slot)}
      </button>)}
      {listed.length > 0 && <button type="button" className={`plugin-review-button${filesOpen ? " is-active" : ""}`} aria-expanded={filesOpen} onClick={showFiles}>
        <SvgIcon name="document" size={13} />{filesOpen ? copy.hideFiles : copy.files(listed.length)}
      </button>}
    </div>
    {framed && <div className="plugin-review-preview">
      <p className="plugin-review-note">{copy.trying}</p>
      <div className={`plugin-review-frame is-${framed.slot.replace(".", "-")}`} style={framed.slot === "chat.brief" ? { height: glanceHeight } : undefined}>
        <PluginPageFrame key={framed.id} panel={framed} projectPath={projectPath} language={language} draft={draft}
          onAction={() => undefined} onResize={framed.slot === "chat.brief" ? (height) => setGlanceHeight(Math.min(GLANCE_HEIGHT.max, height)) : undefined} />
      </div>
    </div>}
    {filesOpen && (error ? <p className="plugin-review-note is-error" role="alert">{error}</p>
      : !files ? <p className="plugin-review-note">{copy.loading}</p>
        : <ul className="plugin-review-files">{files.map((file) => <FileDiff key={file.path} file={file} language={language} />)}</ul>)}
  </div>;
}
