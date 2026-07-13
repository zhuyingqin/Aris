import { create } from "zustand";

import {
  isTauri,
  labCreateNotebook,
  labEditCell,
  labExecuteCell,
  labExportSweepManifest,
  labInspectVars,
  labInterruptKernel,
  labListKernelspecs,
  labListNotebooks,
  labLoadNotebook,
  labRunAll,
  labRunSweep,
  labSaveNotebook,
  labSetKernelspec,
  labShutdownKernel,
  labStartKernel,
  runsLoad,
} from "../api/tauri";
import { isLabPreviewMode } from "../api/labPreview";
import type {
  ExecuteResult,
  CellOutput,
  KernelSpecInfo,
  LabCellOutputEvent,
  NotebookView,
  RunAllResult,
  RunRecord,
  RunsLibrary,
  SweepResult,
  SweepSpec,
  VariableInfo,
  VariablesResult,
} from "./labTypes";

const asError = (e: unknown) => String(e);

/** The kernel recorded in a notebook's `metadata.kernelspec`, if any. */
const kernelFromView = (view: NotebookView | null): string | null => {
  const meta = view?.notebook?.metadata as { kernelspec?: { name?: string } } | undefined;
  const name = meta?.kernelspec?.name;
  return typeof name === "string" && name ? name : null;
};

/** Default kernel pick: prefer python3, else the first available spec. */
const defaultKernel = (specs: KernelSpecInfo[]): string | null =>
  specs.find((s) => s.name === "python3")?.name ?? specs[0]?.name ?? null;
const latestFirst = (a: RunRecord, b: RunRecord) =>
  (b.startedAt ?? b.finishedAt ?? 0) - (a.startedAt ?? a.finishedAt ?? 0);
const replaceCellOutputs = (
  view: NotebookView | null,
  index: number,
  outputs: CellOutput[],
): NotebookView | null => {
  if (!view || index < 0 || index >= view.notebook.cells.length) return view;
  const cells = [...view.notebook.cells];
  cells[index] = { ...cells[index], outputs };
  return { ...view, notebook: { ...view.notebook, cells } };
};
const sameProject = (state: LabState, projectId: string | null) => state.currentProjectId === projectId;

const cellText = (source: string | string[]): string =>
  Array.isArray(source) ? source.join("") : source ?? "";
const CELL_SIGNATURE_FIELD_SEPARATOR = "\u001f";
const CELL_SIGNATURE_CELL_SEPARATOR = "\u001e";

/** Signature of a notebook's source + structure, ignoring outputs and execution
 *  counts. Used to detect AI/external *edits* without flagging mere re-runs. */
const cellSignature = (cells: NotebookView["notebook"]["cells"]): string =>
  cells.map((cell) => `${cell.cell_type}${CELL_SIGNATURE_FIELD_SEPARATOR}${cellText(cell.source)}`)
    .join(CELL_SIGNATURE_CELL_SEPARATOR);

interface LabState {
  currentProjectId: string | null;
  notebooks: string[];
  /** Kernels the user can pick (Jupyter kernelspecs + native MATLAB). */
  kernelspecs: KernelSpecInfo[];
  /** The kernel selected for the active notebook (kernelspec name). */
  selectedKernel: string | null;
  runs: RunRecord[];
  variables: VariableInfo[];
  activePath: string | null;
  view: NotebookView | null;
  /** Pre-edit baseline notebook JSON while an AI/external change awaits review;
   *  null when there is nothing to review. Drives the cell-diff highlighting. */
  reviewBaseline: NotebookView["notebook"] | null;
  /** True while the Lab Assistant is running a conversation. Pauses the
   *  external-edit poll so we never reload the notebook mid-stream (which would
   *  wipe streaming outputs / flicker the view); the review fires once it ends. */
  assistantBusy: boolean;
  busy: boolean;
  variablesBusy: boolean;
  /** Index of the cell currently executing, if any. */
  runningCell: number | null;
  runningAll: boolean;
  /** When the active execution began (epoch ms), for the live elapsed timer. */
  runStartedAt: number | null;
  sweepBusy: boolean;
  sweepResult: SweepResult | null;
  sweepManifest: string | null;
  error: string | null;

