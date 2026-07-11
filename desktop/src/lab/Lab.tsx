import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";
import type { KeyBinding } from "@codemirror/view";

import MarkdownContent from "../chat/MarkdownContent";
import { isTauri, onLabCellOutput } from "../api/tauri";
import { isLabPreviewMode } from "../api/labPreview";
import { useStore } from "../store";
import type { ChatAttachment } from "../types";
import { useLabStore } from "./labStore";
import CodeEditor, { type CodeDiffLine, type EditorLanguage } from "./CodeEditor";
import FileEditorPane from "./FileEditorPane";
import LabAssistant from "./LabAssistant";
import LabFiles, { type LabFileChange } from "./LabFiles";
import { OutputView } from "./outputs";
import type {
  LabCellOutputEvent,
  NotebookCell,
  RunRecord,
  SweepSpec,
  VariableInfo,
} from "./labTypes";
import { diffTextLines } from "./textDiff";
import "./Lab.css";

type Mode = "command" | "edit";
type CellPhase = "idle" | "queued" | "running";
/** The four Escape/modifier+Enter situations `CellView`'s editor keymap reports upward. */
type EditorKeyAction = "exit" | "run-advance" | "run-stay" | "run-insert";
type LabSideTab = "files" | "notebook" | "runtime";
type LabEditorKind = "notebook" | "file";

type CellActions = {
  onChange: (index: number, value: string) => void;
  onBlurCode: (index: number) => void;
  onSelect: (index: number, mode: Mode) => void;
  onCommandKey: (event: React.KeyboardEvent, index: number) => void;
  onEditorKey: (action: EditorKeyAction, index: number) => void;
  onRun: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onChangeType: (index: number, type: "code" | "markdown") => void;
};

interface LabEditorTab {
  id: string;
  kind: LabEditorKind;
  path: string;
}

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

const LAB_SIDE_WIDTH_KEY = "somniq-lab-side-w";
const LAB_SIDE_WIDTH_LEGACY_KEY = "aris-lab-side-w";
const LAB_ASSISTANT_WIDTH_KEY = "somniq-lab-assistant-w";
const LAB_ASSISTANT_WIDTH_LEGACY_KEY = "aris-lab-assistant-w";
const LAB_SIDE_WIDTH_DEFAULT = 260;
const LAB_SIDE_WIDTH_MIN = 210;
const LAB_SIDE_WIDTH_MAX = 420;
const LAB_ASSISTANT_WIDTH_DEFAULT = 380;
const LAB_ASSISTANT_WIDTH_MIN = 300;
const LAB_ASSISTANT_WIDTH_MAX = 680;

function clampPanelWidth(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, value)));
}

