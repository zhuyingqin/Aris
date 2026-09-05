import slidesMainPdfUrl from "../typeset/fixtures/slides-main.pdf?url";
import slidesMainTex from "../typeset/fixtures/slides-main.tex?raw";

interface FileTextLike {
  path: string;
  content: string;
  bytes: number;
  version: string;
}
function previewTextVersion(content: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(content)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `preview:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
export interface PreviewFileTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
}

const PREVIEW_FILE = "src/analysis.py";
const PREVIEW_TEX_FILE = "papers/article.tex";
const PREVIEW_SLIDES_TEX_FILE = "slides/main.tex";
const PREVIEW_SLIDES_PDF_FILE = "slides/main.pdf";
const PREVIEW_FIGURE_FILE = "figures/visual-editor.svg";
const PREVIEW_PNG_FIGURE_FILE = "figures/visual-editor.png";
const previewPngFigureUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAAoCAYAAAABk/85AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAEHSURBVGhD7dGxDQJBDERR6qAJctqiDBqlBkACbUDyA8BrL4N8E7zkpNuR/HfX2/1hOjt+sN9yADEHEHMAMQcQcwAxBxBzALFNBtifLl/jv9U+Bjicjz/F/Uo8bgTfqrKJADxmBt/Oah+AB6zAjYzWAXi4Stya1TYAD7YCN2c4QAI3Z7QMwEOtxO0oB0jidpQDJHE7ygGSuB3VLgAPtBr3o9oFGHiklbgd5QBJ3I5ygCRuRzlAErejWgYYeKgVuDnDARK4OaNtgIEHq8StWa0DDDxcBW5ktA8w8IAZfDvrY4BOeMwIvlVlUwFeeNx3+G+1TQb4Jw4g5gBiDiDmAGIOIOYAYg4g9gTTILK29jj45AAAAABJRU5ErkJggg==";

const files = new Map<string, string>([
  [PREVIEW_SLIDES_TEX_FILE, slidesMainTex],
  [
    PREVIEW_TEX_FILE,
    [
      '\\documentclass[11pt,a4paper]{article}',
      '\\usepackage[margin=0.86in]{geometry}',
      '\\usepackage{graphicx}',
      '\\usepackage{booktabs}',
      '\\usepackage{xcolor}',
      '\\usepackage{amsmath}',
      '\\newtheorem{theorem}{Theorem}',
      '\\title{Error Probability Distribution Compensation for Improved Wind Speed Forecasting}',
      '\\author{Sir CV Radhakrishnan$^{a,c,*}$, Han Theh Thanh$^{b,d}$, CV Rajagopal Jr$^{b,c}$ and Rishi T.$^{a,c,**}$}',
      '\\date{}',
      '\\begin{document}',
      '\\maketitle',
      '\\entrymeta{Elsevier B.V., Radarweg 29, Amsterdam, The Netherlands \\quad CAS-Q1 \\quad DOI: \\texttt{10.1016/j.energy.2026.1100}}',
      '\\entrykeywords{Echo State Network, Bayesian Linear Regression, Wind Speed Forecasting, Wake Effect, Error Compensation, Uncertainty Quantification}',
      '\\entryabstract{[EN] Accurate and reliable wind speed forecasting is essential for wind farm operation under wake-affected conditions. However, wake interactions often induce nonlinear and non-stationary fluctuations, which degrade the performance of conventional deterministic prediction models. To address this issue, we propose a two-stage forecasting framework termed Bayesian Linear Regression-based Echo State Network (BLRESN), in which the echo state network captures temporal dependence and a Bayesian error compensation layer provides interval reliability.}',
      '\\section{Introduction}',
      '\\label{sec:intro}',
      'The global energy landscape is currently navigating a period of instability, which requires a balanced energy transition that prioritizes the security of supply, economic viability, and environmental sustainability. Wind energy is a key component of this transition, driving the expansion of green energy initiatives around the world. However, the inherent variability and intermittency of wind resources introduce uncertainties into wind power generation.',
      '',
      'Currently, mainstream wind speed prediction methods contain two main categories: data-driven models and physics-based models. Physics-based models rely on atmospheric equations and large-scale computations. Data-driven approaches such as Support Vector Machines, Artificial Neural Networks, Random Forests, and deep recurrent architectures have significantly improved nonlinear processing, but their accuracy frequently drops under wind condition shifts \\cite{jaeger2001echo, maass2002realtime}.',
      '',
      'To bridge this gap, researchers have combined prediction algorithms with decomposition and compensation strategies. As formulated in Section~\\ref{sec:intro} and validated in Section~\\ref{sec:results} (see page~\\pageref{sec:results}), we build a two-stage decomposition-prediction framework and expose the full article structure in the Visual editor so the source remains editable while the layout resembles an online LaTeX editor.',
      '\\begin{itemize}',
      '\\item The echo state network learns temporal dependence from wake-sensitive wind speed sequences.',
      '\\item The Bayesian compensation layer estimates residual distributions and interval uncertainty.',
      '\\end{itemize}',
      '\\begin{equation}',
      '\\label{eq:bayes}',
      'p(y\\mid x)=\\int p(y\\mid x,w)p(w\\mid \\mathcal{D})\\,dw',
      '\\end{equation}',
      'Under Equation~\\eqref{eq:bayes}, the predictive distribution incorporates epistemic uncertainty directly.',
      '\\begin{figure}[h]',
      '\\centering',
      '\\includegraphics[width=.72\\linewidth]{figures/visual-editor.svg}',
      '\\caption{BLRESN visual workflow from LaTeX source blocks to editable article widgets.}',
      '\\label{fig:workflow}',
      '\\end{figure}',
      '\\begin{table}[h]',
      '\\centering',
      '\\begin{tabular}{lll}',
      '\\toprule',
      'Model & MAE & Coverage \\\\',
      'SVR & 0.184 & 71.2\\% \\\\',
      'ESN & 0.151 & 78.4\\% \\\\',
      'BLRESN & 0.119 & 91.8\\% \\\\',
      '\\bottomrule',
      '\\end{tabular}',
      '\\end{table}',
      '\\begin{theorem}[Residual compensation]',
      'If residual variance is bounded and the posterior correction is calibrated, the compensated interval forecast improves reliability under wake-dominant sectors.',
      '\\end{theorem}',
      '\\section{Experimental Results and Analysis}',
      '\\label{sec:results}',
      'Experimental validation across turbulence-sensitive sectors confirms the generalization capability of the proposed framework. The Visual editor keeps figures, tables, citations, equations, and theorem-like blocks directly editable from the article surface.\\footnote{This browser preview uses mock data; the desktop build compiles the actual LaTeX source.}',
      '\\end{document}',
    ].join("\n"),
  ],
  [
    PREVIEW_FIGURE_FILE,
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="420" viewBox="0 0 960 420">',
      '<rect width="960" height="420" rx="22" fill="#11171d"/>',
      '<rect x="54" y="70" width="210" height="280" rx="12" fill="#1b2430" stroke="#2f8b3a" stroke-width="3"/>',
      '<rect x="374" y="70" width="210" height="280" rx="12" fill="#17202a" stroke="#6aa4ff" stroke-width="3"/>',
      '<rect x="696" y="70" width="210" height="280" rx="12" fill="#171d23" stroke="#c9a45c" stroke-width="3"/>',
      '<path d="M278 210h72M598 210h72" stroke="#d9e2ea" stroke-width="8" stroke-linecap="round"/>',
      '<path d="m340 188 28 22-28 22M660 188l28 22-28 22" fill="none" stroke="#d9e2ea" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>',
      '<text x="159" y="132" text-anchor="middle" fill="#edf2f5" font-family="Arial, sans-serif" font-size="28" font-weight="700">LaTeX source</text>',
      '<text x="479" y="132" text-anchor="middle" fill="#edf2f5" font-family="Arial, sans-serif" font-size="28" font-weight="700">Parser</text>',
      '<text x="801" y="132" text-anchor="middle" fill="#edf2f5" font-family="Arial, sans-serif" font-size="28" font-weight="700">Visual widgets</text>',
      '<text x="159" y="198" text-anchor="middle" fill="#bac4cc" font-family="Consolas, monospace" font-size="22">figure</text>',
      '<text x="159" y="236" text-anchor="middle" fill="#bac4cc" font-family="Consolas, monospace" font-size="22">tabular</text>',
      '<text x="159" y="274" text-anchor="middle" fill="#bac4cc" font-family="Consolas, monospace" font-size="22">theorem</text>',
      '<text x="479" y="198" text-anchor="middle" fill="#bac4cc" font-family="Arial, sans-serif" font-size="22">body blocks</text>',
      '<text x="479" y="236" text-anchor="middle" fill="#bac4cc" font-family="Arial, sans-serif" font-size="22">inline marks</text>',
      '<text x="479" y="274" text-anchor="middle" fill="#bac4cc" font-family="Arial, sans-serif" font-size="22">source ranges</text>',
      '<text x="801" y="198" text-anchor="middle" fill="#bac4cc" font-family="Arial, sans-serif" font-size="22">caption editor</text>',
      '<text x="801" y="236" text-anchor="middle" fill="#bac4cc" font-family="Arial, sans-serif" font-size="22">cell editor</text>',
      '<text x="801" y="274" text-anchor="middle" fill="#bac4cc" font-family="Arial, sans-serif" font-size="22">environment editor</text>',
      '</svg>',
    ].join(""),
  ],
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
      "# Browser Preview",
      "",
      "This browser-only mode uses mock workspace data so UI changes can be checked without building the Tauri executable.",
    ].join("\n"),
  ],
]);

const binaryFiles = new Map<string, string>([
  [PREVIEW_SLIDES_PDF_FILE, slidesMainPdfUrl],
  [PREVIEW_PNG_FIGURE_FILE, previewPngFigureUrl],
]);

const explicitDirs = new Set<string>(["slides", "papers", "figures", "notebooks", "src"]);

function normalizePreviewPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function previewBasename(path: string): string {
  return normalizePreviewPath(path).split("/").pop() || path;
}

function previewDirname(path: string): string {
  const normalized = normalizePreviewPath(path);
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "";
}

function previewFileExists(path: string): boolean {
  const normalized = normalizePreviewPath(path);
  return files.has(normalized) || binaryFiles.has(normalized);
}

function previewDirExists(path: string): boolean {
  const normalized = normalizePreviewPath(path);
  if (!normalized) return true;
  if (explicitDirs.has(normalized)) return true;
  const prefix = `${normalized}/`;
  return Array.from(files.keys()).some((key) => key.startsWith(prefix)) ||
    Array.from(binaryFiles.keys()).some((key) => key.startsWith(prefix));
}

function ensurePreviewParentDirs(path: string) {
  const parts = normalizePreviewPath(path).split("/");
  let current = "";
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index];
    if (current) explicitDirs.add(current);
  }
}

export function isTypesetPreviewMode(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  // Persist the flag once seen so it survives reloads/navigation that strip the
  // query string. Without this the browser preview falls back to the real Tauri
  // `invoke`, which is undefined in a plain browser and crashes the Typeset tab
  // — a browser/app inconsistency while testing.
  try {
    if (params.get("typesetPreview") === "1") {
      window.localStorage.setItem("somniq-typeset-preview", "true");
    }
  } catch {
    // Storage disabled — fall back to the query param only.
  }
  return (
    import.meta.env.VITE_ARIS_TYPESET_PREVIEW === "1" ||
    params.get("typesetPreview") === "1" ||
    (() => {
      try {
        return window.localStorage.getItem("somniq-typeset-preview") === "true";
      } catch {
        return false;
      }
    })()
  );
}

function isPlainBrowserRuntime(): boolean {
  return typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
}

export function isFilePreviewMode(): boolean {
  return isPlainBrowserRuntime() || isTypesetPreviewMode();
}

export function previewFileTree(path: string | null): PreviewFileTreeEntry[] {
  const parent = normalizePreviewPath(path ?? "");
  const entries = new Map<string, PreviewFileTreeEntry>();

  for (const dir of explicitDirs) {
    const entryParent = previewDirname(dir);
    if (entryParent !== parent) continue;
    entries.set(dir, { name: previewBasename(dir), path: dir, isDir: true });
  }

  for (const filePath of [...files.keys(), ...binaryFiles.keys()]) {
    const normalized = normalizePreviewPath(filePath);
    const dir = previewDirname(normalized);
    if (dir === parent) {
      entries.set(normalized, { name: previewBasename(normalized), path: normalized, isDir: false });
      continue;
    }
    if (!parent && dir) {
      const root = normalized.split("/")[0];
      entries.set(root, { name: root, path: root, isDir: true });
    } else if (dir.startsWith(`${parent}/`)) {
      const next = normalized.slice(parent.length + 1).split("/")[0];
      const childPath = `${parent}/${next}`;
      entries.set(childPath, { name: next, path: childPath, isDir: true });
    }
  }

  return Array.from(entries.values()).sort((left, right) =>
    Number(right.isDir) - Number(left.isDir) ||
    left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
    left.name.localeCompare(right.name),
  );
}

export function previewSearchFiles(pattern: string, root?: string | null): string[] {
  const normalizedRoot = root?.replace(/\\/g, "/").replace(/\/+$/, "");
  const wantsTex = /\.tex$/i.test(pattern);
  return Array.from(files.keys())
    .filter((path) => !normalizedRoot || path === normalizedRoot || path.startsWith(`${normalizedRoot}/`))
    .filter((path) => (wantsTex ? path.endsWith(".tex") : true))
    .sort((left, right) => left.localeCompare(right));
}

/** Mirrors the desktop Typeset library command for browser-only previews. */
export function previewListTypesetDocuments() {
  const now = Date.now();
  const documents = [
    {
      path: PREVIEW_SLIDES_TEX_FILE,
      projectPath: "slides",
      title: "Inverse Reinforcement Learning — Theory, Practice & Frontiers",
      kind: "beamer" as const,
      modifiedEpochMs: now - 2 * 60 * 60 * 1000,
      compileState: "fresh" as const,
    },
    {
      path: PREVIEW_TEX_FILE,
      projectPath: "papers",
      title: "Error Probability Distribution Compensation for Improved Wind Speed Forecasting",
      kind: "article" as const,
      modifiedEpochMs: now - 26 * 60 * 60 * 1000,
      compileState: "missing" as const,
    },
  ];
  const projects = ["slides", "papers"].map((path) => ({
    path,
    name: path,
    texFileCount: Array.from(files.keys()).filter((file) => file.startsWith(`${path}/`) && file.endsWith(".tex")).length,
    modifiedEpochMs: documents.find((document) => document.projectPath === path)?.modifiedEpochMs ?? now,
  }));
  return { projects, documents };
}

export function previewReadText(path: string): FileTextLike {
  const content = files.get(path) ?? "";
  return { path, content, bytes: new TextEncoder().encode(content).length, version: previewTextVersion(content) };
}

export async function previewReadBytes(path: string): Promise<number[]> {
  const binaryUrl = binaryFiles.get(path);
  if (binaryUrl) {
    const response = await fetch(binaryUrl);
    if (!response.ok) throw new Error(`Preview asset not found: ${path}`);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }
  return Array.from(new TextEncoder().encode(files.get(path) ?? ""));
}

export function previewWriteText(path: string, content: string, expectedVersion?: string | null): FileTextLike {
  const normalized = normalizePreviewPath(path);
  const current = files.get(normalized);
  if (current !== undefined && expectedVersion && previewTextVersion(current) !== expectedVersion) {
    throw new Error(`FILE_CONFLICT: ${normalized} changed after it was opened; reload it before saving`);
  }
  ensurePreviewParentDirs(normalized);
  files.set(normalized, content);
  return {
    path: normalized,
    content,
    bytes: new TextEncoder().encode(content).length,
    version: previewTextVersion(content),
  };
}

export function previewCreateDir(path: string): PreviewFileTreeEntry {
  const normalized = normalizePreviewPath(path);
  if (!normalized) throw new Error("Folder path is empty.");
  if (previewFileExists(normalized) || previewDirExists(normalized)) {
    throw new Error(`Path already exists: ${normalized}`);
  }
  ensurePreviewParentDirs(normalized);
  explicitDirs.add(normalized);
  return { name: previewBasename(normalized), path: normalized, isDir: true };
}

export function previewRenamePath(path: string, newPath: string): PreviewFileTreeEntry {
  const source = normalizePreviewPath(path);
  const target = normalizePreviewPath(newPath);
  if (!source || !target) throw new Error("Path is empty.");
  if (source === target) {
    return { name: previewBasename(source), path: source, isDir: previewDirExists(source) && !previewFileExists(source) };
  }
  if (previewFileExists(target) || previewDirExists(target)) {
    throw new Error(`Target already exists: ${target}`);
  }
  ensurePreviewParentDirs(target);

  if (files.has(source)) {
    const content = files.get(source) ?? "";
    files.delete(source);
    files.set(target, content);
    return { name: previewBasename(target), path: target, isDir: false };
  }
  if (binaryFiles.has(source)) {
    const content = binaryFiles.get(source) ?? "";
    binaryFiles.delete(source);
    binaryFiles.set(target, content);
    return { name: previewBasename(target), path: target, isDir: false };
  }
  if (!previewDirExists(source)) throw new Error(`Path not found: ${source}`);
  if (target.startsWith(`${source}/`)) throw new Error("Cannot move a folder inside itself.");

  const prefix = `${source}/`;
  for (const key of Array.from(files.keys())) {
    if (!key.startsWith(prefix)) continue;
    const content = files.get(key) ?? "";
    files.delete(key);
    files.set(`${target}/${key.slice(prefix.length)}`, content);
  }
  for (const key of Array.from(binaryFiles.keys())) {
    if (!key.startsWith(prefix)) continue;
    const content = binaryFiles.get(key) ?? "";
    binaryFiles.delete(key);
    binaryFiles.set(`${target}/${key.slice(prefix.length)}`, content);
  }
  for (const dir of Array.from(explicitDirs)) {
    if (dir === source || dir.startsWith(prefix)) {
      explicitDirs.delete(dir);
      explicitDirs.add(dir === source ? target : `${target}/${dir.slice(prefix.length)}`);
    }
  }
  explicitDirs.add(target);
  return { name: previewBasename(target), path: target, isDir: true };
}
export function previewDeletePath(path: string): Promise<void> {
  const normalized = normalizePreviewPath(path);
  if (!normalized) return Promise.reject(new Error("Path is empty."));
  if (files.delete(normalized) || binaryFiles.delete(normalized)) return Promise.resolve();
  if (!previewDirExists(normalized)) return Promise.reject(new Error(`Path not found: ${normalized}`));
  const prefix = `${normalized}/`;
  for (const key of Array.from(files.keys())) {
    if (key.startsWith(prefix)) files.delete(key);
  }
  for (const key of Array.from(binaryFiles.keys())) {
    if (key.startsWith(prefix)) binaryFiles.delete(key);
  }
  for (const dir of Array.from(explicitDirs)) {
    if (dir === normalized || dir.startsWith(prefix)) explicitDirs.delete(dir);
  }
  return Promise.resolve();
}

export function previewDuplicatePath(path: string): PreviewFileTreeEntry {
  const source = normalizePreviewPath(path);
  const isDir = previewDirExists(source) && !previewFileExists(source);
  if (!source || (!previewFileExists(source) && !isDir)) {
    throw new Error(`Path not found: ${path}`);
  }
  const slash = source.lastIndexOf("/");
  const parent = slash >= 0 ? source.slice(0, slash) : "";
  const name = slash >= 0 ? source.slice(slash + 1) : source;
  const extension = isDir || !name.includes(".") ? "" : name.slice(name.lastIndexOf("."));
  const stem = extension ? name.slice(0, -extension.length) : name;
  let target = "";
  for (let index = 1; index <= 10_000; index += 1) {
    const suffix = index === 1 ? " copy" : ` copy ${index}`;
    target = [parent, `${stem}${suffix}${extension}`].filter(Boolean).join("/");
    if (!previewFileExists(target) && !previewDirExists(target)) break;
  }
  if (!target || previewFileExists(target) || previewDirExists(target)) {
    throw new Error("Could not find an available name for the duplicated entry.");
  }
  ensurePreviewParentDirs(target);
  if (!isDir) {
    if (files.has(source)) files.set(target, files.get(source) ?? "");
    else binaryFiles.set(target, binaryFiles.get(source) ?? "");
    return { name: previewBasename(target), path: target, isDir: false };
  }

  const prefix = `${source}/`;
  for (const [filePath, content] of files) {
    if (filePath.startsWith(prefix)) files.set(`${target}/${filePath.slice(prefix.length)}`, content);
  }
  for (const [filePath, content] of binaryFiles) {
    if (filePath.startsWith(prefix)) binaryFiles.set(`${target}/${filePath.slice(prefix.length)}`, content);
  }
  for (const directory of Array.from(explicitDirs)) {
    if (directory === source || directory.startsWith(prefix)) {
      explicitDirs.add(directory === source ? target : `${target}/${directory.slice(prefix.length)}`);
    }
  }
  explicitDirs.add(target);
  return { name: previewBasename(target), path: target, isDir: true };
}