  init: (projectId?: string | null) => void;
  refreshKernelspecs: () => Promise<void>;
  /** Pick a kernel for the active notebook: persist it + restart if one runs. */
  setKernel: (name: string) => Promise<void>;
  /** Pick the Lab runtime without writing notebook metadata. Used by regular files. */
  selectKernel: (name: string) => void;
  refreshNotebooks: (projectId?: string | null) => Promise<void>;
  refreshRuns: (projectId?: string | null) => Promise<void>;
  open: (path: string, projectId?: string | null) => Promise<void>;
  createNotebook: (name: string) => Promise<void>;
  /** Poll disk for an external (AI) notebook edit. When the source/structure
   *  changed, snapshot a review baseline (if none yet) and swap in the new
   *  content. Returns whether it applied a change so the caller can clear any
   *  stale local cell drafts. `hasLocalEdits` suppresses it (never clobber the
   *  user's unsaved typing). */
  checkExternalNotebookEdit: (hasLocalEdits: boolean) => Promise<boolean>;
  /** Report whether the Lab Assistant is mid-conversation (pauses the poll). */
  setAssistantBusy: (busy: boolean) => void;
  /** Accept the AI changes: drop the review baseline (clears highlighting). */
  acceptNotebookReview: () => void;
  /** Revert the notebook to the pre-edit baseline, then clear the review. */
  revertNotebookReview: () => Promise<void>;
  addCell: (cellType: "code" | "markdown") => Promise<void>;
  /** Insert a cell of `cellType` at `index`; resolves to the new cell's index. */
  insertCellAt: (cellType: "code" | "markdown", index: number) => Promise<number>;
  deleteCell: (index: number) => Promise<void>;
  /** Reorder a cell, preserving its outputs (backed by the kernel `move` action). */
  moveCell: (index: number, toIndex: number) => Promise<void>;
  duplicateCell: (index: number) => Promise<void>;
  changeCellType: (index: number, cellType: "code" | "markdown") => Promise<void>;
  clearOutputs: (index: number) => Promise<void>;
  clearAllOutputs: () => Promise<void>;
  restartAndRunAll: () => Promise<void>;
  /** Save a cell's source without reloading the view (code blur-save). */
  persistCell: (index: number, source: string) => Promise<void>;
  /** Save a cell's source and reload (markdown render after editing). */
  saveCell: (index: number, source: string) => Promise<void>;
  runCell: (index: number, source: string) => Promise<void>;
  runAll: (parameters?: Record<string, unknown>) => Promise<void>;
  /** Run every code cell top-to-bottom, lighting each up in turn (Jupyter-style). */
  runAllSequential: () => Promise<void>;
  interruptKernel: () => Promise<void>;
  inspectVariables: () => Promise<void>;
  appendCellOutput: (event: LabCellOutputEvent) => void;
  runSweep: (spec: SweepSpec) => Promise<void>;
  exportSweepManifest: (spec: SweepSpec) => Promise<void>;
  startKernel: () => Promise<void>;
  restartKernel: () => Promise<void>;
  shutdownKernel: () => Promise<void>;
  clearError: () => void;
  clearSweepManifest: () => void;
}

