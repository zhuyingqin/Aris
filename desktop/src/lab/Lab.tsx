import { useEffect, useRef, useState } from "react";

import MarkdownContent from "../chat/MarkdownContent";
import { isTauri, onLabCellOutput } from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment } from "../types";
import { useLabStore } from "./labStore";
import CodeEditor from "./CodeEditor";
import FileEditorPane from "./FileEditorPane";
import LabAssistant from "./LabAssistant";
import LabFiles from "./LabFiles";
import { OutputView } from "./outputs";
import type {
  LabCellOutputEvent,
  NotebookCell,
  RunRecord,
  SweepSpec,
  VariableInfo,
} from "./labTypes";
import "./Lab.css";

type Mode = "command" | "edit";
type CellPhase = "idle" | "queued" | "running";
type LabSideTab = "notebook" | "files" | "assistant";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

function cellSource(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "";
}

function isMarkdown(cell: NotebookCell): boolean {
  return cell.cell_type === "markdown";
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

// ── Icons (inline, currentColor) ─────────────────────────────────────────────
const Icon = ({ d, fill = "none" }: { d: string; fill?: string }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill={fill} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const IconRun = () => <Icon d="M5 3.5 12 8l-7 4.5z" fill="currentColor" />;
const IconUp = () => <Icon d="M4 10l4-4 4 4" />;
const IconDown = () => <Icon d="M4 6l4 4 4-4" />;
const IconCopy = () => <Icon d="M6 6h7v7H6zM3 3h7v2M3 3v7h2" />;
const IconTrash = () => <Icon d="M3 4h10M6.5 4V2.8h3V4M5 4l.6 9h4.8L11 4" />;
const IconPlus = () => <Icon d="M8 3.5v9M3.5 8h9" />;

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

/** Markdown headings across the notebook → a clickable table of contents. */
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
  disabled: boolean;
  onChange: (index: number, value: string) => void;
  onBlurCode: (index: number) => void;
  onSelect: (index: number, mode: Mode) => void;
  onCommandKey: (event: React.KeyboardEvent, index: number) => void;
  onEditorKey: (event: React.KeyboardEvent<HTMLTextAreaElement>, index: number) => void;
  onRun: (index: number) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onChangeType: (index: number, type: "code" | "markdown") => void;
}

function CellView(props: CellViewProps) {
  const { cell, index, total, selected, mode, phase, elapsedMs, source, disabled } = props;
  const code = !isMarkdown(cell);
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
      className={cx("lab-cell", code ? "code" : "md", selected && "selected", selected && `mode-${mode}`, running && "running", queued && "queued")}
      data-cell={index}
      tabIndex={0}
      onFocus={(event) => {
        if (event.target === event.currentTarget) props.onSelect(index, "command");
      }}
      onKeyDown={(event) => props.onCommandKey(event, index)}
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
      </div>

      <div className="lab-cell-body">
        <div className="lab-cell-toolbar" role="toolbar" aria-label="Cell actions">
          <button className="lab-tool" title="Run (Shift+Enter)" disabled={disabled} onClick={() => props.onRun(index)}>
            <IconRun />
          </button>
          <button className="lab-tool" title="Move up" disabled={index === 0} onClick={() => props.onMoveUp(index)}>
            <IconUp />
          </button>
          <button className="lab-tool" title="Move down" disabled={index === total - 1} onClick={() => props.onMoveDown(index)}>
            <IconDown />
          </button>
          <button className="lab-tool" title="Duplicate" onClick={() => props.onDuplicate(index)}>
            <IconCopy />
          </button>
          <button
            className="lab-tool lab-tool-type"
            title={code ? "Convert to Markdown (m)" : "Convert to Code (y)"}
            onClick={() => props.onChangeType(index, code ? "markdown" : "code")}
          >
            {code ? "M↓" : "</>"}
          </button>
          <button className="lab-tool danger" title="Delete (dd)" onClick={() => props.onDelete(index)}>
            <IconTrash />
          </button>
        </div>

        {showRendered ? (
          <div
            className="lab-md"
            onDoubleClick={() => props.onSelect(index, "edit")}
            title="Double-click to edit"
          >
            {source.trim() ? (
              <MarkdownContent text={source} />
            ) : (
              <span className="lab-md-empty">Empty markdown cell — double-click to edit</span>
            )}
          </div>
        ) : (
          <CodeEditor
            value={source}
            language={code ? "python" : "markdown"}
            placeholder={code ? "Type Python here…" : "Type Markdown here…"}
            dataEditor={index}
            onChange={(value) => props.onChange(index, value)}
            onFocus={() => props.onSelect(index, "edit")}
            onBlur={() => code && props.onBlurCode(index)}
            onKeyDown={(event) => props.onEditorKey(event, index)}
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
}

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
  const shape = variable.shape?.length ? variable.shape.join(" × ") : null;
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
    runs,
    variables,
    activePath,
    view,
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
    refreshNotebooks,
    refreshRuns,
    open,
    createNotebook,
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
  const [sideTab, setSideTab] = useState<LabSideTab>("assistant");
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [assistantAttachments, setAssistantAttachments] = useState<ChatAttachment[]>([]);
  const [newName, setNewName] = useState("");
  const [sweepSpecText, setSweepSpecText] = useState("");
  const [sweepParseError, setSweepParseError] = useState<string | null>(null);
  const cellsRef = useRef<HTMLDivElement>(null);
  const lastD = useRef<{ index: number; time: number } | null>(null);
  // Whether execution-follow auto-scroll is armed. A manual wheel/touch scroll
  // disarms it until the next run command re-arms it.
  const followRef = useRef(true);

  const cells: NotebookCell[] = view?.notebook?.cells ?? [];
  const cellCount = cells.length;
  const elapsedMs = useElapsed(runStartedAt);

  useEffect(() => {
    setActiveFilePath(null);
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

  if (!isTauri()) {
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
  const activeItemPath = activeFilePath ?? activePath;
  const activeItemKind = activeFilePath ? "file" : activePath ? "notebook" : null;
  const showingNotebook = !activeFilePath && Boolean(activePath);
  const hasCode = cells.some((c) => c.cell_type === "code");
  const recentRuns = runs.slice(0, 8);
  const busyRunning = runningAll || runningCell !== null;
  const toc = buildToc(cells);
  const codeTotal = cells.filter((c) => c.cell_type === "code").length;
  const codeDone = runningCell === null ? 0 : cells.slice(0, runningCell + 1).filter((c) => c.cell_type === "code").length;

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

  // Run a cell (code → execute, markdown → render) then move per the shortcut.
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

  const handleEditorKey = (event: React.KeyboardEvent<HTMLTextAreaElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      select(index, "command");
      return;
    }
    if (event.key === "Enter" && (event.shiftKey || event.ctrlKey || event.altKey)) {
      event.preventDefault();
      void runWithShortcut(index, event.shiftKey ? "advance" : event.altKey ? "insert" : "stay");
    }
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
    setSideTab("assistant");
  };
  const handleOpenNotebook = async (path: string) => {
    setActiveFilePath(null);
    await open(path);
  };
  const handleOpenFile = (path: string) => {
    setActiveFilePath(path);
    setSelected(null);
    setMode("command");
  };

  return (
    <div className="lab">
      <div className="lab-bar">
        <div className="lab-bar-group">
          <select
            className="lab-select"
            value={activePath ?? ""}
            onChange={(e) => void handleOpenNotebook(e.target.value)}
          >
            <option value="" disabled>
              Select a notebook…
            </option>
            {notebooks.map((nb) => (
              <option key={nb} value={nb}>
                {nb}
              </option>
            ))}
          </select>
          <input
            className="lab-new"
            placeholder="notebooks/new-notebook.ipynb"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
            }}
          />
          <button className="lab-btn" onClick={handleCreate}>
            New
          </button>
          <button className="lab-btn ghost" onClick={() => void refreshNotebooks()} disabled={busy}>
            Refresh
          </button>
        </div>

        {showingNotebook && (
          <div className="lab-bar-group">
            <button
              className="lab-btn"
              onClick={() => void handleRunAll()}
              disabled={!hasCode || busyRunning}
              title="Run every code cell top to bottom"
            >
              {runningAll ? `Running ${codeDone}/${codeTotal}…` : "▶ Run all"}
            </button>
            <button
              className="lab-btn"
              onClick={() => void handleRestartRunAll()}
              disabled={!hasCode || busyRunning}
              title="Restart the kernel, then run all cells"
            >
              ⟳ Restart &amp; Run all
            </button>
            {busyRunning ? (
              <button className="lab-btn warn" onClick={() => void interruptKernel()} title="Interrupt the kernel">
                ■ Interrupt
              </button>
            ) : (
              <button className="lab-btn ghost" onClick={() => void clearAllOutputs()} title="Clear all outputs">
                Clear outputs
              </button>
            )}
          </div>
        )}

        <div className="lab-spacer" />

        <div className="lab-bar-group">
          <span className={`lab-kernel ${running ? "on" : "off"}`} title={running ? "Kernel running" : "Kernel idle"}>
            <span className="lab-dot" />
            {running ? kernelName ?? "python3" : "no kernel"}
          </span>
          {running ? (
            <>
              <button className="lab-btn" onClick={() => void restartKernel()} disabled={busy}>
                Restart
              </button>
              <button className="lab-btn" onClick={() => void shutdownKernel()} disabled={busy}>
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

      {error && (
        <div className="lab-error" role="alert">
          <span>{error}</span>
          <button onClick={clearError}>dismiss</button>
        </div>
      )}

      <div className="lab-workspace">
        {activeFilePath ? (
          <FileEditorPane
            path={activeFilePath}
            onAttachToAssistant={attachToAssistant}
          />
        ) : !activePath ? (
          <div className="lab-cells">
            <div className="lab-empty">Pick a notebook above, or create one to start experimenting.</div>
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
                      disabled={busyRunning}
                      onChange={(i, value) => setDrafts((d) => ({ ...d, [i]: value }))}
                      onBlurCode={onBlurCode}
                      onSelect={select}
                      onCommandKey={handleCommandKey}
                      onEditorKey={handleEditorKey}
                      onRun={runSelected}
                      onMoveUp={(i) => void doMoveUp(i)}
                      onMoveDown={(i) => void doMoveDown(i)}
                      onDuplicate={(i) => void doDuplicate(i)}
                      onDelete={(i) => void doDelete(i)}
                      onChangeType={(i, type) => void doChangeType(i, type)}
                    />
                    <InsertBar at={index + 1} onInsert={(type, at) => void insertAndSelect(type, at, "edit")} />
                  </div>
                ))}
              </>
            )}
          </div>
        )}

          <aside className="lab-side">
            <div className="lab-side-tabs" role="tablist" aria-label="Lab sidebar">
              <button
                className={cx("lab-side-tab", sideTab === "notebook" && "active")}
                onClick={() => setSideTab("notebook")}
                role="tab"
                aria-selected={sideTab === "notebook"}
              >
                Notebook
              </button>
              <button
                className={cx("lab-side-tab", sideTab === "files" && "active")}
                onClick={() => setSideTab("files")}
                role="tab"
                aria-selected={sideTab === "files"}
              >
                Files
              </button>
              <button
                className={cx("lab-side-tab", sideTab === "assistant" && "active")}
                onClick={() => setSideTab("assistant")}
                role="tab"
                aria-selected={sideTab === "assistant"}
              >
                Assistant
                {assistantAttachments.length > 0 && <span>{assistantAttachments.length}</span>}
              </button>
            </div>

            <div className={cx("lab-side-content", sideTab === "assistant" && "assistant", sideTab === "files" && "files")}>
              {sideTab === "notebook" && (
                <>
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
                  {variablesBusy ? "Inspecting…" : "Refresh"}
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
                  {sweepBusy ? "Working…" : "Run sweep"}
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

              {sideTab === "files" && (
                <LabFiles
                  projectPath={currentProjectPath}
                  notebooks={notebooks}
                  activePath={activeItemPath}
                  onOpenNotebook={(path) => void handleOpenNotebook(path)}
                  onOpenFile={handleOpenFile}
                  onAttachToAssistant={attachToAssistant}
                />
              )}

              {sideTab === "assistant" && (
                <LabAssistant
                  projectId={currentProjectId}
                  projectPath={currentProjectPath}
                  activePath={activeItemPath}
                  activeKind={activeItemKind}
                  cells={activeFilePath ? [] : cells}
                  attachments={assistantAttachments}
                  onAttachmentsChange={setAssistantAttachments}
                />
              )}
            </div>
          </aside>
        </div>
    </div>
  );
}
