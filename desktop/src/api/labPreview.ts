import type {
  CellOutput,
  FileExecutionResult,
  KernelInfo,
  KernelSpecInfo,
  NotebookView,
  RunAllResult,
  RunsLibrary,
  VariablesResult,
} from "../lab/labTypes";

interface FileTextLike {
  path: string;
  content: string;
  bytes: number;
}

export interface PreviewFileTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
}

const PREVIEW_NOTEBOOK = "notebooks/lab-preview.ipynb";
const PREVIEW_FILE = "src/analysis.py";

const files = new Map<string, string>([
  [
    PREVIEW_FILE,
    [
      "import math",
      "",
      "radius = 3",
      "area = math.pi * radius ** 2",
      "print(f'area={area:.2f}')",
    ].join("\n"),
  ],
  [
    "README.md",
    [
      "# Lab Preview",
      "",
      "This browser-only mode uses mock Lab data so UI changes can be checked without building the Tauri executable.",
    ].join("\n"),
  ],
  [
    "notebooks/lab-preview.ipynb",
    JSON.stringify({ nbformat: 4, nbformat_minor: 5 }, null, 2),
  ],
]);

export function isLabPreviewMode(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return (
    import.meta.env.VITE_ARIS_LAB_PREVIEW === "1" ||
    params.get("labPreview") === "1" ||
    window.localStorage.getItem("aris-lab-preview") === "true"
  );
}

export function previewKernelspecs(): KernelSpecInfo[] {
  return [
    { name: "python3", displayName: "Python 3 (preview)", language: "python" },
    { name: "matlab", displayName: "MATLAB (preview)", language: "matlab" },
  ];
}

export function previewNotebookView(path = PREVIEW_NOTEBOOK): NotebookView {
  return {
    notebookPath: path,
    notebook: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          name: "python3",
          display_name: "Python 3 (preview)",
          language: "python",
        },
      },
      cells: [
        {
          id: "preview-intro",
          cell_type: "markdown",
          source: [
            "# Lab preview\n",
            "\n",
            "Use this mode to inspect the VS Code-style Lab UI without compiling the desktop executable.",
          ],
        },
        {
          id: "preview-code",
          cell_type: "code",
          source: ["x = 21\n", "x * 2"],
          execution_count: 1,
          outputs: [
            {
              output_type: "execute_result",
              execution_count: 1,
              data: { "text/plain": "42" },
              metadata: {},
            },
          ],
        },
        {
          id: "preview-plot",
          cell_type: "code",
          source: ["print('preview kernel ready')"],
          execution_count: 2,
          outputs: [{ output_type: "stream", name: "stdout", text: "preview kernel ready\n" }],
        },
      ],
    },
    outline: [
      { index: 0, cellType: "markdown", source: "# Lab preview", executionCount: null, outputCount: 0, hasError: false },
      { index: 1, cellType: "code", source: "x = 21\nx * 2", executionCount: 1, outputCount: 1, hasError: false },
      { index: 2, cellType: "code", source: "print('preview kernel ready')", executionCount: 2, outputCount: 1, hasError: false },
    ],
    running: true,
    kernelName: "python3",
  };
}

export function previewNotebookList(): { notebooks: string[] } {
  return { notebooks: [PREVIEW_NOTEBOOK] };
}

export function previewRunsLibrary(): RunsLibrary {
  return {
    version: 1,
    runs: [
      {
        id: "preview-run-1",
        sourceNotebook: PREVIEW_NOTEBOOK,
        status: "ok",
        backend: "local",
        startedAt: Math.floor(Date.now() / 1000) - 180,
        finishedAt: Math.floor(Date.now() / 1000) - 160,
        metrics: { accuracy: 0.98, loss: 0.12 },
      },
    ],
  };
}

export function previewVariables(): VariablesResult {
  return {
    status: "ok",
    variables: [
      { name: "x", type: "int", repr: "42", value: 42 },
      { name: "radius", type: "int", repr: "3", value: 3 },
      { name: "area", type: "float", repr: "28.274333882308138", value: 28.274333882308138 },
    ],
  };
}

export function previewFileTree(path: string | null): PreviewFileTreeEntry[] {
  if (!path) {
    return [
      { name: "notebooks", path: "notebooks", isDir: true },
      { name: "src", path: "src", isDir: true },
      { name: "README.md", path: "README.md", isDir: false },
    ];
  }
  if (path === "notebooks") {
    return [{ name: "lab-preview.ipynb", path: PREVIEW_NOTEBOOK, isDir: false }];
  }
  if (path === "src") {
    return [{ name: "analysis.py", path: PREVIEW_FILE, isDir: false }];
  }
  return [];
}

export function previewReadText(path: string): FileTextLike {
  const content = files.get(path) ?? "";
  return { path, content, bytes: new TextEncoder().encode(content).length };
}

export function previewWriteText(path: string, content: string): FileTextLike {
  files.set(path, content);
  return { path, content, bytes: new TextEncoder().encode(content).length };
}

function outputFor(code: string, path: string): CellOutput[] {
  const trimmed = code.trim();
  if (!trimmed) return [{ output_type: "stream", name: "stdout", text: "Nothing to run.\n" }];
  if (trimmed.includes("area")) {
    return [{ output_type: "stream", name: "stdout", text: "area=28.27\n" }];
  }
  if (trimmed.includes("print")) {
    return [{ output_type: "stream", name: "stdout", text: `Preview executed ${path}\n` }];
  }
  return [{ output_type: "execute_result", execution_count: 3, data: { "text/plain": "42" }, metadata: {} }];
}

export function previewExecuteFile(path: string, code?: string): FileExecutionResult {
  const source = code ?? files.get(path) ?? "";
  return {
    filePath: path,
    status: "ok",
    executionCount: 3,
    outputs: outputFor(source, path),
    kernelName: "python3",
  };
}

export function previewKernelInfo(id = PREVIEW_NOTEBOOK): KernelInfo {
  return { id, pid: 0, kernelName: "python3" };
}

export function previewRunAll(path: string): RunAllResult {
  const view = previewNotebookView(path);
  return {
    status: "ok",
    ran: view.notebook.cells.filter((cell) => cell.cell_type === "code").length,
    cells: [
      { index: 1, status: "ok", executionCount: 1 },
      { index: 2, status: "ok", executionCount: 2 },
    ],
    outline: view.outline,
  };
}
