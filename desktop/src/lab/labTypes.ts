// Types mirroring the `notebook` crate + `lab` Tauri commands. Top-level command
// payloads are camelCase; nbformat cell/output fields stay snake_case (they map
// straight to the on-disk `.ipynb`).

export type KernelCellOutput =
  | { type: "stream"; name: string; text: string }
  | { type: "execute_result"; execution_count: number | null; data: Record<string, unknown> }
  | { type: "display_data"; data: Record<string, unknown> }
  | { type: "error"; ename: string; evalue: string; traceback: string[] };

export type NotebookCellOutput =
  | { output_type: "stream"; name?: string; text?: string | string[] }
  | {
      output_type: "execute_result";
      execution_count?: number | null;
      data?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }
  | { output_type: "display_data"; data?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { output_type: "error"; ename?: string; evalue?: string; traceback?: string[] };

export type CellOutput = KernelCellOutput | NotebookCellOutput;

export interface NotebookCell {
  cell_type: string;
  source: string | string[];
  outputs?: CellOutput[];
  execution_count?: number | null;
  id?: string;
}

export interface CellSummary {
  index: number;
  cellType: string;
  source: string;
  executionCount: number | null;
  outputCount: number;
  hasError: boolean;
}

export interface NotebookView {
  notebookPath: string;
  notebook: { cells: NotebookCell[]; [k: string]: unknown };
  outline: CellSummary[];
  running: boolean;
  kernelName?: string | null;
}

export interface KernelInfo {
  id: string;
  pid: number;
  kernelName: string;
}

/** An available kernel the user can pick (Jupyter kernelspec or native MATLAB). */
export interface KernelSpecInfo {
  name: string;
  displayName: string;
  language: string;
}

export interface ExecuteResult {
  status: "ok" | "error" | "timeout";
  executionCount: number | null;
  outputs: CellOutput[];
  cellIndex: number | null;
  outline: CellSummary[];
}

export interface LabCellOutputEvent {
  notebookPath: string;
  cellIndex: number | null;
  output: CellOutput;
}

export interface LabFileOutputEvent {
  filePath: string;
  output: CellOutput;
}

export interface FileExecutionResult {
  filePath: string;
  status: "ok" | "error" | "timeout";
  executionCount: number | null;
  outputs: CellOutput[];
  kernelName?: string | null;
}

export interface CellRun {
  index: number;
  status: "ok" | "error" | "timeout";
  executionCount: number | null;
}

export interface RunAllResult {
  status: "ok" | "error" | "timeout";
  ran: number;
  cells: CellRun[];
  outline: CellSummary[];
  executedPath?: string | null;
  run?: RunRecord | null;
}

export interface VariableInfo {
  name: string;
  type: string;
  repr: string;
  shape?: Array<number | string> | null;
  value?: unknown;
}

export interface VariablesResult {
  status: "ok" | "error" | "timeout";
  variables: VariableInfo[];
}

/** One row of `experiments/runs.json`. */
export interface RunRecord {
  id: string;
  sourceNotebook: string;
  status: "queued" | "running" | "ok" | "error" | "timeout";
  backend: "local" | "gpu";
  params?: Record<string, unknown>;
  seed?: number | null;
  executedPath?: string | null;
  outputsDir?: string | null;
  sweepId?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  metrics?: Record<string, unknown>;
  error?: string;
}

export interface RunsLibrary {
  version: number;
  runs: RunRecord[];
}

/** Sweep grid: seeds × cartesian product of param value-lists. */
export interface SweepSpec {
  notebook: string;
  seeds?: number[];
  params?: Record<string, unknown[]>;
  stop_on_error?: boolean;
  timeout_secs?: number;
  kernel?: string;
}

export interface SweepResult {
  sweepId: string;
  total: number;
  runs: { id: string; seed: number | null; status: string }[];
}