export const useLabStore = create<LabState>((set, get) => ({
  currentProjectId: null,
  notebooks: [],
  kernelspecs: [],
  selectedKernel: null,
  runs: [],
  variables: [],
  activePath: null,
  view: null,
  reviewBaseline: null,
  assistantBusy: false,
  busy: false,
  variablesBusy: false,
  runningCell: null,
  runningAll: false,
  runStartedAt: null,
  sweepBusy: false,
  sweepResult: null,
  sweepManifest: null,
  error: null,

  init: (projectId = null) => {
    if (!isTauri() && !isLabPreviewMode()) return;
    set({
      currentProjectId: projectId,
      notebooks: [],
      selectedKernel: null,
      runs: [],
      variables: [],
      activePath: null,
      view: null,
      reviewBaseline: null,
      assistantBusy: false,
      busy: false,
      variablesBusy: false,
      runningCell: null,
      runningAll: false,
      runStartedAt: null,
      sweepBusy: false,
      sweepResult: null,
      sweepManifest: null,
      error: null,
    });
    void get().refreshKernelspecs();
    void get().refreshNotebooks(projectId);
    void get().refreshRuns(projectId);
  },

  refreshKernelspecs: async () => {
    try {
      const specs = await labListKernelspecs<KernelSpecInfo[]>();
      set((state) => ({
        kernelspecs: specs,
        selectedKernel: state.selectedKernel ?? defaultKernel(specs),
      }));
    } catch (e) {
      set({ error: asError(e) });
    }
  },

  setKernel: async (name) => {
    const { activePath, currentProjectId: projectId, view, kernelspecs } = get();
    if (get().selectedKernel === name) return;
    set({ selectedKernel: name });
    const spec = kernelspecs.find((s) => s.name === name);
    if (activePath) {
      try {
        const next = await labSetKernelspec<NotebookView>(
          activePath,
          name,
          spec?.displayName,
          spec?.language,
        );
        if (sameProject(get(), projectId)) set({ view: next });
      } catch (e) {
        if (sameProject(get(), projectId)) set({ error: asError(e) });
      }
    }
    // Switching kernels means a new process: the manager keys sessions by
    // notebook path and reuses a running one, so restart to honor the choice.
    if (view?.running) await get().restartKernel();
  },

  selectKernel: (name) => {
    set({ selectedKernel: name });
  },

  refreshNotebooks: async (projectId = get().currentProjectId) => {
    try {
      const res = await labListNotebooks<{ notebooks: string[] }>();
      if (!sameProject(get(), projectId)) return;
      const activePath = get().activePath;
      set({
        notebooks: res.notebooks,
        ...(activePath && !res.notebooks.includes(activePath)
          ? { activePath: null, view: null, variables: [] }
          : {}),
      });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  refreshRuns: async (projectId = get().currentProjectId) => {
    try {
      const res = await runsLoad<RunsLibrary>();
      if (!sameProject(get(), projectId)) return;
      set({ runs: [...(res.runs ?? [])].sort(latestFirst) });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  open: async (path, projectId = get().currentProjectId) => {
    set({ busy: true, error: null });
    try {
      const view = await labLoadNotebook<NotebookView>(path);
      if (!sameProject(get(), projectId)) return;
      set({
        activePath: path,
        view,
        reviewBaseline: null,
        variables: [],
        selectedKernel: kernelFromView(view) ?? defaultKernel(get().kernelspecs),
      });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    } finally {
      if (sameProject(get(), projectId)) set({ busy: false });
    }
  },

  checkExternalNotebookEdit: async (hasLocalEdits) => {
    const { activePath, view, currentProjectId: projectId, runningAll, runningCell, assistantBusy } = get();
    if (
      !isTauri() ||
      !activePath ||
      !view ||
      hasLocalEdits ||
      runningAll ||
      runningCell !== null ||
      assistantBusy
    ) {
      return false;
    }
    try {
      const disk = await labLoadNotebook<NotebookView>(activePath);
      const cur = get();
      // Bail if anything moved under us during the async read (project switch,
      // notebook close, a run or a Lab Assistant conversation that started, …).
      if (
        !sameProject(cur, projectId) ||
        cur.activePath !== activePath ||
        !cur.view ||
        cur.runningAll ||
        cur.runningCell !== null ||
        cur.assistantBusy
      ) {
        return false;
      }
      // Only react to source/structure edits — re-runs change outputs on disk
      // but are not "modifications" to review.
      if (cellSignature(cur.view.notebook.cells) === cellSignature(disk.notebook.cells)) {
        return false;
      }
      set({
        view: disk,
        reviewBaseline: cur.reviewBaseline ?? structuredClone(cur.view.notebook),
      });
      return true;
    } catch {
      return false;
    }
  },

  setAssistantBusy: (busy) => {
    if (get().assistantBusy !== busy) set({ assistantBusy: busy });
  },

  acceptNotebookReview: () => set({ reviewBaseline: null }),

  revertNotebookReview: async () => {
    const { activePath, reviewBaseline, currentProjectId: projectId } = get();
    if (!activePath || !reviewBaseline) return;
    set({ busy: true, error: null });
    try {
      const view = await labSaveNotebook<NotebookView>(activePath, reviewBaseline);
      if (!sameProject(get(), projectId)) return;
      set({ view, reviewBaseline: null });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    } finally {
      if (sameProject(get(), projectId)) set({ busy: false });
    }
  },

  createNotebook: async (name) => {
    const projectId = get().currentProjectId;
    let path = name.trim();
    if (!path) return;
    if (!path.endsWith(".ipynb")) path += ".ipynb";
    if (!/[\\/]/.test(path)) path = `notebooks/${path}`;
    set({ busy: true, error: null });
    try {
      const view = await labCreateNotebook<NotebookView>(path);
      if (!sameProject(get(), projectId)) return;
      set({
        activePath: path,
        view,
        reviewBaseline: null,
        variables: [],
        selectedKernel: kernelFromView(view) ?? defaultKernel(get().kernelspecs),
      });
      await get().refreshNotebooks(projectId);
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    } finally {
      if (sameProject(get(), projectId)) set({ busy: false });
    }
  },

  addCell: async (cellType) => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath) return;
    try {
      const view = await labEditCell<NotebookView>(activePath, "insert", { cellType, source: "" });
      if (!sameProject(get(), projectId)) return;
      set({ view });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  insertCellAt: async (cellType, index) => {
    const { activePath, currentProjectId: projectId, view } = get();
    const at = Math.min(Math.max(index, 0), view?.notebook.cells.length ?? 0);
    if (!activePath) return at;
    try {
      const next = await labEditCell<NotebookView>(activePath, "insert", { cellType, source: "", cellIndex: at });
      if (sameProject(get(), projectId)) set({ view: next });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
    return at;
  },

  deleteCell: async (index) => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath) return;
    try {
      const view = await labEditCell<NotebookView>(activePath, "delete", { cellIndex: index });
      if (!sameProject(get(), projectId)) return;
      set({ view });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  moveCell: async (index, toIndex) => {
    const { activePath, currentProjectId: projectId, view } = get();
    if (!activePath || !view) return;
    const count = view.notebook.cells.length;
    const to = Math.min(Math.max(toIndex, 0), count - 1);
    if (index === to || index < 0 || index >= count) return;
    try {
      const next = await labEditCell<NotebookView>(activePath, "move", { cellIndex: index, toIndex: to });
      if (!sameProject(get(), projectId)) return;
      set({ view: next });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  duplicateCell: async (index) => {
    const { activePath, currentProjectId: projectId, view } = get();
    if (!activePath || !view) return;
    const cell = view.notebook.cells[index];
    if (!cell) return;
    const cellType = cell.cell_type === "markdown" ? "markdown" : "code";
    const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "";
    try {
      const next = await labEditCell<NotebookView>(activePath, "insert", { cellType, source, cellIndex: index + 1 });
      if (!sameProject(get(), projectId)) return;
      set({ view: next });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  changeCellType: async (index, cellType) => {
    const { activePath, currentProjectId: projectId, view } = get();
    if (!activePath || !view) return;
    const cell = view.notebook.cells[index];
    if (!cell) return;
    const current = cell.cell_type === "markdown" ? "markdown" : "code";
    if (current === cellType) return;
    const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "";
    try {
      await labEditCell<NotebookView>(activePath, "insert", { cellType, source, cellIndex: index });
      if (!sameProject(get(), projectId)) return;
      const next = await labEditCell<NotebookView>(activePath, "delete", { cellIndex: index + 1 });
      if (!sameProject(get(), projectId)) return;
      set({ view: next });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  clearOutputs: async (index) => {
    const { activePath, currentProjectId: projectId, view } = get();
    if (!activePath || !view) return;
    const cell = view.notebook.cells[index];
    if (!cell || cell.cell_type !== "code") return;
    const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "";
    try {
      const next = await labEditCell<NotebookView>(activePath, "replace", { cellIndex: index, source });
      if (!sameProject(get(), projectId)) return;
      set({ view: next });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  clearAllOutputs: async () => {
    const { activePath, currentProjectId: projectId, view } = get();
    if (!activePath || !view) return;
    try {
      let latest: NotebookView | null = null;
      const cells = view.notebook.cells;
      for (let i = 0; i < cells.length; i += 1) {
        const cell = cells[i];
        if (cell.cell_type !== "code" || !cell.outputs?.length) continue;
        const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? "";
        latest = await labEditCell<NotebookView>(activePath, "replace", { cellIndex: i, source });
        if (!sameProject(get(), projectId)) return;
      }
      if (latest) set({ view: latest });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  restartAndRunAll: async () => {
    await get().restartKernel();
    await get().runAllSequential();
  },

  persistCell: async (index, source) => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath) return;
    try {
      await labEditCell<NotebookView>(activePath, "replace", { cellIndex: index, source });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  saveCell: async (index, source) => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath) return;
    try {
      const view = await labEditCell<NotebookView>(activePath, "replace", { cellIndex: index, source });
      if (!sameProject(get(), projectId)) return;
      set({ view });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  runCell: async (index, source) => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath || get().runningAll) return;
    set({ runningCell: index, runStartedAt: Date.now(), error: null });
    try {
      // Persist the latest edits, run the cell, then reload to pick up outputs.
      await labEditCell<NotebookView>(activePath, "replace", { cellIndex: index, source });
      if (!sameProject(get(), projectId)) return;
      set((state) => ({ view: replaceCellOutputs(state.view, index, []) }));
      await labExecuteCell<ExecuteResult>(activePath, {
        cellIndex: index,
        kernel: get().selectedKernel ?? undefined,
      });
      if (!sameProject(get(), projectId)) return;
      const view = await labLoadNotebook<NotebookView>(activePath);
      if (!sameProject(get(), projectId)) return;
      set({ view });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    } finally {
      if (sameProject(get(), projectId)) set({ runningCell: null, runStartedAt: null });
    }
  },

  runAll: async (parameters) => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath || get().runningCell !== null) return;
    const hasParameters = parameters && Object.keys(parameters).length > 0;
    set({ runningAll: true, runStartedAt: Date.now(), error: null });
    try {
      await labRunAll<RunAllResult>(activePath, {
        parameters: hasParameters ? parameters : undefined,
        kernel: get().selectedKernel ?? undefined,
      });
      if (!sameProject(get(), projectId)) return;
      const view = await labLoadNotebook<NotebookView>(activePath);
      if (!sameProject(get(), projectId)) return;
      set({ view });
      await get().refreshRuns(projectId);
    } catch (e) {
      if (sameProject(get(), projectId)) {
        set({ error: asError(e) });
        await get().refreshRuns(projectId);
      }
    } finally {
      if (sameProject(get(), projectId)) set({ runningAll: false, runStartedAt: null });
    }
  },

  // Interactive "Run all": instead of one blocking server call, step through the
  // code cells, executing each via the single-cell streaming path so the UI shows
  // them light up one-by-one (queued → running → done) like classic Jupyter.
  runAllSequential: async () => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath || get().runningAll || get().runningCell !== null) return;
    set({ runningAll: true, error: null });
    try {
      const loaded = await labLoadNotebook<NotebookView>(activePath);
      if (!sameProject(get(), projectId)) return;
      set({ view: loaded });
      const codeIndices = loaded.notebook.cells
        .map((cell, index) => (cell.cell_type === "code" ? index : -1))
        .filter((index) => index >= 0);
      for (const index of codeIndices) {
        if (!sameProject(get(), projectId)) return;
        set({ runningCell: index, runStartedAt: Date.now() });
        // Clear this cell's outputs so streamed output replaces (not appends to) stale results.
        set((state) => ({ view: replaceCellOutputs(state.view, index, []) }));
        const result = await labExecuteCell<ExecuteResult>(activePath, {
          cellIndex: index,
          kernel: get().selectedKernel ?? undefined,
        });
        if (!sameProject(get(), projectId)) return;
        set((state) => {
          if (!state.view) return {};
          const cells = [...state.view.notebook.cells];
          if (cells[index]) {
            cells[index] = { ...cells[index], outputs: result.outputs, execution_count: result.executionCount };
          }
          return { view: { ...state.view, notebook: { ...state.view.notebook, cells } } };
        });
        if (result.status === "error" || result.status === "timeout") break; // stop on failure
      }
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    } finally {
      if (sameProject(get(), projectId)) set({ runningCell: null, runningAll: false, runStartedAt: null });
    }
  },

  interruptKernel: async () => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath) return;
    try {
      await labInterruptKernel(activePath);
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  inspectVariables: async () => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath) return;
    set({ variablesBusy: true, error: null });
    try {
      const result = await labInspectVars<VariablesResult>(
        activePath,
        get().selectedKernel ?? undefined,
      );
      if (!sameProject(get(), projectId)) return;
      set({ variables: result.variables ?? [] });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    } finally {
      if (sameProject(get(), projectId)) set({ variablesBusy: false });
    }
  },

  appendCellOutput: (event) => {
    const { activePath, view } = get();
    if (!view || activePath !== event.notebookPath || event.cellIndex === null) return;
    const index = event.cellIndex;
    // A `clear_output` signal drops the cell's shown outputs rather than adding
    // one — this is what stops a redrawing tqdm bar from flooding the cell.
    if ((event.output as { type?: string })?.type === "clear") {
      set({ view: replaceCellOutputs(view, index, []) });
      return;
    }
    const current = view.notebook.cells[index]?.outputs ?? [];
    set({ view: replaceCellOutputs(view, index, [...current, event.output]) });
  },

  runSweep: async (spec) => {
    const projectId = get().currentProjectId;
    set({ sweepBusy: true, error: null, sweepResult: null });
    try {
      const result = await labRunSweep<SweepResult>(spec);
      if (!sameProject(get(), projectId)) return;
      set({ sweepResult: result });
      await get().refreshRuns(projectId);
    } catch (e) {
      if (sameProject(get(), projectId)) {
        set({ error: asError(e) });
        await get().refreshRuns(projectId);
      }
    } finally {
      if (sameProject(get(), projectId)) set({ sweepBusy: false });
    }
  },

  exportSweepManifest: async (spec) => {
    const projectId = get().currentProjectId;
    set({ sweepBusy: true, error: null, sweepManifest: null });
    try {
      const manifest = await labExportSweepManifest(spec);
      if (!sameProject(get(), projectId)) return;
      set({ sweepManifest: manifest });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    } finally {
      if (sameProject(get(), projectId)) set({ sweepBusy: false });
    }
  },

  startKernel: async () => {
    const { activePath, currentProjectId: projectId, selectedKernel } = get();
    if (!activePath) return;
    set({ busy: true, error: null });
    try {
      await labStartKernel(activePath, selectedKernel ?? undefined);
      if (!sameProject(get(), projectId)) return;
      const view = await labLoadNotebook<NotebookView>(activePath);
      if (!sameProject(get(), projectId)) return;
      set({ view });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    } finally {
      if (sameProject(get(), projectId)) set({ busy: false });
    }
  },

  restartKernel: async () => {
    const { activePath, currentProjectId: projectId, selectedKernel } = get();
    if (!activePath) return;
    set({ busy: true, error: null });
    try {
      await labShutdownKernel(activePath);
      if (!sameProject(get(), projectId)) return;
      await labStartKernel(activePath, selectedKernel ?? undefined);
      if (!sameProject(get(), projectId)) return;
      const view = await labLoadNotebook<NotebookView>(activePath);
      if (!sameProject(get(), projectId)) return;
      set({ view });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    } finally {
      if (sameProject(get(), projectId)) set({ busy: false });
    }
  },

  shutdownKernel: async () => {
    const { activePath, currentProjectId: projectId } = get();
    if (!activePath) return;
    try {
      await labShutdownKernel(activePath);
      if (!sameProject(get(), projectId)) return;
      const view = await labLoadNotebook<NotebookView>(activePath);
      if (!sameProject(get(), projectId)) return;
      set({ view });
    } catch (e) {
      if (sameProject(get(), projectId)) set({ error: asError(e) });
    }
  },

  clearError: () => set({ error: null }),
  clearSweepManifest: () => set({ sweepManifest: null }),
}));