function storedPanelWidth(key: string, legacyKey: string, min: number, max: number, fallback: number): number {
  const value = Number(localStorage.getItem(key) ?? localStorage.getItem(legacyKey));
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function cellSource(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "";
}

/** How often we poll the open notebook on disk for external (AI) edits. */
const NOTEBOOK_POLL_MS = 2000;
const CELL_DIFF_KEY_SEPARATOR = "\u001f";

type CellChange = "added" | "modified";

interface NotebookReview {
  /** Current-cell index → how it changed vs the baseline (unchanged omitted). */
  status: Map<number, CellChange>;
  lineDiffs: Map<number, CodeDiffLine[]>;
  /** Cells present in the baseline but gone from the current notebook. */
  removed: { cellType: string; source: string }[];
  added: number;
  modified: number;
}

function cellMatchKey(cell: NotebookCell): string {
  return `${cell.cell_type}${CELL_DIFF_KEY_SEPARATOR}${cellSource(cell)}`;
}

function addedCellDiffLines(source: string): CodeDiffLine[] {
  const lines = source.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((text, index) => ({ line: index + 1, type: "added", text }));
}

/**
 * Cell-level diff between a baseline notebook and the current one, classifying
 * each current cell as added / modified / unchanged and collecting removed
 * cells. Matches by stable cell `id` first (Lab edits preserve ids, so in-place
 * rewrites read as `modified`), then falls back to identical content for id-less
 * or fully-rewritten cells.
 */
function diffNotebookCells(baseline: NotebookCell[], current: NotebookCell[]): NotebookReview {
  const usedBaseline = baseline.map(() => false);
  const matchedCurrent = current.map(() => false);
  const status = new Map<number, CellChange>();
  const lineDiffs = new Map<number, CodeDiffLine[]>();

  const byId = new Map<string, number>();
  baseline.forEach((cell, index) => {
    if (cell.id && !byId.has(cell.id)) byId.set(cell.id, index);
  });

  current.forEach((cell, index) => {
    if (!cell.id) return;
    const baseIndex = byId.get(cell.id);
    if (baseIndex === undefined || usedBaseline[baseIndex]) return;
    usedBaseline[baseIndex] = true;
    matchedCurrent[index] = true;
    const base = baseline[baseIndex];
    if (base.cell_type !== cell.cell_type || cellSource(base) !== cellSource(cell)) {
      status.set(index, "modified");
      const diffLines = diffTextLines(cellSource(base), cellSource(cell));
      lineDiffs.set(index, diffLines.length > 0 ? diffLines : addedCellDiffLines(cellSource(cell)));
    }
  });

  current.forEach((cell, index) => {
    if (matchedCurrent[index]) return;
    const key = cellMatchKey(cell);
    const baseIndex = baseline.findIndex(
      (base, j) => !usedBaseline[j] && cellMatchKey(base) === key,
    );
    if (baseIndex >= 0) {
      usedBaseline[baseIndex] = true;
      matchedCurrent[index] = true;
    } else {
      status.set(index, "added");
      lineDiffs.set(index, addedCellDiffLines(cellSource(cell)));
    }
  });

  const removed: { cellType: string; source: string }[] = [];
  baseline.forEach((base, j) => {
    if (!usedBaseline[j]) removed.push({ cellType: base.cell_type, source: cellSource(base) });
  });

  let added = 0;
  let modified = 0;
  status.forEach((value) => (value === "added" ? (added += 1) : (modified += 1)));
  return { status, lineDiffs, removed, added, modified };
}

/** First non-empty line of a cell's source, trimmed for the review-bar preview. */
function firstLine(source: string): string {
  const line = source.split("\n").find((entry) => entry.trim()) ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function isMarkdown(cell: NotebookCell): boolean {
  return cell.cell_type === "markdown";
}

/** Map a kernel's language id to the editor's highlighter language. */
function codeLanguageFor(kernelLanguage: string | undefined): EditorLanguage {
  if (kernelLanguage === "matlab") return "matlab";
  return "python";
}

function basename(path: string | null | undefined): string {
  if (!path) return "";
  return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || path;
}

function normalizeLabPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function dirname(path: string): string {
  const normalized = normalizeLabPath(path);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function pathContains(parent: string, child: string): boolean {
  const normalizedParent = normalizeLabPath(parent);
  const normalizedChild = normalizeLabPath(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function remapPath(path: string, from: string, to: string): string {
  const normalizedPath = normalizeLabPath(path);
  const normalizedFrom = normalizeLabPath(from);
  const normalizedTo = normalizeLabPath(to);
  if (normalizedPath === normalizedFrom) return normalizedTo;
  if (normalizedPath.startsWith(`${normalizedFrom}/`)) {
    return `${normalizedTo}/${normalizedPath.slice(normalizedFrom.length + 1)}`;
  }
  return normalizedPath;
}

function renamedTab(tab: LabEditorTab, from: string, to: string): LabEditorTab {
  const path = remapPath(tab.path, from, to);
  return { ...tab, id: editorTabId(tab.kind, path), path };
}

function editorTabId(kind: LabEditorKind, path: string): string {
  return `${kind}:${path}`;
}

function editorTabLabel(tab: LabEditorTab): string {
  return basename(tab.path) || (tab.kind === "notebook" ? "Notebook" : "File");
}

function formatRunTime(value?: number | null): string {
  return value ? new Date(value * 1000).toLocaleString() : "";
}

function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.floor(seconds % 60).toString().padStart(2, "0")}s`;
}

/** A live elapsed-time counter (ms) that ticks while `startedAt` is set. */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return startedAt == null ? 0 : Math.max(0, now - startedAt);
}

// Icons (inline, currentColor)
const Icon = ({ d, fill = "none" }: { d: string; fill?: string }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill={fill} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const IconRun = () => <Icon d="M5 3.5 12 8l-7 4.5z" fill="currentColor" />;
const IconRunAll = () => (
  <svg viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden="true">
    <path d="M4 3.8 9.8 7.5 4 11.2zM10.3 3.8l5.8 3.7-5.8 3.7z" fill="currentColor" />
    <path d="M4 15.5h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);
const IconUp = () => <Icon d="M4 10l4-4 4 4" />;
const IconDown = () => <Icon d="M4 6l4 4 4-4" />;
const IconCopy = () => <Icon d="M6 6h7v7H6zM3 3h7v2M3 3v7h2" />;
const IconTrash = () => <Icon d="M3 4h10M6.5 4V2.8h3V4M5 4l.6 9h4.8L11 4" />;
const IconPlus = () => <Icon d="M8 3.5v9M3.5 8h9" />;
const IconFiles = () => <Icon d="M2.5 3.5h4l1 1h6v8h-11z" />;
const IconNotebook = () => <Icon d="M4 2.5h8v11H4zM6 5h4M6 7.5h4M6 10h2.5" />;
const IconRuntime = () => <Icon d="M3 4.5h10M3 8h10M3 11.5h10M5 3v3M11 6.5v3M7 10v3" />;
const IconAssistant = () => <Icon d="M2.5 4.5h11v6.5h-4L8 12.5 6.5 11h-4zM5 7.5h.01M8 7.5h.01M11 7.5h.01" />;
const IconClose = () => <Icon d="M4.5 4.5l7 7M11.5 4.5l-7 7" />;

function normalizeSweepSpec(raw: unknown, activePath: string | null): SweepSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Sweep spec must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  const notebook = typeof obj.notebook === "string" && obj.notebook.trim() ? obj.notebook : activePath ?? "";
  if (!notebook) throw new Error("Sweep spec requires notebook.");

  const spec: SweepSpec = { notebook };
  if (obj.seeds !== undefined) {
    if (!Array.isArray(obj.seeds) || obj.seeds.some((seed) => typeof seed !== "number")) {
      throw new Error("seeds must be an array of numbers.");
    }
    spec.seeds = obj.seeds as number[];
  }
  if (obj.params !== undefined) {
    if (!obj.params || typeof obj.params !== "object" || Array.isArray(obj.params)) {
      throw new Error("params must be an object of value arrays.");
    }
    const params: Record<string, unknown[]> = {};
    for (const [key, value] of Object.entries(obj.params as Record<string, unknown>)) {
      if (!Array.isArray(value)) throw new Error(`params.${key} must be an array.`);
      params[key] = value;
    }
    spec.params = params;
  }

  const stopOnError = obj.stop_on_error ?? obj.stopOnError;
  if (stopOnError !== undefined) {
    if (typeof stopOnError !== "boolean") throw new Error("stop_on_error must be a boolean.");
    spec.stop_on_error = stopOnError;
  }
  const timeoutSecs = obj.timeout_secs ?? obj.timeoutSecs;
  if (timeoutSecs !== undefined) {
    if (typeof timeoutSecs !== "number") throw new Error("timeout_secs must be a number.");
    spec.timeout_secs = timeoutSecs;
  }
  if (typeof obj.kernel === "string" && obj.kernel.trim()) {
    spec.kernel = obj.kernel;
  }
  return spec;
}

/** Markdown headings across the notebook become a clickable table of contents. */
function buildToc(cells: NotebookCell[]): { index: number; level: number; text: string }[] {
  const toc: { index: number; level: number; text: string }[] = [];
  cells.forEach((cell, index) => {
    if (!isMarkdown(cell)) return;
    for (const line of cellSource(cell).split("\n")) {
      const heading = /^(#{1,4})\s+(.*\S)/.exec(line.trim());
      if (heading) toc.push({ index, level: heading[1].length, text: heading[2] });
    }
  });
  return toc;
}

interface CellViewProps {
  cell: NotebookCell;
  index: number;
  total: number;
  selected: boolean;
  mode: Mode;
  phase: CellPhase;
  elapsedMs: number;
  source: string;
  /** When an AI/external edit is under review, how this cell changed. */
  changeStatus?: CellChange;
  diffLines?: CodeDiffLine[];
  disabled: boolean;
  editorLanguage: EditorLanguage;
  actions: MutableRefObject<CellActions>;
}

function areCellPropsEqual(previous: CellViewProps, next: CellViewProps): boolean {
  return previous.cell === next.cell
    && previous.index === next.index
    && previous.total === next.total
    && previous.selected === next.selected
    && previous.mode === next.mode
    && previous.phase === next.phase
    && previous.elapsedMs === next.elapsedMs
    && previous.source === next.source
    && previous.changeStatus === next.changeStatus
    && previous.diffLines === next.diffLines
    && previous.disabled === next.disabled
    && previous.editorLanguage === next.editorLanguage;
}

const CellView = memo(function CellView(props: CellViewProps) {
  const { cell, index, total, selected, mode, phase, elapsedMs, source, disabled, changeStatus, diffLines } = props;
  const code = !isMarkdown(cell);
  // CodeMirror captures `extraKeymap` once at mount (see CodeEditor's "extensions
  // are creation-time only" contract), so the binding bodies read through this
  // ref rather than closing over `props`/`index` directly — otherwise cell
  // reordering or a stale `onEditorKey` closure would silently go stale.
  const editorKeyRef = useRef<(action: EditorKeyAction) => void>(() => undefined);
  editorKeyRef.current = (action) => props.actions.current.onEditorKey(action, index);
  const extraKeymapRef = useRef<KeyBinding[]>([
    { key: "Escape", run: () => { editorKeyRef.current("exit"); return true; } },
    { key: "Shift-Enter", run: () => { editorKeyRef.current("run-advance"); return true; } },
    { key: "Ctrl-Enter", run: () => { editorKeyRef.current("run-stay"); return true; } },
    { key: "Alt-Enter", run: () => { editorKeyRef.current("run-insert"); return true; } },
  ]);
  const running = phase === "running";
  const queued = phase === "queued";
  const editing = selected && mode === "edit";
  const showRendered = isMarkdown(cell) && !editing;
  const railClass = running
    ? "rail-running"
    : queued
      ? "rail-queued"
      : selected
        ? mode === "edit"
          ? "rail-edit"
          : "rail-command"
        : "";

  return (
    <div
      className={cx(
        "lab-cell",
        code ? "code" : "md",
        selected && "selected",
        selected && `mode-${mode}`,
        running && "running",
        queued && "queued",
        changeStatus === "added" && "cell-added",
        changeStatus === "modified" && "cell-modified",
      )}
      data-cell={index}
      tabIndex={0}
      onFocus={(event) => {
        if (event.target === event.currentTarget) props.actions.current.onSelect(index, "command");
      }}
      onKeyDown={(event) => props.actions.current.onCommandKey(event, index)}
    >
      <div className={cx("lab-rail", railClass)} aria-hidden="true" />
      <div className="lab-gutter">
        {code ? (
          <span className="lab-prompt" title="Execution count">
            [{running || queued ? "*" : cell.execution_count ?? " "}]
          </span>
        ) : (
          <span className="lab-prompt md">M</span>
        )}
        {running && <span className="lab-elapsed">{formatElapsed(elapsedMs)}</span>}
        {changeStatus && (
          <span
            className={cx("lab-cell-change-tag", changeStatus)}
            title={changeStatus === "added" ? "AI 新增的 cell" : "AI 修改的 cell"}
          >
            {changeStatus === "added" ? "+AI" : "~AI"}
          </span>
        )}
      </div>

      <div className="lab-cell-body">
        <div className="lab-cell-toolbar" role="toolbar" aria-label="Cell actions">
          <button className="lab-tool" title="Run (Shift+Enter)" disabled={disabled} onClick={() => props.actions.current.onRun(index)}>
            <IconRun />
          </button>
          <button className="lab-tool" title="Move up" disabled={index === 0} onClick={() => props.actions.current.onMoveUp(index)}>
            <IconUp />
          </button>
          <button className="lab-tool" title="Move down" disabled={index === total - 1} onClick={() => props.actions.current.onMoveDown(index)}>
            <IconDown />
          </button>
          <button className="lab-tool" title="Duplicate" onClick={() => props.actions.current.onDuplicate(index)}>
            <IconCopy />
          </button>
          <button
            className="lab-tool lab-tool-type"
            title={code ? "Convert to Markdown (m)" : "Convert to Code (y)"}
            onClick={() => props.actions.current.onChangeType(index, code ? "markdown" : "code")}
          >
            {code ? "MD" : "</>"}
          </button>
          <button className="lab-tool danger" title="Delete (dd)" onClick={() => props.actions.current.onDelete(index)}>
            <IconTrash />
          </button>
        </div>

        {showRendered ? (
          <div
            className="lab-md"
            onDoubleClick={() => props.actions.current.onSelect(index, "edit")}
            title="Double-click to edit"
          >
            {source.trim() ? (
              <MarkdownContent text={source} />
            ) : (
              <span className="lab-md-empty">Empty markdown cell - double-click to edit</span>
            )}
          </div>
        ) : (
          <CodeEditor
            value={source}
            language={code ? props.editorLanguage : "markdown"}
            placeholder={code ? "Type code here..." : "Type Markdown here..."}
            dataEditor={index}
            diffLines={diffLines}
            onChange={(value) => props.actions.current.onChange(index, value)}
            onFocus={() => props.actions.current.onSelect(index, "edit")}
            onBlur={() => code && props.actions.current.onBlurCode(index)}
            extraKeymap={extraKeymapRef.current}
          />
        )}

        {code && cell.outputs && cell.outputs.length > 0 && (
          <div className="lab-outputs">
            {cell.outputs.map((output, i) => (
              <OutputView key={i} output={output} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}, areCellPropsEqual);

function InsertBar({ at, onInsert }: { at: number; onInsert: (type: "code" | "markdown", at: number) => void }) {
  return (
    <div className="lab-insert">
      <div className="lab-insert-line" />
      <div className="lab-insert-actions">
        <button className="lab-insert-btn" title="Insert code cell here" onClick={() => onInsert("code", at)}>
          <IconPlus /> Code
        </button>
        <button className="lab-insert-btn" title="Insert markdown cell here" onClick={() => onInsert("markdown", at)}>
          <IconPlus /> Markdown
        </button>
      </div>
    </div>
  );
}

function RunRow({ run, onOpen }: { run: RunRecord; onOpen: (path: string) => void }) {
  const when = formatRunTime(run.finishedAt ?? run.startedAt);
  return (
    <div className="lab-run-row">
      <div className="lab-run-main">
        <span className={`lab-run-status ${run.status}`}>{run.status}</span>
        <span className="lab-run-id">{run.id}</span>
      </div>
      <div className="lab-run-meta">{run.sourceNotebook}</div>
      {when && <div className="lab-run-meta">{when}</div>}
      {run.executedPath && (
        <button className="lab-btn ghost lab-run-open" onClick={() => onOpen(run.executedPath!)}>
          Open executed
        </button>
      )}
    </div>
  );
}

function VariableRow({ variable }: { variable: VariableInfo }) {
  const shape = variable.shape?.length ? variable.shape.join(" x ") : null;
  return (
    <div className="lab-var-row">
      <div className="lab-var-main">
        <span className="lab-var-name">{variable.name}</span>
        <span className="lab-var-type">{variable.type}</span>
        {shape && <span className="lab-var-shape">{shape}</span>}
      </div>
      <div className="lab-var-repr" title={variable.repr}>
        {variable.repr}
      </div>
    </div>
  );
}

export default function Lab() {
  const {
    notebooks,
    kernelspecs,
    selectedKernel,
    setKernel,
    selectKernel,
    runs,
    variables,
    activePath,
    view,
    reviewBaseline,
    busy,
    variablesBusy,
    runningCell,
    runningAll,
    runStartedAt,
    sweepBusy,
    sweepResult,
    sweepManifest,
    error,
    init,
    refreshKernelspecs,
    refreshNotebooks,
    refreshRuns,
    open,
    createNotebook,
    checkExternalNotebookEdit,
    acceptNotebookReview,
    revertNotebookReview,
    insertCellAt,
    deleteCell,
    moveCell,
    duplicateCell,
    changeCellType,
    clearAllOutputs,
    persistCell,
    saveCell,
    runCell,
    runAllSequential,
    restartAndRunAll,
    interruptKernel,
    inspectVariables,
    appendCellOutput,
    runSweep,
    exportSweepManifest,
    startKernel,
    restartKernel,
    shutdownKernel,
    clearError,
    clearSweepManifest,
  } = useLabStore();
  const currentProject = useStore((state) => state.currentProject);
  const currentProjectId = currentProject?.id ?? null;
  const currentProjectPath = currentProject?.path ?? null;

  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("command");
  const [sideTab, setSideTab] = useState<LabSideTab>("files");
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [sideWidth, setSideWidth] = useState(() =>
    storedPanelWidth(LAB_SIDE_WIDTH_KEY, LAB_SIDE_WIDTH_LEGACY_KEY, LAB_SIDE_WIDTH_MIN, LAB_SIDE_WIDTH_MAX, LAB_SIDE_WIDTH_DEFAULT),
  );
  const [assistantWidth, setAssistantWidth] = useState(() =>
    storedPanelWidth(
      LAB_ASSISTANT_WIDTH_KEY,
      LAB_ASSISTANT_WIDTH_LEGACY_KEY,
      LAB_ASSISTANT_WIDTH_MIN,
      LAB_ASSISTANT_WIDTH_MAX,
      LAB_ASSISTANT_WIDTH_DEFAULT,
    ),
  );
  const [resizingPanel, setResizingPanel] = useState<"side" | "assistant" | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<LabEditorTab[]>([]);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [assistantAttachments, setAssistantAttachments] = useState<ChatAttachment[]>([]);
  const [newName, setNewName] = useState("");
  const [sweepSpecText, setSweepSpecText] = useState("");
  const [sweepParseError, setSweepParseError] = useState<string | null>(null);
  const cellsRef = useRef<HTMLDivElement>(null);
  const lastD = useRef<{ index: number; time: number } | null>(null);
  const sideResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const assistantResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Whether execution-follow auto-scroll is armed. A manual wheel/touch scroll
  // disarms it until the next run command re-arms it.
  const followRef = useRef(true);

  const cells: NotebookCell[] = view?.notebook?.cells ?? [];
  const cellCount = cells.length;
  const elapsedMs = useElapsed(runStartedAt);

  // AI/external-edit review: diff the live notebook against the snapshot taken
  // when the change was detected, so changed cells light up and deletions list.
  const review = useMemo(
    () => (reviewBaseline && activePath && !activeFilePath
      ? diffNotebookCells(reviewBaseline.cells ?? [], cells)
      : null),
    [reviewBaseline, activePath, activeFilePath, cells],
  );
  const hasReview = Boolean(review && (review.added || review.modified || review.removed.length));

  // Latest drafts/cells for the poll, read without re-arming the interval on
  // every keystroke.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const cellsForPollRef = useRef(cells);
  cellsForPollRef.current = cells;

  const ensureEditorTab = useCallback((kind: LabEditorKind, path: string) => {
    const id = editorTabId(kind, path);
    setOpenTabs((tabs) => {
      if (tabs.some((tab) => tab.id === id)) return tabs;
      return [...tabs, { id, kind, path }];
    });
  }, []);

  useEffect(() => {
    setActiveFilePath(null);
    setOpenTabs([]);
    setSideTab("files");
    setSideCollapsed(false);
    setTabMenu(null);
    setAssistantOpen(true);
    init(currentProjectId);
  }, [currentProjectId, init]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onLabCellOutput<LabCellOutputEvent>((event) => appendCellOutput(event))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [appendCellOutput]);

  // Poll the open notebook on disk for external (AI) edits, mirroring the file
  // editor's review flow. Idle-only: never while a kernel runs or the user has
  // unsaved cell drafts, so we don't clobber in-flight outputs or typing.
  useEffect(() => {
    if (!isTauri() || !activePath || activeFilePath) return;
    const timer = window.setInterval(() => {
      if (busy || runningAll || runningCell !== null) return;
      const liveCells = cellsForPollRef.current;
      const hasLocalEdits = Object.entries(draftsRef.current).some(([key, value]) => {
        const cell = liveCells[Number(key)];
        return cell ? value !== cellSource(cell) : value.length > 0;
      });
      if (hasLocalEdits) return;
      void checkExternalNotebookEdit(false).then((applied) => {
        if (applied) setDrafts({});
      });
    }, NOTEBOOK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [activePath, activeFilePath, busy, runningAll, runningCell, checkExternalNotebookEdit]);

  useEffect(() => {
    setDrafts({});
    setSelected(null);
    setMode("command");
    setSweepParseError(null);
    setSweepSpecText(
      activePath
        ? JSON.stringify(
            { notebook: activePath, seeds: [1, 2], params: { learning_rate: [0.01, 0.001] }, stop_on_error: true },
            null,
            2,
          )
        : "",
    );
  }, [activePath]);

  useEffect(() => {
    if (activePath) ensureEditorTab("notebook", activePath);
  }, [activePath, ensureEditorTab]);

  // Focus follows selection + mode: the textarea in edit mode, the cell shell in
  // command mode (so keyboard shortcuts land). Structural changes (cellCount)
  // re-assert focus; plain typing doesn't touch these deps, so it never steals.
  useEffect(() => {
    if (selected == null || activeFilePath) return;
    const root = cellsRef.current;
    if (!root) return;
    const target =
      mode === "edit"
        ? root.querySelector<HTMLElement>(`[data-editor="${selected}"]`)
        : root.querySelector<HTMLElement>(`[data-cell="${selected}"]`);
    if (target && document.activeElement !== target) target.focus();
  }, [selected, mode, cellCount, activePath, activeFilePath]);

  // Follow execution: scroll the running cell into view (without stealing focus)
  // so the Run-all cascade stays visible as the runner moves down the notebook.
  useEffect(() => {
    if (runningCell == null || !followRef.current) return;
    cellsRef.current
      ?.querySelector<HTMLElement>(`[data-cell="${runningCell}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [runningCell]);

  // Dismiss the editor-tab context menu on any outside interaction.
  useEffect(() => {
    if (!tabMenu) return;
    const dismiss = () => setTabMenu(null);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setTabMenu(null);
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [tabMenu]);

  const previewMode = isLabPreviewMode();

  if (!isTauri() && !previewMode) {
    return (
      <div className="lab">
        <div className="lab-empty">
          The Lab runs Jupyter notebooks through the desktop backend. Launch the app with{" "}
          <code>npm run tauri dev</code> to use it.
        </div>
      </div>
    );
  }

  const running = view?.running ?? false;
  const kernelName = view?.kernelName ?? null;
  const activeSpec = kernelspecs.find((s) => s.name === selectedKernel) ?? null;
  const codeLanguage = codeLanguageFor(activeSpec?.language);
  const activeEditorPath = activeFilePath ?? activePath;
  const activeEditorKind: LabEditorKind | null = activeFilePath ? "file" : activePath ? "notebook" : null;
  const activeEditorTabId = activeEditorKind && activeEditorPath ? editorTabId(activeEditorKind, activeEditorPath) : null;
  const activeOpenTab = activeEditorTabId ? openTabs.find((tab) => tab.id === activeEditorTabId) ?? null : null;
  const activeItemPath = activeOpenTab?.path ?? null;
  const activeItemKind = activeOpenTab?.kind ?? null;
  const showingNotebook = activeItemKind === "notebook";
  const hasCode = showingNotebook && cells.some((c) => c.cell_type === "code");
  const recentRuns = runs.slice(0, 8);
  const busyRunning = runningAll || runningCell !== null;
  // Kernel chip state: executing -> busy, starting/stopping -> starting, live -> on.
  const kernelState = running ? (busyRunning ? "busy" : "on") : busy ? "starting" : "off";
  const kernelTitle =
    kernelState === "busy"
      ? "Kernel busy"
      : kernelState === "starting"
        ? "Kernel starting..."
        : kernelState === "on"
          ? "Kernel ready"
          : "No kernel running";
  const toc = showingNotebook ? buildToc(cells) : [];
  const codeTotal = showingNotebook ? cells.filter((c) => c.cell_type === "code").length : 0;
  const codeDone = showingNotebook && runningCell !== null
    ? cells.slice(0, runningCell + 1).filter((c) => c.cell_type === "code").length
    : 0;

  // During a sequential Run-all, every code cell reads as queued until the runner
  // reaches it, the active one as running, and the ones above as done.
  const phaseOf = (index: number, code: boolean): CellPhase => {
    if (runningCell === index) return "running";
    if (runningAll && code && (runningCell === null || index > runningCell)) return "queued";
    return "idle";
  };

  const draftOf = (index: number, cell: NotebookCell) => drafts[index] ?? cellSource(cell);
  const select = (index: number | null, nextMode: Mode) => {
    setSelected(index);
    setMode(nextMode);
  };

  const handleCreate = () => {
    if (!newName.trim()) return;
    setActiveFilePath(null);
    void createNotebook(newName);
    setNewName("");
  };

  const persistDraftedCode = async () => {
    for (const [key, source] of Object.entries(drafts)) {
      const index = Number(key);
      const cell = Number.isInteger(index) ? cells[index] : undefined;
      if (cell?.cell_type === "code" && source !== cellSource(cell)) {
        await persistCell(index, source);
      }
    }
  };

  const onBlurCode = (index: number) => {
    const cell = cells[index];
    const source = drafts[index];
    if (cell && source !== undefined && source !== cellSource(cell)) {
      void persistCell(index, source);
    }
  };

  // Run a cell (code -> execute, markdown -> render) then move per the shortcut.
  const runWithShortcut = async (index: number, kind: "advance" | "stay" | "insert") => {
    const cell = cells[index];
    if (!cell) return;
    followRef.current = true; // a run command re-arms execution-follow

    const source = draftOf(index, cell);
    const atLast = index + 1 >= cells.length;

    let nextSelected = index;
    let nextMode: Mode = "command";
    if (kind === "insert") {
      nextSelected = await insertCellAt("code", index + 1);
      setDrafts({});
      nextMode = "edit";
    } else if (kind === "advance") {
      if (atLast) {
        nextSelected = await insertCellAt("code", cells.length);
        setDrafts({});
      } else {
        nextSelected = index + 1;
      }
    }

    if (isMarkdown(cell)) void saveCell(index, source);
    else void runCell(index, source);

    select(nextSelected, nextMode);
  };

  const runSelected = (index: number) => void runWithShortcut(index, "stay");

  const insertAndSelect = async (type: "code" | "markdown", at: number, nextMode: Mode) => {
    const newIndex = await insertCellAt(type, at);
    setDrafts({});
    select(newIndex, nextMode);
  };

  const doMoveUp = async (index: number) => {
    if (index === 0) return;
    await moveCell(index, index - 1);
    setDrafts({});
    select(index - 1, "command");
  };
  const doMoveDown = async (index: number) => {
    if (index >= cells.length - 1) return;
    await moveCell(index, index + 1);
    setDrafts({});
    select(index + 1, "command");
  };
  const doDuplicate = async (index: number) => {
    await duplicateCell(index);
    setDrafts({});
    select(index + 1, "command");
  };
  const doChangeType = async (index: number, type: "code" | "markdown") => {
    await changeCellType(index, type);
    setDrafts({});
    select(index, "command");
  };
  const doDelete = async (index: number) => {
    const nextCount = cells.length - 1;
    await deleteCell(index);
    setDrafts({});
    select(nextCount <= 0 ? null : Math.min(index, nextCount - 1), "command");
  };

  const handleEditorKey = (action: EditorKeyAction, index: number) => {
    if (action === "exit") {
      select(index, "command");
      return;
    }
    void runWithShortcut(index, action === "run-advance" ? "advance" : action === "run-insert" ? "insert" : "stay");
  };

  const handleCommandKey = (event: React.KeyboardEvent, index: number) => {
    if (event.target !== event.currentTarget) return; // ignore bubbling from the editor
    const k = event.key;
    if (k === "Enter" && (event.shiftKey || event.ctrlKey || event.altKey)) {
      event.preventDefault();
      void runWithShortcut(index, event.shiftKey ? "advance" : event.altKey ? "insert" : "stay");
    } else if (k === "Enter") {
      event.preventDefault();
      select(index, "edit");
    } else if (k === "ArrowDown" || k === "j") {
      event.preventDefault();
      select(Math.min(index + 1, cells.length - 1), "command");
    } else if (k === "ArrowUp" || k === "k") {
      event.preventDefault();
      select(Math.max(index - 1, 0), "command");
    } else if (k === "a") {
      event.preventDefault();
      void insertAndSelect("code", index, "command");
    } else if (k === "b") {
      event.preventDefault();
      void insertAndSelect("code", index + 1, "command");
    } else if (k === "m") {
      event.preventDefault();
      void doChangeType(index, "markdown");
    } else if (k === "y") {
      event.preventDefault();
      void doChangeType(index, "code");
    } else if (k === "d") {
      event.preventDefault();
      const now = Date.now();
      if (lastD.current && lastD.current.index === index && now - lastD.current.time < 600) {
        lastD.current = null;
        void doDelete(index);
      } else {
        lastD.current = { index, time: now };
      }
    }
  };

  const handleRunAll = async () => {
    followRef.current = true;
    await persistDraftedCode();
    setDrafts({});
    await runAllSequential();
  };

  const handleRestartRunAll = async () => {
    followRef.current = true;
    await persistDraftedCode();
    setDrafts({});
    await restartAndRunAll();
  };

  const scrollToCell = (index: number) => {
    cellsRef.current?.querySelector<HTMLElement>(`[data-cell="${index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    select(index, "command");
  };

  const parseSweepSpec = (): SweepSpec | null => {
    try {
      const spec = normalizeSweepSpec(JSON.parse(sweepSpecText), activePath);
      setSweepParseError(null);
      return spec;
    } catch (e) {
      setSweepParseError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };
  const handleRunSweep = async () => {
    const spec = parseSweepSpec();
    if (spec) await runSweep(spec);
  };
  const handleExportSweep = async () => {
    const spec = parseSweepSpec();
    if (spec) await exportSweepManifest(spec);
  };
  const attachToAssistant = (attachment: ChatAttachment) => {
    setAssistantAttachments((items) => [
      ...items.filter((item) => item.path !== attachment.path),
      attachment,
    ]);
    setAssistantOpen(true);
  };

  const activateEditorTab = async (tab: LabEditorTab) => {
    if (tab.kind === "notebook") {
      setActiveFilePath(null);
      if (activePath !== tab.path) await open(tab.path);
      return;
    }
    setActiveFilePath(tab.path);
    setSelected(null);
    setMode("command");
  };

  const closeEditorTab = (tabId: string) => {
    setOpenTabs((tabs) => {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return tabs;
      const closing = tabs[index];
      const next = tabs.filter((tab) => tab.id !== tabId);
      if (activeEditorTabId === tabId) {
        const fallback = next[Math.min(index, next.length - 1)] ?? null;
        window.setTimeout(() => {
          if (fallback) {
            void activateEditorTab(fallback);
          } else {
            setActiveFilePath(null);
            if (closing.kind === "notebook") setSelected(null);
          }
        }, 0);
      }
      return next;
    });
  };

  const closeOtherEditorTabs = (keepId: string) => {
    const keep = openTabs.find((tab) => tab.id === keepId);
    if (!keep) return;
    setOpenTabs([keep]);
    if (activeEditorTabId !== keepId) {
      window.setTimeout(() => void activateEditorTab(keep), 0);
    }
  };

  const closeAllEditorTabs = () => {
    setOpenTabs([]);
    setActiveFilePath(null);
    setSelected(null);
  };

  const clearActiveNotebook = () => {
    useLabStore.setState({ activePath: null, view: null, variables: [], reviewBaseline: null });
    setSelected(null);
    setDrafts({});
  };

  const handleFileChanged = (change: LabFileChange) => {
    if (change.type === "create") {
      void refreshNotebooks();
      return;
    }

    const sourcePath = normalizeLabPath(change.path);
    if (!sourcePath) {
      void refreshNotebooks();
      return;
    }

    if (change.type === "rename") {
      const targetPath = normalizeLabPath(change.newPath);
      if (!targetPath || sourcePath === targetPath) {
        void refreshNotebooks();
        return;
      }

      setOpenTabs((tabs) => tabs.map((tab) => (pathContains(sourcePath, tab.path) ? renamedTab(tab, sourcePath, targetPath) : tab)));
      setAssistantAttachments((items) =>
        items.map((item) => {
          if (!item.path || !pathContains(sourcePath, item.path)) return item;
          const path = remapPath(item.path, sourcePath, targetPath);
          return { ...item, path, name: basename(path) || item.name };
        }),
      );

      if (activeFilePath && pathContains(sourcePath, activeFilePath)) {
        setActiveFilePath(remapPath(activeFilePath, sourcePath, targetPath));
      }
      if (activePath && pathContains(sourcePath, activePath)) {
        const nextActivePath = remapPath(activePath, sourcePath, targetPath);
        if (activeFilePath) {
          useLabStore.setState({ activePath: nextActivePath });
          void refreshNotebooks();
        } else {
          void open(nextActivePath).then(() => refreshNotebooks());
        }
      } else {
        void refreshNotebooks();
      }
      return;
    }

    const removedIds = new Set(openTabs.filter((tab) => pathContains(sourcePath, tab.path)).map((tab) => tab.id));
    const nextTabs = openTabs.filter((tab) => !removedIds.has(tab.id));
    const firstRemovedIndex = openTabs.findIndex((tab) => removedIds.has(tab.id));
    const fallback = firstRemovedIndex >= 0 ? nextTabs[Math.min(firstRemovedIndex, nextTabs.length - 1)] ?? null : null;
    const activeFileRemoved = Boolean(activeFilePath && pathContains(sourcePath, activeFilePath));
    const activeNotebookRemoved = Boolean(activePath && pathContains(sourcePath, activePath));
    const activeEditorRemoved = Boolean(activeEditorTabId && removedIds.has(activeEditorTabId));

    setOpenTabs(nextTabs);
    setAssistantAttachments((items) => items.filter((item) => !item.path || !pathContains(sourcePath, item.path)));

    if (activeFileRemoved) setActiveFilePath(null);
    if (activeNotebookRemoved && (!fallback || fallback.kind !== "notebook")) clearActiveNotebook();

    if (activeEditorRemoved && fallback) {
      window.setTimeout(() => void activateEditorTab(fallback), 0);
    }
    void refreshNotebooks();
  };

  // Clicking an activity icon: expand to that view, collapse it when it's
  // already the open one, or just switch views. The activity bar always stays
  // visible, so a collapsed side panel can always be restored from here.
  const handleActivitySelect = (tab: LabSideTab) => {
    if (sideCollapsed) {
      setSideCollapsed(false);
      setSideTab(tab);
    } else if (sideTab === tab) {
      setSideCollapsed(true);
    } else {
      setSideTab(tab);
    }
  };

  const handleSideResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.button ?? 0) !== 0 || sideCollapsed) return;
    sideResizeRef.current = { startX: event.clientX, startWidth: sideWidth };
    setResizingPanel("side");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handleSideResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sideResizeRef.current;
    if (!drag) return;
    event.preventDefault();
    const width = clampPanelWidth(
      drag.startWidth + (event.clientX - drag.startX),
      LAB_SIDE_WIDTH_MIN,
      LAB_SIDE_WIDTH_MAX,
    );
    setSideWidth(width);
  };
  const handleSideResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = sideResizeRef.current;
    if (!drag) return;
    const width = clampPanelWidth(
      drag.startWidth + (event.clientX - drag.startX),
      LAB_SIDE_WIDTH_MIN,
      LAB_SIDE_WIDTH_MAX,
    );
    sideResizeRef.current = null;
    setResizingPanel(null);
    setSideWidth(width);
    localStorage.setItem(LAB_SIDE_WIDTH_KEY, String(width));
    localStorage.removeItem(LAB_SIDE_WIDTH_LEGACY_KEY);
  };

  const handleAssistantResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.button ?? 0) !== 0 || !assistantOpen) return;
    assistantResizeRef.current = { startX: event.clientX, startWidth: assistantWidth };
    setResizingPanel("assistant");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handleAssistantResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = assistantResizeRef.current;
    if (!drag) return;
    event.preventDefault();
    const width = clampPanelWidth(
      drag.startWidth + (drag.startX - event.clientX),
      LAB_ASSISTANT_WIDTH_MIN,
      LAB_ASSISTANT_WIDTH_MAX,
    );
    setAssistantWidth(width);
  };
  const handleAssistantResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = assistantResizeRef.current;
    if (!drag) return;
    const width = clampPanelWidth(
      drag.startWidth + (drag.startX - event.clientX),
      LAB_ASSISTANT_WIDTH_MIN,
      LAB_ASSISTANT_WIDTH_MAX,
    );
    assistantResizeRef.current = null;
    setResizingPanel(null);
    setAssistantWidth(width);
    localStorage.setItem(LAB_ASSISTANT_WIDTH_KEY, String(width));
    localStorage.removeItem(LAB_ASSISTANT_WIDTH_LEGACY_KEY);
  };

  const handleOpenNotebook = async (path: string) => {
    ensureEditorTab("notebook", path);
    setActiveFilePath(null);
    await open(path);
  };
  const handleOpenFile = (path: string) => {
    ensureEditorTab("file", path);
    setActiveFilePath(path);
    setSelected(null);
    setMode("command");
  };

  const sideTitle = sideTab === "files" ? "Explorer" : sideTab === "notebook" ? "Notebook" : "Runtime";
  const labStyle = {
    "--lab-side-w": `${sideWidth}px`,
    "--lab-assistant-w": `${assistantWidth}px`,
  } as CSSProperties;
  // Cell actions live behind one stable ref. This lets memoized cells skip
  // rerendering when another cell, the kernel status, or the side panels update
  // while still invoking the newest closures when a user acts on a cell.
  const cellActionsRef = useRef<CellActions>({
    onChange: () => undefined,
    onBlurCode: () => undefined,
    onSelect: () => undefined,
    onCommandKey: () => undefined,
    onEditorKey: () => undefined,
    onRun: () => undefined,
    onMoveUp: () => undefined,
    onMoveDown: () => undefined,
    onDuplicate: () => undefined,
    onDelete: () => undefined,
    onChangeType: () => undefined,
  });
  cellActionsRef.current = {
    onChange: (index, value) => setDrafts((draft) => ({ ...draft, [index]: value })),
    onBlurCode,
    onSelect: select,
    onCommandKey: handleCommandKey,
    onEditorKey: handleEditorKey,
    onRun: runSelected,
    onMoveUp: (index) => void doMoveUp(index),
    onMoveDown: (index) => void doMoveDown(index),
    onDuplicate: (index) => void doDuplicate(index),
    onDelete: (index) => void doDelete(index),
    onChangeType: (index, type) => void doChangeType(index, type),
  };

  return (
    <div className={cx("lab", resizingPanel && "lab-resizing")} style={labStyle}>
      {error && (
        <div className="lab-error" role="alert">
          <span>{error}</span>
          <button onClick={clearError}>dismiss</button>
        </div>
      )}

      <div className="lab-workspace">
        <nav className="lab-activitybar" role="tablist" aria-label="Lab workbench views">
          <button
            className={cx("lab-activity", sideTab === "files" && !sideCollapsed && "active")}
            role="tab"
            aria-selected={sideTab === "files" && !sideCollapsed}
            title={sideTab === "files" && !sideCollapsed ? "Hide Files" : "Files"}
            onClick={() => handleActivitySelect("files")}
          >
            <IconFiles />
            <span>Files</span>
          </button>
          <button
            className={cx("lab-activity", sideTab === "notebook" && !sideCollapsed && "active")}
            role="tab"
            aria-selected={sideTab === "notebook" && !sideCollapsed}
            title={sideTab === "notebook" && !sideCollapsed ? "Hide Notebook" : "Notebook"}
            onClick={() => handleActivitySelect("notebook")}
          >
            <IconNotebook />
            <span>Notebook</span>
          </button>
          <button
            className={cx("lab-activity", sideTab === "runtime" && !sideCollapsed && "active")}
            role="tab"
            aria-selected={sideTab === "runtime" && !sideCollapsed}
            title={sideTab === "runtime" && !sideCollapsed ? "Hide Runtime" : "Runtime"}
            onClick={() => handleActivitySelect("runtime")}
          >
            <IconRuntime />
            <span>Runtime</span>
          </button>
          <div className="lab-activity-spacer" />
          <button
            className={cx("lab-activity", assistantOpen && "active")}
            title={assistantOpen ? "Hide Assistant" : "Show Assistant"}
            onClick={() => setAssistantOpen((open) => !open)}
          >
            <IconAssistant />
            <span>Assistant</span>
            {assistantAttachments.length > 0 && <em>{assistantAttachments.length}</em>}
          </button>
        </nav>

        {!sideCollapsed && (
        <aside className="lab-side">
          {sideTab !== "files" && (
            <div className="lab-side-title">
              <span>{sideTitle}</span>
            </div>
          )}
          <div className={cx("lab-side-content", sideTab === "files" && "files")}>
            {sideTab === "files" && (
              <LabFiles
                projectPath={currentProjectPath}
                notebooks={notebooks}
                activePath={activeItemPath}
                onOpenNotebook={(path) => void handleOpenNotebook(path)}
                onOpenFile={handleOpenFile}
                onAttachToAssistant={attachToAssistant}
                onFileChanged={handleFileChanged}
              />
            )}

            {sideTab === "notebook" && (
              <>
                <section className="lab-panel lab-notebook-controls">
                  <div className="lab-panel-head">
                    <h3>Notebook</h3>
                    <button className="lab-btn ghost" onClick={() => void refreshNotebooks()} disabled={busy}>
                      Refresh
                    </button>
                  </div>
                  <select
                    className="lab-select lab-panel-select"
                    value={activePath ?? ""}
                    onChange={(event) => void handleOpenNotebook(event.target.value)}
                    disabled={busy || notebooks.length === 0}
                    title="Open notebook"
                  >
                    <option value="" disabled>
                      {notebooks.length === 0 ? "No notebooks found" : "Open notebook..."}
                    </option>
                    {notebooks.map((nb) => (
                      <option key={nb} value={nb}>
                        {nb}
                      </option>
                    ))}
                  </select>
                  <div className="lab-new-row">
                    <input
                      className="lab-new"
                      placeholder="notebooks/new-notebook.ipynb"
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleCreate();
                      }}
                    />
                    <button className="lab-btn" onClick={handleCreate} disabled={busy || !newName.trim()}>
                      New
                    </button>
                  </div>
                </section>

                <section className="lab-panel lab-notebook-controls">
                  <div className="lab-panel-head">
                    <h3>Run</h3>
                    <span className={`lab-kernel ${kernelState}`} title={kernelTitle}>
                      <span className="lab-dot" />
                      {running ? kernelName ?? selectedKernel ?? "kernel" : "no kernel"}
                    </span>
                  </div>
                  <div className="lab-command-stack">
                    <button
                      className="lab-btn primary lab-run-all-btn"
                      onClick={() => void handleRunAll()}
                      disabled={!hasCode || busyRunning}
                      title="Run every code cell top to bottom"
                    >
                      <IconRunAll />
                      <span>{runningAll ? `Running ${codeDone}/${codeTotal}...` : "Run all cells"}</span>
                    </button>
                    <button
                      className="lab-btn"
                      onClick={() => void handleRestartRunAll()}
                      disabled={!hasCode || busyRunning}
                      title="Restart the kernel, then run all cells"
                    >
                      Restart &amp; Run all
                    </button>
                    {busyRunning ? (
                      <button className="lab-btn warn" onClick={() => void interruptKernel()} title="Interrupt the kernel">
                        Interrupt
                      </button>
                    ) : (
                      <button className="lab-btn ghost" onClick={() => void clearAllOutputs()} disabled={!showingNotebook} title="Clear all outputs">
                        Clear outputs
                      </button>
                    )}
                  </div>
                </section>

                {toc.length > 0 && (
                  <section className="lab-panel">
                    <div className="lab-panel-head">
                      <h3>Contents</h3>
                    </div>
                    <nav className="lab-toc">
                      {toc.map((item, i) => (
                        <button
                          key={i}
                          className="lab-toc-item"
                          style={{ paddingLeft: `${(item.level - 1) * 12 + 4}px` }}
                          onClick={() => scrollToCell(item.index)}
                          title={item.text}
                        >
                          {item.text}
                        </button>
                      ))}
                    </nav>
                  </section>
                )}

                <section className="lab-panel">
                  <div className="lab-panel-head">
                    <h3>Variables {variables.length > 0 && <span className="lab-count-badge">{variables.length}</span>}</h3>
                    <button
                      className="lab-btn ghost"
                      disabled={variablesBusy || busyRunning}
                      onClick={() => void inspectVariables()}
                    >
                      {variablesBusy ? "Inspecting..." : "Refresh"}
                    </button>
                  </div>
                  {variables.length === 0 ? (
                    <div className="lab-muted">Run a cell, then refresh to inspect kernel variables.</div>
                  ) : (
                    <div className="lab-var-list">
                      {variables.map((variable) => (
                        <VariableRow key={variable.name} variable={variable} />
                      ))}
                    </div>
                  )}
                </section>

                <section className="lab-panel">
                  <div className="lab-panel-head">
                    <h3>Runs</h3>
                    <button className="lab-btn ghost" onClick={() => void refreshRuns()}>
                      Refresh
                    </button>
                  </div>
                  {recentRuns.length === 0 ? (
                    <div className="lab-muted">No runs yet.</div>
                  ) : (
                    <div className="lab-run-list">
                      {recentRuns.map((run) => (
                        <RunRow key={run.id} run={run} onOpen={(path) => void handleOpenNotebook(path)} />
                      ))}
                    </div>
                  )}
                </section>

                <details className="lab-panel lab-panel-details">
                  <summary className="lab-panel-head">
                    <h3>Parameter sweep</h3>
                  </summary>
                  <textarea
                    className="lab-sweep-src"
                    value={sweepSpecText}
                    spellCheck={false}
                    rows={9}
                    onChange={(e) => setSweepSpecText(e.target.value)}
                  />
                  {sweepParseError && <div className="lab-inline-error">{sweepParseError}</div>}
                  <div className="lab-row">
                    <button className="lab-btn primary" disabled={sweepBusy} onClick={() => void handleRunSweep()}>
                      {sweepBusy ? "Working..." : "Run sweep"}
                    </button>
                    <button className="lab-btn" disabled={sweepBusy} onClick={() => void handleExportSweep()}>
                      Export manifest
                    </button>
                  </div>
                  {sweepResult && (
                    <div className="lab-muted">
                      Sweep {sweepResult.sweepId}: {sweepResult.runs.length}/{sweepResult.total} runs recorded.
                    </div>
                  )}
                  {sweepManifest && (
                    <div className="lab-manifest">
                      <div className="lab-panel-subhead">
                        <span>Manifest</span>
                        <button className="lab-btn ghost" onClick={clearSweepManifest}>
                          Clear
                        </button>
                      </div>
                      <textarea className="lab-sweep-src" readOnly rows={8} value={sweepManifest} />
                    </div>
                  )}
                </details>
              </>
            )}

            {sideTab === "runtime" && (
              <>
                <section className="lab-panel lab-runtime-panel">
                  <div className="lab-panel-head">
                    <h3>Interpreter</h3>
                    <button className="lab-btn ghost" onClick={() => void refreshKernelspecs()}>
                      Refresh
                    </button>
                  </div>
                  <select
                    className="lab-select lab-runtime-select"
                    value={selectedKernel ?? ""}
                    onChange={(event) => {
                      if (showingNotebook) void setKernel(event.target.value);
                      else selectKernel(event.target.value);
                    }}
                    disabled={busy || busyRunning || kernelspecs.length === 0}
                    title="Select Python interpreter / notebook kernel"
                  >
                    {kernelspecs.length === 0 ? (
                      <option value="" disabled>
                        No kernels found
                      </option>
                    ) : (
                      kernelspecs.map((spec) => (
                        <option key={spec.name} value={spec.name}>
                          {spec.displayName}
                        </option>
                      ))
                    )}
                  </select>
                  <div className="lab-runtime-summary">
                    <span>Active</span>
                    <strong>{activeSpec?.displayName ?? selectedKernel ?? "No interpreter selected"}</strong>
                    {activeSpec && <em>{activeSpec.language || activeSpec.name}</em>}
                  </div>
                  <div className="lab-muted">
                    Lab uses installed Jupyter kernelspecs. Python files run against a file-scoped kernel session; notebooks persist this choice into nbformat metadata.
                  </div>
                </section>

                <section className="lab-panel lab-runtime-panel">
                  <div className="lab-panel-head">
                    <h3>Notebook Kernel</h3>
                  </div>
                  <div className="lab-runtime-kernel-card">
                    <span className={`lab-kernel ${kernelState}`} title={kernelTitle}>
                      <span className="lab-dot" />
                      {running ? kernelName ?? selectedKernel ?? "kernel" : "no kernel"}
                    </span>
                    <div className="lab-row">
                      {running ? (
                        <>
                          <button className="lab-btn" onClick={() => void restartKernel()} disabled={busy || !showingNotebook}>
                            Restart
                          </button>
                          <button className="lab-btn" onClick={() => void shutdownKernel()} disabled={busy || !showingNotebook}>
                            Stop
                          </button>
                        </>
                      ) : (
                        <button className="lab-btn primary" onClick={() => void startKernel()} disabled={busy || !showingNotebook}>
                          Start kernel
                        </button>
                      )}
                    </div>
                  </div>
                </section>

                <section className="lab-panel lab-runtime-panel">
                  <div className="lab-panel-head">
                    <h3>Kernels</h3>
                  </div>
                  <div className="lab-kernelspec-list">
                    {kernelspecs.length === 0 ? (
                      <div className="lab-muted">No kernels discovered.</div>
                    ) : (
                      kernelspecs.map((spec) => (
                        <button
                          key={spec.name}
                          className={cx("lab-kernelspec-row", selectedKernel === spec.name && "active")}
                          onClick={() => {
                            if (showingNotebook) void setKernel(spec.name);
                            else selectKernel(spec.name);
                          }}
                        >
                          <span>{spec.displayName}</span>
                          <em>{spec.language || spec.name}</em>
                        </button>
                      ))
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
          <div
            className={cx("lab-side-resize-handle", resizingPanel === "side" && "dragging")}
            role="separator"
            aria-label="Resize Lab side panel"
            aria-orientation="vertical"
            title="Resize side panel"
            onPointerDown={handleSideResizeStart}
            onPointerMove={handleSideResizeMove}
            onPointerUp={handleSideResizeEnd}
            onPointerCancel={handleSideResizeEnd}
          />
        </aside>
        )}

        <main className="lab-main">
          <div className="lab-editor-tabs" role="tablist" aria-label="Open editors">
            {openTabs.length === 0 ? (
              <div className="lab-editor-tab-empty">No editors open</div>
            ) : (
              openTabs.map((tab) => (
                <button
                  key={tab.id}
                  className={cx("lab-editor-tab", activeEditorTabId === tab.id && "active")}
                  role="tab"
                  aria-selected={activeEditorTabId === tab.id}
                  title={tab.path}
                  onClick={() => void activateEditorTab(tab)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setTabMenu({ x: event.clientX, y: event.clientY, tabId: tab.id });
                  }}
                >
                  <span className={cx("lab-editor-tab-icon", tab.kind)}>{tab.kind === "notebook" ? "[]" : "<>"}</span>
                  <span className="lab-editor-tab-label">{editorTabLabel(tab)}</span>
                  <span className="lab-editor-tab-dir">{dirname(tab.path)}</span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="lab-editor-tab-close"
                    title="Close editor"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeEditorTab(tab.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        closeEditorTab(tab.id);
                      }
                    }}
                  >
                    <IconClose />
                  </span>
                </button>
              ))
            )}
          </div>

          {tabMenu && (
            <div
              className="lab-tab-menu"
              style={{ left: tabMenu.x, top: tabMenu.y }}
              role="menu"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeEditorTab(tabMenu.tabId);
                  setTabMenu(null);
                }}
              >
                Close
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={openTabs.length <= 1}
                onClick={() => {
                  closeOtherEditorTabs(tabMenu.tabId);
                  setTabMenu(null);
                }}
              >
                Close others
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={openTabs.length === 0}
                onClick={() => {
                  closeAllEditorTabs();
                  setTabMenu(null);
                }}
              >
                Close all
              </button>
            </div>
          )}

          <div className="lab-editor-body">
        {activeFilePath ? (
          <FileEditorPane
            path={activeFilePath}
            kernelspecs={kernelspecs}
            selectedKernel={selectedKernel}
            onSelectKernel={selectKernel}
          />
        ) : !activePath ? (
          <div className="lab-cells">
            <div className="lab-empty-state">
              <div className="lab-empty-state-mark" aria-hidden="true">&lt;/&gt;</div>
              <span className="lab-empty-state-kicker">SOMNIQ CODE</span>
              <h2>Start from a research file</h2>
              <p>Open a notebook or code file, then let SomniQ help you inspect, run, and improve it.</p>
              <div className="lab-empty-state-actions">
                <button type="button" className="lab-empty-state-action primary" onClick={() => handleActivitySelect("notebook")}>
                  <IconNotebook />
                  <span>Open notebook</span>
                </button>
                <button type="button" className="lab-empty-state-action" onClick={() => handleActivitySelect("files")}>
                  <IconFiles />
                  <span>Browse files</span>
                </button>
                <button type="button" className="lab-empty-state-action" onClick={() => setAssistantOpen(true)}>
                  <IconAssistant />
                  <span>Ask SomniQ</span>
                </button>
              </div>
              <span className="lab-empty-state-hint">Python · Jupyter Notebook · project files</span>
            </div>
          </div>
        ) : (
          <div
            className="lab-cells"
            ref={cellsRef}
            onWheel={() => {
              followRef.current = false;
            }}
            onTouchMove={() => {
              followRef.current = false;
            }}
          >
            {hasReview && review && (
              <div className="lab-nb-review-bar" role="status" aria-live="polite">
                <div className="lab-nb-review-info">
                  <strong>检测到 AI 修改</strong>
                  <div className="lab-nb-review-counts">
                    {review.added > 0 && <em className="add">+{review.added} 新增</em>}
                    {review.modified > 0 && <em className="mod">~{review.modified} 修改</em>}
                    {review.removed.length > 0 && <em className="del">-{review.removed.length} 删除</em>}
                  </div>
                  {review.removed.length > 0 && (
                    <div className="lab-nb-review-removed">
                      {review.removed.slice(0, 3).map((cell, i) => (
                        <code key={i} title={cell.source}>
                          - {firstLine(cell.source) || `(空 ${cell.cellType} cell)`}
                        </code>
                      ))}
                      {review.removed.length > 3 && (
                        <em>还有 {review.removed.length - 3} 个被删除的 cell</em>
                      )}
                    </div>
                  )}
                </div>
                <div className="lab-nb-review-actions">
                  <button
                    className="lab-btn primary"
                    type="button"
                    onClick={acceptNotebookReview}
                    disabled={busy}
                    title="保留 AI 修改"
                  >
                    保留
                  </button>
                  <button
                    className="lab-btn"
                    type="button"
                    onClick={() => void revertNotebookReview()}
                    disabled={busy}
                    title="恢复修改前的 notebook"
                  >
                    恢复
                  </button>
                </div>
              </div>
            )}
            {cellCount === 0 ? (
              <div className="lab-empty-nb">
                <p>This notebook is empty.</p>
                <button className="lab-btn primary" onClick={() => void insertAndSelect("code", 0, "edit")}>
                  <IconPlus /> Add a code cell
                </button>
              </div>
            ) : (
              <>
                <InsertBar at={0} onInsert={(type, at) => void insertAndSelect(type, at, "edit")} />
                {cells.map((cell, index) => (
                  <div key={cell.id ?? index} className="lab-cell-slot">
                    <CellView
                      cell={cell}
                      index={index}
                      total={cellCount}
                      selected={selected === index}
                      mode={mode}
                      phase={phaseOf(index, cell.cell_type === "code")}
                      elapsedMs={runningCell === index ? elapsedMs : 0}
                      source={draftOf(index, cell)}
                      changeStatus={review?.status.get(index)}
                      diffLines={review?.lineDiffs.get(index)}
                      disabled={busyRunning}
                      editorLanguage={codeLanguage}
                      actions={cellActionsRef}
                    />
                    <InsertBar at={index + 1} onInsert={(type, at) => void insertAndSelect(type, at, "edit")} />
                  </div>
                ))}
              </>
            )}
          </div>
        )}
          </div>
        </main>

        {assistantOpen && (
          <aside className="lab-assistant-side">
            <div
              className={cx("lab-assistant-resize-handle", resizingPanel === "assistant" && "dragging")}
              role="separator"
              aria-label="Resize Lab Assistant"
              aria-orientation="vertical"
              title="Resize Lab Assistant"
              onPointerDown={handleAssistantResizeStart}
              onPointerMove={handleAssistantResizeMove}
              onPointerUp={handleAssistantResizeEnd}
              onPointerCancel={handleAssistantResizeEnd}
            />
            <LabAssistant
              projectId={currentProjectId}
              projectPath={currentProjectPath}
              activePath={activeItemPath}
              activeKind={activeItemKind}
              cells={activeFilePath ? [] : cells}
              attachments={assistantAttachments}
              onAttachmentsChange={setAssistantAttachments}
            />
          </aside>
        )}

        </div>

        <div className="lab-statusbar">
          <span className={`lab-status-item lab-status-kernel ${kernelState}`}>
            <span className="lab-dot" />
            {running ? kernelName ?? selectedKernel ?? "kernel" : "No kernel"}
          </span>
          {activeSpec && <span className="lab-status-item">{activeSpec.language || activeSpec.name}</span>}
          {activeItemKind === "file" && (
            <span className="lab-status-item">{activeSpec?.displayName ?? selectedKernel ?? "No interpreter"}</span>
          )}
          {showingNotebook && (
            <span className="lab-status-item">
              {selected != null ? `Cell ${selected + 1} of ${cellCount}` : `${cellCount} cells`}
            </span>
          )}
          {runningAll && (
            <span className="lab-status-item lab-status-progress">
              Running {codeDone}/{codeTotal}
            </span>
          )}
          <span className="lab-spacer" />
          {runStartedAt != null && <span className="lab-status-item">{formatElapsed(elapsedMs)}</span>}
          {showingNotebook && activePath && (
            <span className="lab-status-item lab-status-path" title={activePath}>
              {activePath}
            </span>
          )}
          {activeItemKind === "file" && activeItemPath && (
            <span className="lab-status-item lab-status-path" title={activeItemPath}>
              {activeItemPath}
            </span>
          )}
        </div>
    </div>
  );
}
