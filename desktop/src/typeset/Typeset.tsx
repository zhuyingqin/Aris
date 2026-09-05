import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { EditorView, type KeyBinding } from "@codemirror/view";
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import "katex/dist/katex.min.css";

import { isFilePreviewMode } from "../api/browserPreview";
import {
  fileCreateText,
  fileReadText,
  fileSearch,
  fileWriteText,
  isTauri,
  latexCompile,
  latexCompileCancel,
  latexDocumentContext,
  latexForwardSearch,
  latexInverseSearch,
  literatureExportBibliography,
  localEnvironmentCheck,
  onChatDone,
  onWorkspaceFileChanged,
  onLatexCompileProgress,
  type FileText,
  type LatexDiagnostic,
  type TypesetDocument,
  type TypesetChangeProposal,
  type TypesetChangeSet,
  type TypesetChangeSetTextFile,
  type TypesetProposalDecision,
  type TypesetProject,
  type TypesetProjectReplaceResult,
  type TypesetProjectSearchMatch,
  typesetChangeSetCreate,
  typesetChangeSetList,
  typesetChangeSetReadText,
  typesetChangeSetResolve,
  typesetChangeSetStageText,
  typesetChangeProposalClear,
  typesetChangeProposalLoad,
  typesetChangeProposalSave,
  typesetExportFile,
  typesetExportProject,
  type TypesetOutputFile,
  typesetImportImageData,
  typesetListDocuments,
  typesetRecoveryClear,
  typesetRecoveryLoad,
  typesetRecoverySave,
  typesetRevisionCapture,
  typesetRevisionList,
} from "../api/tauri";
import { isTypesetPreviewMode } from "../api/browserPreview";
import {
  activeBeamerSlideForLine,
  activeOutlineItemForLine,
  beamerSlidesForDocument,
  beamerSlidesFor,
  documentSourceForPath,
  includeCandidateGroupsFor,
  includeTargetsFor,
  numberedOutlineFor,
  numberingPrefixFor,
  outlineFor,
  resolveTexPath,
  INCLUDE_MAX_FILES,
} from "./outlineModel";
import { ToolIcon } from "./ToolIcon";
import { isFigureImage } from "./latexFigure";
import {
  TypesetOutlinePanel,
} from "./TypesetOutlinePanel";
import {
  basename,
  dirname,
  extension,
  lineNumberForOffset,
  normalizePath,
  sameWorkspacePath,
  wordCountFor,
} from "./latexText";
import { LATEX_ANALYSIS_IDLE_MS, scanLatexStructure } from "./latexStructure";
import CodeEditor, {
  type CodeDiffLine,
  type CodeReviewConfig,
  type CodeReviewDecision,
} from "../editor/CodeEditor";
import { TypesetVisualEditor } from "./TypesetVisualEditor";
import {
  type TypesetTemplate,
} from "./TypesetLibraryCopy";
import { TYPESET_EDITOR_COPY } from "./i18n";
import {
  refineSourceColumn,
  remapCompiledLine,
  wordRatioIn,
} from "./syncTexMapping";
import type { VisualPdfCursor } from "./visualModel";
import type { SharedEditorHandle } from "../editor/editorTypes";
import { minimalReplacement } from "../editor/editorView";
import { clearLatexProjectSymbols, setLatexProjectSymbols, type LatexSymbol } from "../editor/latexComplete";
import { bibEntryDetail, bibliographyTargets, parseBibEntries } from "../editor/latexBib";
import { setLatexCompileMarkers, type LatexCompileMarker } from "../editor/latexLint";
import { useStore } from "../store";
import { suggestedCitationKey, useLiteratureStore } from "../literature/literatureStore";
import {
  findLatexOffsetForPdfText,
  normalizePdfText,
  pdfTextCarriesEnoughSignal,
} from "./pdfTextMatch";
import CompileLog from "./CompileLog";
import TypesetEditorSettings from "./TypesetEditorSettings";
import TypesetAiPanel from "./TypesetAiPanel";
import TypesetReviewPanel from "./TypesetReviewPanel";
import {
  compileErrorHandlingStorageKey,
  loadCompileErrorHandling,
  loadCompileOnSave,
  loadLatexEngineChoice,
  loadMainDocument,
  loadPdfInverted,
  loadSpellCheckPreference,
  projectScopedKey,
  writeStoredValue,
  COMPILE_ON_SAVE_STORAGE_PREFIX,
  LATEX_ENGINE_STORAGE_PREFIX,
  MAIN_DOCUMENT_STORAGE_PREFIX,
  PDF_INVERT_STORAGE_KEY,
  SPELL_CHECK_STORAGE_KEY,
  type CompileErrorHandling,
} from "./typesetPreferences";
import { useTypesetPanels } from "./useTypesetPanels";
import TypesetEditorToolbar from "./TypesetEditorToolbar";
import {
  type EditorMode,
} from "./editorCommands";
import TypesetStartPage from "./TypesetStartPage";
import TypesetExplorer, { defaultSourceFor, type TypesetFileMutation } from "./TypesetExplorer";
import TypesetImagePreview from "./TypesetImagePreview";
import TypesetCompiledVisual from "./TypesetCompiledVisual";
import TypesetPdfPreview, { type PdfForwardTarget } from "./TypesetPdfPreview";
import TypesetExternalChangeReview, {
  type ExternalChangeReviewCopy,
  type ExternalWholeFileDecision,
} from "./TypesetExternalChangeReview";
import TypesetChangeSetMenu from "./TypesetChangeSetMenu";
import TypesetHistoryPanel from "./TypesetHistoryPanel";
import TypesetProjectSearchPanel from "./TypesetProjectSearchPanel";
import TypesetCommentsPanel, { type TypesetSourceRange } from "./TypesetCommentsPanel";
import {
  externalTextDiff,
  externalTextDiffReliable,
  resolveExternalDiff,
  threeWayExternalProposalReliable,
  type ExternalTextDiff,
} from "./externalChangeDiff";
import {
  isTypesetImagePath,
  normalizeNewTypesetPath,
  outputPathFor,
  workDirContains,
  workDirForSource,
} from "./typesetPaths";
import { clampNumber } from "./pdfGeometry";
import { lineOffsetFor } from "./visualTextEdits";
import {
  type CompileLiveLog,
  type CompileResult,
  type CompileStatus,
  type LatexEngineChoice,
} from "./compileModel";
import "./Typeset.css";

// Default quiet-period between file-watcher capture attempts, in milliseconds.
// The watcher fires for every editor save; without a quiet period the same
// edit would trigger several back-to-back captures and race the atomic
// rename in `typeset_revision_capture`. One agent edit or one compile emits a
// burst of watcher notifications (the write, the atomic rename, the
// regenerated outputs); capturing a revision per notification turned a
// single session into 299 separate review gates, each demanding its own
// decision, so the burst is coalesced into one capture instead.
export const WATCHER_CAPTURE_QUIET_MS = 200;

/**
 * How long a finished action still claims the writes that arrive after it.
 *
 * A Chat turn's last watcher notification lands after its completion event, and
 * splitting that tail into a second transaction is the same per-notification
 * fragmentation the quiet period above exists to prevent.
 */
const ACTION_TRAILING_MS = 5_000;
/**
 * A burst of external writes has no completion event of its own, so it stays
 * one action for as long as notifications keep arriving. A gap this long means
 * whatever writes next is somebody starting again, not the same edit landing.
 */
const ACTION_IDLE_MS = 60_000;
/**
 * How far back a blanket reject may reach before it has to say so.
 *
 * One action's transaction is minutes old at most; anything older means the
 * span opened before this session — drift found at project open, or a review
 * left unanswered across a restart — and rejecting it discards work nobody was
 * asked about.
 */
const REJECT_REACH_WARNING_MS = 10 * 60_000;

// `nonce` forces PdfPage's highlight-flash animation to restart even when the
// user double-clicks the exact same source position twice in a row.
type PendingSourceNavigation = {
  path: string;
  line: number;
  column?: number;
  start?: number;
  end?: number;
  forceCode?: boolean;
  /** `line` came from SyncTeX, so it is numbered against the compiled snapshot
   * and needs remapping through any edits made since the build. */
  fromSyncTex?: boolean;
  /** The word under the pointer in the PDF, used to recover a source column. */
  word?: string;
  /** The full PDF run `word` was taken from, for disambiguating repeats. */
  pdfText?: string;
};
// What `\includegraphics{`, `\input{` and `\bibliography{` can point at. The
// backend glob caps each pattern at 50 hits, so they are split by extension
// rather than asking for everything at once.
const COMPLETABLE_FILE_PATTERNS = [
  "**/*.tex", "**/*.bib", "**/*.pdf", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.eps", "**/*.svg",
];

/**
 * Project-scoped preferences that Overleaf keeps in its project settings: which
 * engine to run, which file is the root document, and whether saving compiles.
 *
 * Compiling on *save* rather than on a typing pause is deliberate. Overleaf
 * rebuilds a few seconds after you stop typing, which is fine against a server
 * farm; locally it means a PDF that reflows under the reader every few seconds.
 * A save is an explicit "this is a state worth looking at".
 */
const PROJECT_PANEL_MIN_W = 136;
const PROJECT_PANEL_MAX_W = 720;
const PDF_PANEL_MIN_W = 220;
const PDF_PANEL_MAX_W = 1040;
const COMPILE_PROGRESS_UPDATE_MS = 100;
// Keep source on disk while the writer is still in a natural typing flow. This
// deliberately only persists the .tex source: rebuilding the PDF is reserved
// for an explicit save or recompile so the preview does not churn mid-sentence.
const AUTOSAVE_DELAY_MS = 45_000;
const RECOVERY_DRAFT_DELAY_MS = 3_000;
const AUTOSAVE_MAX_WAIT_MS = 120_000;
// Typing inside an open review is unsaved work like any other draft, so it is
// journaled to the proposal on the same pause-based cadence rather than on
// every keystroke.
const REVIEW_DRAFT_SAVE_QUIET_MS = 1_000;

/**
 * Paths a workspace notification can skip.
 *
 * Purely an optimization: the ledger excludes build output from revisions
 * outright (`BUILD_ARTIFACT_SUFFIXES` in `typeset_state.rs` is the authority),
 * so a capture triggered by one produces no operations and no change set. This
 * just avoids paying for the workspace scan to learn that. `(busy)` is the
 * marker the engine appends while it is still writing a SyncTeX file, and
 * `.tmpXXXXXX` is the scratch sibling of an atomic write — the latter used to
 * become the recorded evidence path for the whole change set.
 */
const GENERATED_OUTPUT_PATH = /(?:-eps-converted-to\.pdf|\.(?:acn|acr|alg|aux|auxlock|bbl|bcf|blg|brf|dpth|dvi|fdb_latexmk|figlist|fls|glg|glo|gls|idx|ilg|ind|ist|loa|lof|log|lol|los|lot|makefile|md5|nav|out|run\.xml|snm|synctex|synctex\.gz|tdo|toc|upa|upb|vrb|xdv|xdy))(?:\(busy\))?$/;
const TRANSIENT_TEMP_PATH = /(?:^|[/\\])\.tmp[A-Za-z0-9]{6,12}$/;

type PendingExternalChange = {
  path: string;
  file: FileText;
  id: string;
  baseContent: string;
  baseVersion: string | null;
  localContent: string;
  /** Exact candidate and ranges produced by the same diff engine. */
  reviewContent: string;
  reviewDiff: ExternalTextDiff;
  decisions: TypesetProposalDecision[];
  actor: string;
  origin: string;
  /**
   * The change could not be split into reviewable hunks, so `decisions` is
   * empty and there is nothing to answer per hunk.
   *
   * This has to be carried explicitly. Every resolve path refuses an empty
   * decision list — correctly, because resolving one keeps the local content
   * and the backend then hashes that back to "accept", recording the opposite
   * of a reject. With no hunks to answer and no path that accepts zero of
   * them, such a review could never be cleared. The whole-file choice below is
   * the way out.
  */
  tooLargeToChunk: boolean;
  wholeFileDecision: ExternalWholeFileDecision | null;
  /**
   * The reviewer's own edits on top of `reviewContent`.
   *
   * Review happens in the live editor, and a reviewer who spots a typo in an
   * incoming paragraph should be able to fix it there rather than accept it,
   * wait for the transaction, and come back. `null` means the surface still
   * shows the untouched proposal; anything else is text only a person typed,
   * so it is reconciled against the hunk answers when the review resolves and
   * is never silently dropped.
   */
  reviewDraft: string | null;
};

async function pendingExternalChange(
  path: string,
  base: FileText,
  localContent: string,
  incoming: FileText,
  actor = "external",
  origin = "watcher",
): Promise<PendingExternalChange> {
  const review = await threeWayExternalProposalReliable(
    base.content,
    localContent,
    incoming.content,
    path,
    0,
  );
  return {
    path,
    file: incoming,
    id: `proposal-${Date.now()}`,
    baseContent: base.content,
    baseVersion: base.version ?? null,
    localContent,
    reviewContent: review.content,
    reviewDiff: review.diff,
    decisions: review.diff.changes.map(() => "pending"),
    actor,
    origin,
    tooLargeToChunk: Boolean(review.tooLargeToChunk),
    wholeFileDecision: null,
    reviewDraft: null,
  };
}

/** What the review surface is showing: the reviewer's edited text when they
 *  have typed into it, otherwise the untouched proposal. */
function reviewDisplayText(pending: PendingExternalChange): string {
  return pending.reviewDraft ?? pending.reviewContent;
}

/** Stable identities for "this file has no review", so the memos below do not
 *  invalidate on every render of an ordinary editing session. */
const EMPTY_REVIEW_CHANGES: ExternalTextDiff["changes"] = [];
const EMPTY_REVIEW_DECISIONS: TypesetProposalDecision[] = [];

/**
 * Translate a line number in the proposal into the same line of the text the
 * reviewer is looking at now.
 *
 * Every review marker — the changed-line backgrounds and the accept/reject
 * control anchored to each hunk — is addressed by line number against the
 * proposal. Typing one line into the middle of the file would otherwise leave
 * all of them one line high, pointing at content they do not describe.
 *
 * A line the reviewer rewrote themselves maps to `null`: it is their text now,
 * not an incoming change waiting for an answer, and it drops its marker.
 */
function reviewLineMapper(base: string, edited: string | null): (line: number) => number | null {
  if (edited === null || edited === base) return (line) => line;
  const diff = externalTextDiff(base, edited, 0);
  // The bounded fallback gives up on a rewrite this large. Every line is then
  // equally unreliable, so keep the markers where the proposal put them rather
  // than inventing positions.
  if (diff.tooLargeToChunk) return (line) => line;
  return (line) => {
    const index = line - 1;
    let delta = 0;
    for (const change of diff.changes) {
      if (change.oldEnd <= index) {
        delta += (change.newEnd - change.newStart) - (change.oldEnd - change.oldStart);
        continue;
      }
      if (change.oldStart <= index) return null;
      break;
    }
    return index + delta + 1;
  };
}

/**
 * The durable form of an open review.
 *
 * Every field of this record has to stay in step with the in-memory proposal —
 * a stale `hunkIds`/`decisions` pair alone is enough to make a restored review
 * answer the wrong ranges — so the five places that persist a proposal derive
 * it here instead of each repeating the shape.
 */
function proposalRecord(
  pending: PendingExternalChange,
  overrides: Partial<TypesetChangeProposal> = {},
): TypesetChangeProposal {
  return {
    id: pending.id,
    path: pending.path,
    baseContent: pending.baseContent,
    baseVersion: pending.baseVersion,
    localContent: pending.localContent,
    incomingContent: pending.file.content,
    incomingVersion: pending.file.version ?? null,
    createdAtMs: Date.now(),
    decisions: pending.decisions,
    hunkIds: pending.reviewDiff.changes.map((change) => change.id),
    actor: pending.actor,
    origin: pending.origin,
    evidence: pending.path,
    tooLargeToChunk: pending.tooLargeToChunk,
    wholeFileDecision: pending.wholeFileDecision,
    reviewDraft: pending.reviewDraft,
    ...overrides,
  };
}

/**
 * The bytes a resolved review should write.
 *
 * Hunk answers and manual edits are independent inputs and both have to
 * survive: the answers are resolved against the local content exactly as the
 * ranges were shown, then the reviewer's typing is merged back on top with the
 * proposal they started from as the merge base. Accepting everything makes the
 * answer identical to that base, so the edited text is already the result and
 * no merge is needed.
 */
async function resolveReviewedContent(
  pending: PendingExternalChange,
  decisions: readonly TypesetProposalDecision[],
): Promise<{ content: string; reliable: boolean }> {
  const decided = resolveExternalDiff(pending.localContent, pending.reviewDiff, decisions);
  const edited = pending.reviewDraft;
  if (edited === null || edited === pending.reviewContent) return { content: decided, reliable: true };
  if (decided === pending.reviewContent) return { content: edited, reliable: true };
  const reconciled = await threeWayExternalProposalReliable(
    pending.reviewContent,
    edited,
    decided,
    pending.path,
    0,
  );
  // An unchunkable reconcile returns the local side untouched, which here means
  // the rejections would be dropped without anyone being told. Report it.
  if (reconciled.tooLargeToChunk) return { content: edited, reliable: false };
  return { content: reconciled.content, reliable: true };
}

function sameFileSnapshot(left: FileText, right: FileText): boolean {
  return left.content === right.content
    || Boolean(left.version && right.version && left.version === right.version);
}
function preferredSource(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const sorted = [...paths].sort((left, right) => {
    const score = (path: string) => {
      const normalized = path.toLowerCase().replace(/\\/g, "/");
      if (normalized === ".somniq/papers/main.tex") return 0;
      if (normalized === "papers/main.tex") return 1;
      if (normalized === "main.tex") return 2;
      if (normalized.endsWith("/main.tex")) return 3;
      if (normalized.endsWith(".tex")) return 4;
      return 5;
    };
    return score(left) - score(right) || left.localeCompare(right);
  });
  return sorted[0] ?? null;
}

function sortedSources(paths: string[]): string[] {
  return [...paths].sort((left, right) => {
    const preferred = preferredSource([left, right]);
    if (preferred === left && preferred !== right) return -1;
    if (preferred === right && preferred !== left) return 1;
    return left.localeCompare(right);
  });
}

/** Wraps the selection in `prefix`/`suffix`; an empty selection wraps `placeholder` instead, pre-selected. */
/**
 * Inserts a snippet at the selection anchor without consuming any selected
 * text (matches Overleaf's `insertCite`/`insertRef`, which insert at
 * `state.selection.main.anchor` — a citation/reference key isn't a sensible
 * substitute for whatever prose happened to be selected).
 */
/** Blank-line padding so a block insert (table/figure) doesn't run into surrounding text. */
/**
 * Simplified, line-based version of Overleaf's tree-based `setSectionHeadingLevel`
 * (`extensions/toolbar/sections.ts`): if the current line already is a section
 * command, swap just the command keyword (or strip it, for "text"); otherwise
 * wrap the selection or the current line's text in the chosen level.
 */
/**
 * Simplified version of Overleaf's `wrapRangeInList` (`extensions/toolbar/lists.ts`):
 * wraps the selected line range in `\begin{itemize}`/`\begin{enumerate}`, one
 * `\item` per line. No nested-list/indent-context awareness (needs the tree).
 */
function nextAnimationFrame(): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}







/** PDF text inside a math run must stay LaTeX source, not be prose-escaped. */
/**
 * A click in the compiled PDF, in the terms SyncTeX's `edit` query wants:
 * `x`/`y` are big points from the page's top-left corner. `word` is the word
 * under the pointer when the click landed on text, used to refine the source
 * column SyncTeX itself never reports.
 */
/**
 * The clickable/hoverable boxes for one page's text.
 *
 * The vertical extent comes from the font's own ascent/descent (see
 * `pdfTextRunBox`) rather than from `item.height`, because these boxes have to
 * agree with the boxes SyncTeX recorded: a box sized off the em square sits
 * ~3bp too high, which puts its top edge inside the *previous* typeset line and
 * leaves every descender uncovered.
 */
/**
 * Safe Visual surface for Beamer: the compiled PDF page is the canvas.
 * Arbitrary TikZ/custom macros cannot be reproduced faithfully by a rich-text
 * source decorator, so the compiled output remains the visual truth. Text
 * clicks reveal the exact frame source without pretending to reproduce custom
 * macros in a lossy rich-text model.
 */
/** Resolve PDF.js named and explicit destinations to the one-based page index
 * used by the reader controls. */
/**
 * Figure preview for the right-hand panel. A `\includegraphics` target opened
 * from the file tree is an image, not a PDF, so it takes over the preview slot
 * with image-appropriate controls and a way back to the compiled document.
 */
const SOMNIQ_BIBLIOGRAPHY_STEM = "somniq-references";
const SOMNIQ_BIBLIOGRAPHY_FILE = `${SOMNIQ_BIBLIOGRAPHY_STEM}.bib`;
const SOMNIQ_BIBLIOGRAPHY_HEADER = "% SomniQ managed bibliography — do not edit this file directly.\n";

function bibliographyPathForSource(sourcePath: string): string {
  const segments = sourcePath.replace(/\\/g, "/").split("/");
  segments.pop();
  return [...segments, SOMNIQ_BIBLIOGRAPHY_FILE].filter(Boolean).join("/") || SOMNIQ_BIBLIOGRAPHY_FILE;
}

function sourceUsesSomniqBibliography(source: string): boolean {
  const bibliographyResources = [
    ...source.matchAll(/\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g),
    ...source.matchAll(/\\bibliography\s*\{([^}]+)\}/g),
  ];
  return bibliographyResources.some((match) => (
    match[1].split(",").some((item) => (
      item.trim().replace(/\.bib$/i, "") === SOMNIQ_BIBLIOGRAPHY_STEM
    ))
  ));
}

function insertBeforeDocument(source: string, block: string): string {
  const beginDocument = source.search(/\\begin\s*\{document\}/);
  if (beginDocument >= 0) return `${source.slice(0, beginDocument).replace(/\s*$/, "")}\n${block}\n${source.slice(beginDocument)}`;
  return `${source.replace(/\s*$/, "")}\n${block}\n`;
}

function insertBeforeEndDocument(source: string, block: string): string {
  const endDocument = source.lastIndexOf("\\end{document}");
  if (endDocument >= 0) return `${source.slice(0, endDocument).replace(/\s*$/, "")}\n${block}\n${source.slice(endDocument)}`;
  return `${source.replace(/\s*$/, "")}\n${block}\n`;
}

/** Add a separate managed bibliography without ever rewriting user .bib files. */
function withSomniqBibliography(source: string): string {
  const biblatex = /\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
  const bibtex = /\\bibliography\s*\{([^}]+)\}/;
  const hasManagedResource = (value: string) => value.split(",").some((item) => item.trim().replace(/\.bib$/i, "") === SOMNIQ_BIBLIOGRAPHY_STEM);
  const usesBiblatex = /\\usepackage(?:\s*\[[^\]]*\])?\s*\{biblatex\}/.test(source) || Array.from(source.matchAll(biblatex)).length > 0;
  if (usesBiblatex) {
    let next = source;
    if (!sourceUsesSomniqBibliography(next)) {
      // \addbibresource belongs in the preamble. Add one independent managed
      // resource instead of changing only the first user declaration (or
      // duplicating it after every declaration).
      next = insertBeforeDocument(next, `% SomniQ bibliography (managed)\n\\addbibresource{${SOMNIQ_BIBLIOGRAPHY_FILE}}`);
    }
    if (!/\\printbibliography\b/.test(next)) {
      next = insertBeforeEndDocument(next, "% SomniQ bibliography (managed)\n\\printbibliography");
    }
    return next;
  }
  if (bibtex.test(source)) {
    return source.replace(bibtex, (whole, resources: string) =>
      hasManagedResource(resources) ? whole : `\\bibliography{${resources.trim()},${SOMNIQ_BIBLIOGRAPHY_STEM}}`,
    );
  }
  return insertBeforeEndDocument(
    source,
    `% SomniQ bibliography (managed)\n\\bibliographystyle{plain}\n\\bibliography{${SOMNIQ_BIBLIOGRAPHY_STEM}}`,
  );
}

/** The text a file had when the PDF now on screen was built, if we have it. */
function compiledSourceFor(
  snapshot: Record<string, string>,
  path: string,
): string | undefined {
  const key = Object.keys(snapshot).find((candidate) => sameWorkspacePath(candidate, path));
  return key === undefined ? undefined : snapshot[key];
}

/** First fully-visible source line, from CodeMirror's own block layout — exact
 * even with wrapped lines, unlike the old textarea version's uniform-line-height
 * pixel math. */
function codeVisibleLineForView(view: EditorView): number {
  const block = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop));
  return view.state.doc.lineAt(block.from).number;
}

function scrollCodeEditorToLine(view: EditorView, line: number): void {
  const clampedLine = Math.max(1, Math.min(line, view.state.doc.lines));
  const block = view.lineBlockAt(view.state.doc.line(clampedLine).from);
  view.scrollDOM.scrollTop = Math.max(0, block.top - view.scrollDOM.clientHeight * 0.28);
}

/**
 * `typeset_changeset_stage_text` answers with the whole transaction as it is
 * on disk — one freshly staged operation, and the stored decision for every
 * other one. Adopting that reply outright threw away the blanket answer a
 * bulk accept/reject had just given every other file in the same pass, since
 * disk has not caught up with them yet. Keep only the operation this call
 * actually staged; overlay the caller's own in-memory answer everywhere else.
 */
function withBlanketAnswers(fresh: TypesetChangeSet, stagedOperationId: string, previous: TypesetChangeSet): TypesetChangeSet {
  return {
    ...fresh,
    decisions: fresh.decisions.map((item) => (
      item.operationId === stagedOperationId
        ? item
        : previous.decisions.find((entry) => entry.operationId === item.operationId) ?? item
    )),
  };
}

export default function Typeset() {
  const language = useStore((state) => state.language);
  const copy = TYPESET_EDITOR_COPY[language].workbench;
  const editorSettingsCopy = TYPESET_EDITOR_COPY[language].editorSettings;
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false);
  const railSettingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const currentProject = useStore((state) => state.currentProject);
  const setTypesetDirty = useStore((state) => state.setTypesetDirty);
  const pendingTypesetFilePath = useStore((state) => state.pendingTypesetFilePath);
  const setPendingTypesetFilePath = useStore((state) => state.setPendingTypesetFilePath);
  const literaturePapers = useLiteratureStore((state) => state.library.papers);
  const loadLiterature = useLiteratureStore((state) => state.load);
  const ensureCitationKeys = useLiteratureStore((state) => state.ensureCitationKeys);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [lastPdfPreviewPath, setLastPdfPreviewPath] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<FileText | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [compileStatus, setCompileStatus] = useState<CompileStatus>("idle");
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [activeCompileRunId, setActiveCompileRunId] = useState<string | null>(null);
  const [compileErrorHandling, setCompileErrorHandling] = useState<CompileErrorHandling>(() => loadCompileErrorHandling(currentProject?.id));
  const [latexEngine, setLatexEngine] = useState<LatexEngineChoice>(() => loadLatexEngineChoice(currentProject?.id));
  const [compileOnSave, setCompileOnSave] = useState(() => loadCompileOnSave(currentProject?.id));
  const [mainDocumentPath, setMainDocumentPath] = useState<string | null>(() => loadMainDocument(currentProject?.id));
  const [pdfInverted, setPdfInverted] = useState(() => loadPdfInverted());
  const [compileLiveLog, setCompileLiveLog] = useState<CompileLiveLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState<PendingExternalChange | null>(null);
  // The compact diff starts collapsed for every file under review; expanding
  // it is either an explicit "Show changes" press or a click on a highlighted
  // line in the editor (`onReveal` below), not something carried over from
  // whichever file was reviewed before this one.
  const [changesExpanded, setChangesExpanded] = useState(false);
  useEffect(() => {
    setChangesExpanded(false);
  }, [externalChange?.id]);
  const [externalReviewBusy, setExternalReviewBusy] = useState<"accept" | "reject" | "apply" | null>(null);
  const [pendingChangeSets, setPendingChangeSets] = useState<TypesetChangeSet[]>([]);
  const pendingChangeSet = pendingChangeSets[0] ?? null;
  const [changeSetOperationPreview, setChangeSetOperationPreview] = useState<TypesetChangeSetTextFile | null>(null);
  // Compiling while a file is held for review reads the disk/incoming version
  // rather than the reviewer's own edits; this explains that substitution
  // instead of `setError`, which `compile()` clears at the start of every run.
  const [reviewCompileNotice, setReviewCompileNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentSelection, setCommentSelection] = useState<TypesetSourceRange>({ from: 0, to: 0 });
  const [refreshKey, setRefreshKey] = useState(0);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  /** The root and source graph of the current LaTeX document. They deliberately
   * outlive individual file switches so opening `chapters/intro.tex` keeps the
   * root outline, compiled PDF, and sibling navigation intact. */
  const [documentRootPath, setDocumentRootPath] = useState<string | null>(null);
  const [documentSources, setDocumentSources] = useState<Record<string, string>>({});
  const [documentGraphTruncated, setDocumentGraphTruncated] = useState(false);
  const [syncTexOutdated, setSyncTexOutdated] = useState(false);
  // The source of every file as it was when the PDF on screen was built. This
  // is what lets an inverse-search hit stay accurate while the buffer is dirty:
  // SyncTeX numbers its answer against this snapshot, and the difference
  // between it and the live draft is exactly the edit to remap through.
  const compiledSourcesRef = useRef<Record<string, string>>({});
  const [pendingSourceNavigation, setPendingSourceNavigation] = useState<PendingSourceNavigation | null>(null);
  const [startDocuments, setStartDocuments] = useState<TypesetDocument[]>([]);
  const [startProjects, setStartProjects] = useState<TypesetProject[]>([]);
  const [latexAvailable, setLatexAvailable] = useState<boolean | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [spellCheck, setSpellCheck] = useState(loadSpellCheckPreference);
  const [editorMode, setEditorMode] = useState<EditorMode>("visual");
  const [visualPdfCursor, setVisualPdfCursor] = useState<VisualPdfCursor | null>(null);
  const [syncedBeamerPage, setSyncedBeamerPage] = useState<number | null>(null);
  const [pdfForwardTarget, setPdfForwardTarget] = useState<PdfForwardTarget | null>(null);
  const [forwardSearchNotice, setForwardSearchNotice] = useState<string | null>(null);
  const {
    projectPanelVisible, setProjectPanelVisible,
    pdfPanelVisible, setPdfPanelVisible,
    projectPanelWidth, pdfPanelWidth,
    outlinePanelHeight,
    outlineCollapsed, setOutlineCollapsed,
    beginPanelResizeFromPointer, beginOutlineResizeFromPointer,
    handlePanelResizeKey, handleOutlineResizeKey,
  } = useTypesetPanels();
  type LeftPanelTab = "files" | "review" | "ai";
  const [activeLeftTab, setActiveLeftTab] = useState<LeftPanelTab>("files");
  const [trackChangesEnabled, setTrackChangesEnabled] = useState(false);
  const [slideFocusMode, setSlideFocusMode] = useState(true);
  const [currentSourceLine, setCurrentSourceLine] = useState(1);
  // CodeMirror reports edits synchronously, while React may defer committing the
  // matching state update. Keep the authoritative latest source in a ref so a
  // Recompile click immediately after an edit cannot save the previous draft.
  const draftRef = useRef("");
  // PDF text layers may retain their click handler for longer than a render
  // cycle. Read the current mode from a ref so reverse search always targets
  // the visible Code surface when the user has selected Code mode.
  const editorModeRef = useRef<EditorMode>(editorMode);
  editorModeRef.current = editorMode;
  // Mirror the panel widths into refs so the drag callbacks can read the current
  // size without listing the widths as dependencies. Keeping the callbacks stable
  // stops the window/document listener effect from tearing down (and aborting the
  // active drag) every time a resize updates the width state.
  const editorRef = useRef<SharedEditorHandle | null>(null);
  // Live CodeMirror view for Visual mode, mirroring `editorRef` for Code mode —
  // lets the toolbar apply edits at whichever editor's real selection is
  // current, instead of always inserting near `\end{document}`.
  const visualViewRef = useRef<EditorView | null>(null);
  const onVisualViewReady = useCallback((view: EditorView | null) => {
    visualViewRef.current = view;
  }, []);
  const previewAutoOpenedRef = useRef(false);
  // Tracks the last source path we auto-compiled so opening a tex compiles it
  // once (matching Recompile), instead of leaving the PDF stale/empty until the
  // user manually recompiles.
  const compileRef = useRef<() => void>(() => {});
  /** Read from the Ctrl+S keymap, which CodeMirror captured at mount. */
  const compileOnSaveRef = useRef(true);
  /**
   * The open tabs, and the unsaved draft each *inactive* one is holding. The
   * active tab's draft lives in `draft`; a tab only enters this map when it
   * loses focus, and leaves it again when it regains it.
   */
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const openDraftsRef = useRef(new Map<string, { draft: string; loaded: FileText }>());
  const [inactiveDirtyPaths, setInactiveDirtyPaths] = useState<string[]>([]);
  const publishOpenDrafts = useCallback(() => {
    const dirtyPaths: string[] = [];
    for (const [path, entry] of openDraftsRef.current) {
      if (entry.draft !== entry.loaded.content) dirtyPaths.push(path);
    }
    setInactiveDirtyPaths((current) => (
      current.length === dirtyPaths.length && current.every((path, index) => path === dirtyPaths[index])
        ? current
        : dirtyPaths
    ));
  }, []);
  const compileSequenceRef = useRef(0);
  const documentEpochRef = useRef(0);
  const compileEpochRef = useRef(0);
  const forwardSearchEpochRef = useRef(0);
  const sourcePathRef = useRef<string | null>(sourcePath);
  const documentRootPathRef = useRef<string | null>(documentRootPath);
  const documentSourcesRef = useRef<Record<string, string>>(documentSources);
  const loadedRef = useRef<FileText | null>(loaded);
  const activeCompileRunIdRef = useRef<string | null>(activeCompileRunId);
  const saveInFlightRef = useRef<Promise<FileText | null> | null>(null);
  const dirtySinceRef = useRef<number | null>(null);
  const externalChangeRef = useRef<PendingExternalChange | null>(externalChange);
  const pendingChangeSetsRef = useRef<TypesetChangeSet[]>(pendingChangeSets);
  const captureTimerRef = useRef(0);
  const reviewDraftSaveRef = useRef(0);
  const pendingCaptureRef = useRef<{
    provenance: { actor: string; origin: string };
    evidence: string | null;
  } | null>(null);
  const lastFlushedCaptureRef = useRef<{ actor: string; origin: string; atMs: number } | null>(null);
  const currentActionRef = useRef<{ id: string; closed: boolean; atMs: number } | null>(null);
  const persistDraftRef = useRef<() => Promise<FileText | null>>(async () => null);
  const compileProgressTimerRef = useRef<number | null>(null);
  const pendingCompileProgressRef = useRef<(CompileLiveLog & { runId: string }) | null>(null);
  const activeWorkDirRef = useRef<string | undefined>(undefined);
  sourcePathRef.current = sourcePath;
  documentRootPathRef.current = documentRootPath;
  documentSourcesRef.current = documentSources;
  loadedRef.current = loaded;
  activeCompileRunIdRef.current = activeCompileRunId;
  externalChangeRef.current = externalChange;
  pendingChangeSetsRef.current = pendingChangeSets;

  useEffect(() => () => {
    if (compileProgressTimerRef.current !== null) {
      window.clearTimeout(compileProgressTimerRef.current);
      compileProgressTimerRef.current = null;
    }
    pendingCompileProgressRef.current = null;
  }, []);

  useEffect(() => {
    setCompileErrorHandling(loadCompileErrorHandling(currentProject?.id));
  }, [currentProject?.id]);

  // Citation completion reads the shared literature store. Loading it
  // re-projects every canonical record, which is seconds of work and tens of
  // megabytes of JSON on a large library — far too much to repeat every time
  // this tab is opened. Load it only when this project's library is not
  // already in memory; the Library tab owns keeping it current after that.
  //
  // What this can go stale on is the citation picker's list, not the
  // bibliography: `synchronizeBibliography` exports from the backend, so the
  // generated `.bib` always reflects the current library either way.
  useEffect(() => {
    if (!currentProject?.id || !isTauri()) return;
    const { loaded, loadedProjectId } = useLiteratureStore.getState();
    if (loaded && loadedProjectId === currentProject.id) return;
    void loadLiterature(currentProject.id, { quiet: true });
  }, [currentProject?.id, loadLiterature]);

  useEffect(() => {
    let active = true;
    void localEnvironmentCheck("latex")
      .then((check) => {
        if (active) setLatexAvailable(check.available);
      })
      .catch(() => {
        if (active) setLatexAvailable(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const dirty = Boolean(loaded && draft !== loaded.content);
  const [analysisDraftSnapshot, setAnalysisDraftSnapshot] = useState(() => ({ path: sourcePath, source: draft }));
  const analysisPathRef = useRef(sourcePath);
  useEffect(() => {
    const switchedDocument = analysisPathRef.current !== sourcePath;
    if (switchedDocument || !dirty) {
      analysisPathRef.current = sourcePath;
      setAnalysisDraftSnapshot((current) => (
        current.path === sourcePath && current.source === draft
          ? current
          : { path: sourcePath, source: draft }
      ));
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setAnalysisDraftSnapshot({ path: sourcePath, source: draftRef.current });
    }, LATEX_ANALYSIS_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, sourcePath]);
  // A path mismatch can exist for one render before the effect above commits;
  // never expose the previous file's analysis during that transition.
  const analysisDraft = analysisDraftSnapshot.path === sourcePath
    ? analysisDraftSnapshot.source
    : draft;

  // Only the settled analysis snapshot, include directives, file switches, and
  // tree mutations drive the graph reads below. The editor document itself stays
  // synchronous, while project-wide derivations coalesce the typing burst.
  const includeSignature = useMemo(
    () => (sourcePath ? includeTargetsFor(analysisDraft, sourcePath, documentRootPath ?? sourcePath).join("\n") : ""),
    [analysisDraft, documentRootPath, sourcePath],
  );

  useEffect(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath || !sourcePath) {
      setDocumentSources((current) => (Object.keys(current).length === 0 ? current : {}));
      setDocumentGraphTruncated(false);
      return;
    }
    let active = true;
    void (async () => {
      const nextSources: Record<string, string> = {};
      const attempted = new Set<string>();
      const processed = new Set<string>();
      const queue: string[][] = [[rootPath]];
      while (queue.length > 0 && Object.keys(nextSources).length < INCLUDE_MAX_FILES) {
        const candidates = queue.shift();
        if (!candidates) continue;
        let loaded: { path: string; source: string } | null = null;
        for (const candidate of candidates) {
          loaded = documentSourceForPath(nextSources, candidate);
          if (loaded) break;
          if ([...attempted].some((path) => sameWorkspacePath(path, candidate))) continue;
          attempted.add(candidate);
          try {
            const content = sameWorkspacePath(candidate, sourcePath)
              ? draftRef.current
              : (await fileReadText(candidate)).content;
            if (!active) return;
            nextSources[candidate] = content;
            loaded = { path: candidate, source: content };
            break;
          } catch {
            // Try the next compiler-compatible candidate for this directive.
          }
        }
        if (!loaded || [...processed].some((path) => sameWorkspacePath(path, loaded.path))) continue;
        processed.add(loaded.path);
        queue.push(...includeCandidateGroupsFor(loaded.source, loaded.path, rootPath));
      }
      if (active) {
        setDocumentSources(nextSources);
        setDocumentGraphTruncated(queue.length > 0);
      }
    })();
    return () => {
      active = false;
    };
  }, [documentRootPath, includeSignature, sourcePath, treeRefreshKey]);

  const toggleSpellCheck = useCallback(() => {
    setSpellCheck((enabled) => {
      const next = !enabled;
      try {
        window.localStorage.setItem(SPELL_CHECK_STORAGE_KEY, next ? "on" : "off");
      } catch {
        // The choice still applies for this session without local storage.
      }
      return next;
    });
  }, []);

  const setCompileErrorHandlingPreference = useCallback((value: CompileErrorHandling) => {
    setCompileErrorHandling(value);
    try {
      window.localStorage.setItem(compileErrorHandlingStorageKey(currentProject?.id), value);
    } catch {
      // The preference remains active for this session if local storage is unavailable.
    }
  }, [currentProject?.id]);

  const setLatexEnginePreference = useCallback((value: LatexEngineChoice) => {
    setLatexEngine(value);
    writeStoredValue(
      projectScopedKey(LATEX_ENGINE_STORAGE_PREFIX, currentProject?.id),
      value === "auto" ? null : value,
    );
  }, [currentProject?.id]);

  const setCompileOnSavePreference = useCallback((value: boolean) => {
    setCompileOnSave(value);
    writeStoredValue(
      projectScopedKey(COMPILE_ON_SAVE_STORAGE_PREFIX, currentProject?.id),
      value ? "on" : "off",
    );
  }, [currentProject?.id]);

  const setMainDocumentPreference = useCallback((value: string | null) => {
    setMainDocumentPath(value);
    writeStoredValue(projectScopedKey(MAIN_DOCUMENT_STORAGE_PREFIX, currentProject?.id), value);
  }, [currentProject?.id]);

  /** Save-as for the compiled PDF: the workspace copy stays where TeX put it. */
  const exportPreviewPdf = useCallback(async () => {
    if (!previewPath) return;
    const suggested = previewPath.split(/[\\/]/).pop() || "document.pdf";
    try {
      const destination = await saveDialog({
        defaultPath: suggested,
        filters: [{ name: copy.pdfFilter, extensions: ["pdf"] }],
      });
      if (typeof destination !== "string") return;
      await typesetExportFile(previewPath, destination);
      setForwardSearchNotice(copy.pdfSaved(destination));
    } catch (exportError) {
      setError(String(exportError));
    }
  }, [copy, previewPath]);

  /** Overleaf's "download project as zip": the sources a collaborator or a
   * journal needs, without the build artifacts. */
  const exportProjectArchive = useCallback(async () => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath) return;
    const folder = dirname(rootPath).split("/").pop() || "project";
    try {
      const destination = await saveDialog({
        defaultPath: `${folder}.zip`,
        filters: [{ name: copy.zipFilter, extensions: ["zip"] }],
      });
      if (typeof destination !== "string") return;
      await typesetExportProject(rootPath, destination);
      setForwardSearchNotice(copy.projectSaved(destination));
    } catch (exportError) {
      setError(String(exportError));
    }
  }, [copy, documentRootPath, sourcePath]);

  const exportOutputFile = useCallback(async (file: TypesetOutputFile) => {
    try {
      const destination = await saveDialog({ defaultPath: file.name });
      if (typeof destination !== "string") return;
      await typesetExportFile(file.path, destination);
      setForwardSearchNotice(copy.pdfSaved(destination));
    } catch (exportError) {
      setError(String(exportError));
    }
  }, [copy]);

  const togglePdfInverted = useCallback(() => {
    setPdfInverted((inverted) => {
      const next = !inverted;
      writeStoredValue(PDF_INVERT_STORAGE_KEY, next ? "on" : "off");
      return next;
    });
  }, []);

  const syncTexMappingStale = syncTexOutdated || dirty || compileResult?.pdfState === "stale" || compileResult?.pdfState === "partial";
  useEffect(() => {
    // A background tab holding unsaved edits still counts: the close guard has
    // to warn about work the editor is not currently showing.
    setTypesetDirty(dirty || inactiveDirtyPaths.length > 0);
  }, [dirty, inactiveDirtyPaths.length, setTypesetDirty]);
  const outlineSources = useMemo(() => (
    sourcePath ? { ...documentSources, [sourcePath]: analysisDraft } : documentSources
  ), [analysisDraft, documentSources, sourcePath]);
  const outline = useMemo(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath) return [];
    const rootSource = documentSourceForPath(outlineSources, rootPath)?.source
      ?? (sameWorkspacePath(rootPath, sourcePath) ? analysisDraft : "");
    return rootSource ? outlineFor(rootSource, rootPath, outlineSources) : [];
  }, [analysisDraft, documentRootPath, outlineSources, sourcePath]);
  const numberedOutline = useMemo(() => numberedOutlineFor(outline), [outline]);
  // The Visual editor numbers its own headings live, but has to start from the
  // counters the document has already reached at this file — otherwise a
  // chapter that main.tex pulls in second renders "1.2.1" beside a PDF that
  // says "2.2.1". Derived from the same walk that numbers the Outline panel, so
  // the two surfaces cannot disagree.
  const visualNumbering = useMemo(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath || !sourcePath) return null;
    const rootSource = documentSourceForPath(outlineSources, rootPath)?.source
      ?? (sameWorkspacePath(rootPath, sourcePath) ? analysisDraft : "");
    return numberingPrefixFor(outline, sourcePath, rootSource);
  }, [analysisDraft, documentRootPath, outline, outlineSources, sourcePath]);
  // Counted over the whole document graph, so a thesis root reports the thesis
  // rather than the handful of words in its shell.
  const documentWordCount = useMemo(
    () => Object.values(outlineSources).reduce((total, source) => total + wordCountFor(source), 0),
    [outlineSources],
  );

  // Autocomplete for \ref{ and \cite{ needs keys the open file alone can't
  // supply: a label defined in another chapter of the same thesis, and the
  // library entries the citation picker inserts.
  const projectLabels = useMemo(() => {
    const labels: LatexSymbol[] = [];
    const seen = new Set<string>();
    for (const [path, source] of Object.entries(outlineSources)) {
      for (const command of scanLatexStructure(source).commandsNamed("label")) {
        const name = command.requiredArguments[0]?.value.trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        labels.push({ name, detail: basename(path) });
      }
    }
    return labels;
  }, [outlineSources]);
  // Most projects keep their references in a hand-maintained .bib rather than
  // the app library, so follow \bibliography{}/\addbibresource{} the same way
  // the outline follows \input and read the keys from there too.
  const bibliographySignature = useMemo(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath) return "";
    const targets: string[] = [];
    for (const [path, source] of Object.entries(outlineSources)) {
      for (const target of bibliographyTargets(source)) {
        for (const base of [dirname(rootPath), dirname(path)]) {
          const resolved = resolveTexPath(target, base, ".bib");
          if (resolved && !targets.includes(resolved)) targets.push(resolved);
        }
      }
    }
    return targets.join("\n");
  }, [documentRootPath, outlineSources, sourcePath]);

  const [bibCitations, setBibCitations] = useState<LatexSymbol[]>([]);
  useEffect(() => {
    if (!bibliographySignature) {
      setBibCitations((current) => (current.length === 0 ? current : []));
      return;
    }
    let active = true;
    void (async () => {
      const citations: LatexSymbol[] = [];
      const seen = new Set<string>();
      for (const path of bibliographySignature.split("\n")) {
        try {
          const file = await fileReadText(path);
          if (!active) return;
          for (const entry of parseBibEntries(file.content)) {
            if (seen.has(entry.key)) continue;
            seen.add(entry.key);
            citations.push({ name: entry.key, detail: bibEntryDetail(entry) });
          }
        } catch {
          // A .bib named but not present yet simply contributes no keys.
        }
      }
      if (active) setBibCitations(citations);
    })();
    return () => {
      active = false;
    };
  }, [bibliographySignature, treeRefreshKey]);

  const projectCitations = useMemo(() => {
    const citations = literaturePapers.map((paper) => ({
      name: paper.citationKey || suggestedCitationKey(paper),
      detail: paper.title,
    }));
    const seen = new Set(citations.map((citation) => citation.name));
    return [...citations, ...bibCitations.filter((citation) => !seen.has(citation.name))];
  }, [bibCitations, literaturePapers]);

  // File paths for \includegraphics{} / \input{} / \bibliography{}, relative to
  // the compile root the way TeX itself resolves them.
  const [projectFiles, setProjectFiles] = useState<LatexSymbol[]>([]);
  // The figure dialog picks from what the project actually contains, so a
  // freshly inserted float compiles instead of pointing at a placeholder.
  const projectImagePaths = useMemo(
    () => projectFiles.map((file) => file.name).filter(isFigureImage),
    [projectFiles],
  );
  useEffect(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath) return;
    let active = true;
    void (async () => {
      const rootDir = dirname(rootPath);
      const found: LatexSymbol[] = [];
      const seen = new Set<string>();
      for (const pattern of COMPLETABLE_FILE_PATTERNS) {
        let matches: string[] = [];
        try {
          // Completion only needs files belonging to the current document.
          // Passing the root directory avoids repeating a workspace-wide glob
          // for every extension when a project contains many unrelated files.
          const result = await fileSearch(pattern, rootDir);
          // `fileSearch` is mocked in some tests to return undefined; treat
          // anything non-array as "no matches for this pattern" instead of
          // letting the for-of throw and surface as an unhandled rejection.
          matches = Array.isArray(result) ? result : [];
        } catch {
          continue;
        }
        if (!active) return;
        for (const match of matches) {
          const path = normalizePath(match);
          const relative = rootDir && path.startsWith(`${rootDir}/`) ? path.slice(rootDir.length + 1) : path;
          if (seen.has(relative)) continue;
          seen.add(relative);
          found.push({ name: relative, detail: dirname(relative) || undefined });
        }
      }
      if (active) setProjectFiles(found);
    })();
    return () => {
      active = false;
    };
  }, [documentRootPath, sourcePath, treeRefreshKey]);

  useEffect(() => {
    setLatexProjectSymbols({ labels: projectLabels, citations: projectCitations, files: projectFiles });
  }, [projectCitations, projectFiles, projectLabels]);
  useEffect(() => clearLatexProjectSymbols, []);

  // Compiler errors belong on the offending line, not only in the log panel.
  // A diagnostic without a file belongs to the root document TeX was given.
  const compileMarkers = useMemo<LatexCompileMarker[]>(() => {
    if (!sourcePath) return [];
    const rootPath = compileResult?.inputPath ?? documentRootPath ?? sourcePath;
    return (compileResult?.diagnostics ?? [])
      .filter((diagnostic) => (diagnostic.line ?? 0) > 0 && sameWorkspacePath(diagnostic.filePath || rootPath, sourcePath))
      .map((diagnostic) => ({
        line: diagnostic.line ?? 1,
        severity: diagnostic.severity === "error" ? "error" : diagnostic.severity === "warning" ? "warning" : "info",
        message: diagnostic.code ? `${diagnostic.message} (${diagnostic.code})` : diagnostic.message,
      }));
  }, [compileResult?.diagnostics, compileResult?.inputPath, documentRootPath, sourcePath]);

  useEffect(() => {
    for (const view of [editorRef.current?.view, visualViewRef.current]) {
      if (!view) continue;
      view.dispatch({ effects: setLatexCompileMarkers.of(compileMarkers) });
    }
  }, [compileMarkers, editorMode]);

  const beamerSlides = useMemo(() => beamerSlidesFor(analysisDraft), [analysisDraft]);
  const documentBeamerSlides = useMemo(() => {
    const rootPath = documentRootPath ?? sourcePath;
    if (!rootPath) return [];
    const rootSource = documentSourceForPath(outlineSources, rootPath)?.source
      ?? (sameWorkspacePath(rootPath, sourcePath) ? analysisDraft : "");
    return rootSource ? beamerSlidesForDocument(rootSource, rootPath, outlineSources) : [];
  }, [analysisDraft, documentRootPath, outlineSources, sourcePath]);
  const activeOutlineItem = useMemo(
    // Lines from an included chapter belong to another file, so only the open
    // file's own headings can track the cursor.
    () => activeOutlineItemForLine(numberedOutline.filter((item) => sameWorkspacePath(item.file, sourcePath)), currentSourceLine),
    [currentSourceLine, numberedOutline, sourcePath],
  );
  const activeBeamerSlide = useMemo(
    () => activeBeamerSlideForLine(beamerSlides, currentSourceLine),
    [beamerSlides, currentSourceLine],
  );
  const documentBeamerIndex = activeBeamerSlide && sourcePath
    ? documentBeamerSlides.findIndex((slide) =>
      sameWorkspacePath(slide.file, sourcePath)
        && currentSourceLine >= slide.line
        && currentSourceLine <= slide.endLine,
    )
    : -1;
  const activeBeamerFallbackPage = Math.max(
    1,
    documentBeamerIndex >= 0
      ? documentBeamerIndex + 1
      : activeBeamerSlide ? beamerSlides.indexOf(activeBeamerSlide) + 1 : 1,
  );
  const activeBeamerLine = activeBeamerSlide?.line ?? null;
  useEffect(() => {
    setSyncedBeamerPage(null);
    if (!activeBeamerLine || !sourcePath || !previewPath || extension(previewPath) !== ".pdf") return;
    const compiled = compiledSourceFor(compiledSourcesRef.current, sourcePath);
    if (syncTexMappingStale && compiled === undefined) return;
    const current = draftRef.current;
    const compiledLine = compiled !== undefined && compiled !== current
      ? remapCompiledLine(current, compiled, activeBeamerLine)
      : activeBeamerLine;
    let active = true;
    void latexForwardSearch(sourcePath, previewPath, compiledLine, 1)
      .then((result) => {
        const page = result.locations[0]?.page;
        if (active && page && page > 0) setSyncedBeamerPage(page);
      })
      .catch(() => {
        // The project-order fallback remains deterministic when SyncTeX is not
        // available (browser preview, an old PDF, or an unsupported engine).
      });
    return () => {
      active = false;
    };
  }, [activeBeamerLine, previewPath, refreshKey, sourcePath, syncTexMappingStale]);
  const activeBeamerPage = syncedBeamerPage ?? activeBeamerFallbackPage;
  const slideFocusActive = editorMode === "visual" && beamerSlides.length > 0 && slideFocusMode;
  const effectiveProjectPanelVisible = projectPanelVisible && !slideFocusActive;
  const effectivePdfPanelVisible = pdfPanelVisible && !slideFocusActive;
  // A standalone file (e.g. a tikz figure with its own \documentclass) can
  // resolve its own compile root to itself even while it lives inside the
  // project that is already open in the sidebar. Re-rooting the tree to that
  // narrower folder on every such click is what made the file tree "jump"
  // around, so once a project folder is pinned here, opening a file inside it
  // only widens the pin (or fully switches it for an unrelated project) —
  // it never narrows into one of the pinned folder's own subfolders.
  const rawWorkDir = workDirForSource(documentRootPath ?? compileResult?.inputPath ?? sourcePath ?? previewPath);
  const pinnedWorkDir = activeWorkDirRef.current;
  const activeWorkDir = sourcePath && pinnedWorkDir !== undefined && workDirContains(pinnedWorkDir, rawWorkDir)
    ? pinnedWorkDir
    : rawWorkDir;
  activeWorkDirRef.current = sourcePath ? activeWorkDir : undefined;
  const browserPreviewMode = !isTauri();
  const diagnosticsCount = useMemo(() => {
    if (compileResult?.diagnostics?.length) return compileResult.diagnostics.length;
    const text = [error, compileResult?.stderr].filter(Boolean).join("\n").trim();
    if (!text) return 0;
    const count = text.split(/\r?\n/).filter((line) => line.trim()).length;
    return Math.min(count, 9);
  }, [compileResult?.diagnostics, compileResult?.stderr, error]);
  const activeEditorView = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
  const canUndoDraft = Boolean(activeEditorView && undoDepth(activeEditorView.state) > 0);
  const canRedoDraft = Boolean(activeEditorView && redoDepth(activeEditorView.state) > 0);

  const resetDraft = useCallback((nextDraft: string) => {
    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }, []);

  const invalidateActiveCompile = useCallback(() => {
    compileEpochRef.current += 1;
    forwardSearchEpochRef.current += 1;
    const runId = activeCompileRunIdRef.current;
    activeCompileRunIdRef.current = null;
    setActiveCompileRunId(null);
    if (runId) {
      setCompileStatus("idle");
      setCompileLiveLog(null);
      void latexCompileCancel(runId).catch(() => {
        // A document transition must not be blocked by a best-effort cancel.
      });
    }
  }, []);

  useEffect(() => () => {
    documentEpochRef.current += 1;
    compileEpochRef.current += 1;
    const runId = activeCompileRunIdRef.current;
    activeCompileRunIdRef.current = null;
    if (runId) void latexCompileCancel(runId).catch(() => undefined);
  }, []);

  const changeDraft = useCallback((nextDraft: string) => {
    if (nextDraft !== draftRef.current) setSyncTexOutdated(true);
    draftRef.current = nextDraft;
    const codeView = editorRef.current?.view;
    const visualView = visualViewRef.current;
    // Both surfaces stay mounted. The editor that received the user edit has
    // already recorded it; its counterpart must receive an external change so
    // Ctrl+Z never traverses another editor's history.
    if (codeView && codeView.state.doc.toString() !== nextDraft) {
      editorRef.current?.setDocument(nextDraft, { addToHistory: false, preserveSelection: true });
    }
    if (visualView && visualView.state.doc.toString() !== nextDraft) {
      const replacement = minimalReplacement(visualView.state.doc.toString(), nextDraft);
      visualView.dispatch({
        changes: replacement,
        annotations: Transaction.addToHistory.of(false),
      });
    }
    setDraft(nextDraft);
  }, []);

  const updateExternalChange = useCallback((next: PendingExternalChange | null) => {
    // A proposal with no hunks is not a review. Nothing is displayable, nothing
    // is decidable, and every button resolves to the incoming bytes — including
    // "reject", because the merged result is compared against the operation's
    // after-hash. This is the one chokepoint every producer goes through
    // (watcher, tab open, restored proposal, change-set drill-in), so the
    // invariant belongs here rather than at each call site.
    //
    // A change too large to chunk is the one hunkless case that IS a review: it
    // has no hunks precisely because there is too much to answer piecewise, and
    // dropping it here let a whole-file rewrite pass with no review at all —
    // the opposite of what this gate is for. It resolves through the
    // whole-file choice instead.
    const reviewable = next
      && (next.decisions.length > 0 || next.tooLargeToChunk);
    const proposal = reviewable ? next : null;
    externalChangeRef.current = proposal;
    setExternalChange(proposal);
  }, []);

  const upsertPendingChangeSet = useCallback((next: TypesetChangeSet) => {
    setPendingChangeSets((current) => {
      // A carried transaction is no longer pending on disk, but the copy held
      // here still says it is. Leaving it would keep an answered-forever entry
      // at the head of the queue, in front of the review that replaced it.
      const pending = current.filter((item) => (
        item.id !== next.id && item.id !== next.carriedFrom && item.status === "pending"
      ));
      if (next.status === "pending") pending.push(next);
      pending.sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id));
      return pending;
    });
  }, []);

  const removePendingChangeSet = useCallback((id: string) => {
    setPendingChangeSets((current) => current.filter((item) => item.id !== id));
  }, []);

  /**
   * True while one file is still waiting for a review answer.
   *
   * Editor gates are scoped to this rather than to "any review is open
   * anywhere in the project": build output no longer enters a revision, so a
   * pending review is always about specific authored files, and holding the
   * whole workspace hostage to one of them only strands unrelated work.
   *
   * Only an unanswered entry counts. A rebase carries the user's own saves in
   * as `accept`, so gating on mere presence would lock them out of their own
   * file; and once a file has been answered, saving it again simply reopens
   * that answer on the next rebase, because the operation no longer matches the
   * one the decision was recorded against.
   */
  const awaitingReviewAnswer = useCallback((path: string | null) => {
    if (!path) return false;
    return pendingChangeSetsRef.current.some((changeSet) => changeSet.decisions.some((item) => (
      item.decision === "pending" && sameWorkspacePath(item.path, path)
    )));
  }, []);

  // A pending review is durable project state, not component state. Restore the
  // queue when the workspace is opened so changing tabs or restarting SomniQ
  // can never make an unreviewed agent/external write silently look accepted.
  useEffect(() => {
    const projectId = currentProject?.id ?? null;
    let disposed = false;
    setPendingChangeSets([]);
    setChangeSetOperationPreview(null);
    if (!isTauri() && !isFilePreviewMode()) return () => { disposed = true; };
    void typesetChangeSetList().then((items) => {
      if (disposed || (useStore.getState().currentProject?.id ?? null) !== projectId) return;
      setPendingChangeSets(items
        .filter((item) => item.status === "pending")
        .sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id)));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [currentProject?.id]);

  useEffect(() => {
    if (externalChangeRef.current && externalChangeRef.current.path !== sourcePath) {
      updateExternalChange(null);
    }
    setExternalReviewBusy(null);
  }, [sourcePath, updateExternalChange]);

  /**
   * Which editing action a capture belongs to.
   *
   * A review answers for one action, and the backend only lets writes from the
   * same one extend a transaction — otherwise a Chat turn that removes text an
   * earlier, unreviewed write introduced cancels inside the wider span and
   * disappears from the review entirely. Only this component knows where an
   * action starts: Chat's completion event and a project-open drift scan are
   * both boundaries (each is a finished action by the time it is reported),
   * while a burst of watcher notifications is one action for as long as it
   * keeps arriving. A finished action still claims the writes that trail it,
   * because a turn's last notification lands after its completion event.
   */
  const actionIdFor = useCallback((provenance: { actor: string; origin: string }) => {
    const atMs = Date.now();
    const current = currentActionRef.current;
    const boundary = provenance.origin === "chat" || provenance.origin === "project-open";
    const expired = !current || (current.closed
      ? atMs - current.atMs > ACTION_TRAILING_MS
      : atMs - current.atMs > ACTION_IDLE_MS);
    if (boundary || expired) {
      currentActionRef.current = { id: `${provenance.origin}-${atMs}`, closed: boundary, atMs };
      return currentActionRef.current.id;
    }
    if (!current.closed) current.atMs = atMs;
    return current.id;
  }, []);

  const captureProjectChangeSet = useCallback((
    provenance: { actor: string; origin: string },
    evidence: string | null,
  ) => {
    const projectId = currentProject?.id ?? null;
    void typesetRevisionCapture({
      reason: `${provenance.actor}-change`,
      actor: provenance.actor,
      origin: provenance.origin,
      evidence,
    }).then((revision) => {
      if (!revision.parentRevisionId || revision.operations.length === 0) return undefined;
      // A watcher notification caused by our own save returns the already
      // recorded user/editor revision. Do not turn that into a review gate.
      if (provenance.actor !== "chat"
        && (revision.actor !== provenance.actor || revision.origin !== provenance.origin)) return undefined;
      return typesetChangeSetCreate({
        revisionId: revision.id,
        actor: provenance.actor,
        origin: provenance.origin,
        evidence,
        // Claimed only now: a capture that turned out to change nothing must not
        // consume the action a real write is still filling.
        actionId: actionIdFor(provenance),
      }).then((changeSet) => {
        if ((useStore.getState().currentProject?.id ?? null) === projectId) upsertPendingChangeSet(changeSet);
      });
    }).catch(() => undefined);
  }, [actionIdFor, currentProject?.id, upsertPendingChangeSet]);

  /**
   * Coalesce a burst of change notifications into one capture.
   *
   * Every producer goes through here — the workspace watcher, and the active
   * source's own detection — because one agent edit reaches both. Capturing per
   * notification is what turned a single editing session into 299 separate
   * review gates, each demanding its own decision, when the whole burst was one
   * logical action. The first path in the burst is kept as the evidence: it is
   * the write that started it, while the later ones are the toolchain reacting.
   * A caller with nothing to point at passes null and does not consume the
   * slot, so a real notification can still fill it.
   */
  const scheduleProjectChangeSet = useCallback((
    provenance: { actor: string; origin: string },
    evidence: string | null,
  ) => {
    // `presentExternalChange` schedules a capture for the same provenance a
    // `flushProjectChangeSet` caller already fired synchronously moments ago
    // (Chat's own completion event triggers both, the second time through the
    // proposal it opens for the active file). The flush already covers the
    // whole project for that reason; scheduling again created a second,
    // independent change set out of the same event.
    const lastFlush = lastFlushedCaptureRef.current;
    if (lastFlush
      && lastFlush.actor === provenance.actor
      && lastFlush.origin === provenance.origin
      && Date.now() - lastFlush.atMs < WATCHER_CAPTURE_QUIET_MS) return;
    pendingCaptureRef.current = {
      provenance,
      evidence: pendingCaptureRef.current?.evidence ?? evidence,
    };
    window.clearTimeout(captureTimerRef.current);
    captureTimerRef.current = window.setTimeout(() => {
      const next = pendingCaptureRef.current;
      pendingCaptureRef.current = null;
      if (next) captureProjectChangeSet(next.provenance, next.evidence);
    }, WATCHER_CAPTURE_QUIET_MS);
  }, [captureProjectChangeSet]);

  /**
   * Capture now, absorbing anything the debounce is still holding. Chat
   * completion is an explicit action boundary, so it must not race the pending
   * watcher burst into a second change set with weaker provenance.
   */
  const flushProjectChangeSet = useCallback((
    provenance: { actor: string; origin: string },
    evidence: string | null,
  ) => {
    window.clearTimeout(captureTimerRef.current);
    pendingCaptureRef.current = null;
    lastFlushedCaptureRef.current = { actor: provenance.actor, origin: provenance.origin, atMs: Date.now() };
    captureProjectChangeSet(provenance, evidence);
  }, [captureProjectChangeSet]);

  useEffect(() => () => window.clearTimeout(captureTimerRef.current), []);

  // Establish a complete baseline before any watcher event can arrive. This is
  // what lets an external editor, Chat, or a Git operation be represented as a
  // project-level delta even when it changes files the current tab never read.
  //
  // Establishing it can itself discover a change: a workspace that already
  // differs from HEAD was written while this editor was not watching. Recording
  // that as `user`/`editor` misattributed it and — because a rebase carries the
  // user's own edits forward instead of reviewing them — would have turned an
  // agent's write into a silent accept. When nothing drifted no revision is
  // created, so this stays free on an ordinary tab switch.
  // Evidence is deliberately null: the tab that happened to be open is not
  // evidence of what changed, and claiming it would outrank the path from a
  // real notification, which the scheduler keeps in arrival order.
  useEffect(() => {
    if (!sourcePath || !loaded) return;
    scheduleProjectChangeSet({ actor: "external", origin: "project-open" }, null);
  }, [loaded, scheduleProjectChangeSet, sourcePath]);

  const presentExternalChange = useCallback(async (
    diskFile: FileText,
    provenance: { actor: string; origin: string } = { actor: "external", origin: "watcher" },
  ): Promise<boolean> => {
    const activePath = sourcePathRef.current;
    const baseFile = loadedRef.current;
    if (!activePath || !baseFile || !sameWorkspacePath(activePath, diskFile.path)) return false;
    if (sameFileSnapshot(baseFile, diskFile)) {
      // Encoding/line-ending-only writes can change the byte fingerprint while
      // decoding to the exact same editor text. Advance the optimistic-save
      // baseline silently so the next real edit does not report a false conflict.
      if (baseFile.version !== diskFile.version) {
        loadedRef.current = diskFile;
        setLoaded(diskFile);
      }
      if (externalChangeRef.current?.path === activePath) updateExternalChange(null);
      return false;
    }
    const current = externalChangeRef.current;
    if (!current || !sameFileSnapshot(current.file, diskFile)) {
      // A review already open with typing in it makes that typing the local
      // side: it is the newest text a person authored for this file, and it
      // already carries whatever the previous proposal offered. Falling back to
      // `draft` here would rebase the new write onto the pre-review text and
      // drop every edit made while reviewing.
      const localContent = current?.path === activePath && current.reviewDraft !== null
        ? current.reviewDraft
        : draftRef.current;
      const next = await pendingExternalChange(
        activePath,
        baseFile,
        localContent,
        diskFile,
        provenance.actor,
        provenance.origin,
      );
      if (next.decisions.length === 0 && !next.tooLargeToChunk) {
        // The write landed on content this draft already holds, so the merge
        // proposes nothing. Advance the optimistic-save baseline instead of
        // gating: an empty proposal is a read-only editor behind three buttons
        // that all resolve to the same bytes. A draft that diverges elsewhere
        // stays dirty, because `dirty` compares against this new baseline.
        loadedRef.current = diskFile;
        setLoaded(diskFile);
        if (externalChangeRef.current?.path === activePath) updateExternalChange(null);
        void typesetChangeProposalClear(activePath).catch(() => undefined);
        setSyncTexOutdated(true);
        return false;
      }
      updateExternalChange(next);
      // A clean file can enter review directly in the user's current Code or
      // Visual mode. Preserve an unsaved local draft on screen until the user
      // explicitly switches to the incoming proposal.
      // The source has already changed outside this editor. Capture the whole
      // workspace once, then derive a durable ChangeSet from that revision so
      // a Chat run that touched several files remains one auditable action.
      scheduleProjectChangeSet(provenance, activePath);
      void typesetChangeProposalSave(activePath, proposalRecord(next)).catch(() => undefined);
    } else if (provenance.actor === "chat" && current.actor !== "chat") {
      // A watcher often fires just before the Chat-completed event. Upgrade
      // the audit provenance instead of mislabelling an agent change as an
      // anonymous external edit.
      updateExternalChange({ ...current, actor: provenance.actor, origin: provenance.origin });
    }
    setSyncTexOutdated(true);
    return true;
  }, [scheduleProjectChangeSet, updateExternalChange]);

  // Chat, paper-writing workflows and external editors all write through
  // different paths. The backend normalizes native workspace notifications, so
  // the editor only re-reads the active source when that path changes. Focus and
  // Chat completion remain recovery triggers for watcher-limited network drives.
  // A detected version is only staged for review — never applied here.
  useEffect(() => {
    if (!sourcePath || !loaded || !isTauri()) return undefined;
    let disposed = false;
    let checking = false;
    let unlistenChatDone: (() => void) | null = null;
    let unlistenWorkspace: (() => void) | null = null;
    const check = async (provenance?: { actor: string; origin: string }) => {
      if (disposed || checking || saveInFlightRef.current) return;
      checking = true;
      const checkedPath = sourcePathRef.current;
      const checkedEpoch = documentEpochRef.current;
      try {
        if (!checkedPath) return;
        const diskFile = await fileReadText(checkedPath);
        if (
          disposed
          || saveInFlightRef.current
          || checkedEpoch !== documentEpochRef.current
          || sourcePathRef.current !== checkedPath
        ) return;
        await presentExternalChange(diskFile, provenance);
      } catch {
        // A transient read failure must not replace the editor with an error
        // banner; explicit save/compile paths still report actionable failures.
      } finally {
        checking = false;
      }
    };
    const checkWhenVisible = () => {
      if (document.visibilityState !== "hidden") void check({ actor: "external", origin: "focus" });
    };
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    void onWorkspaceFileChanged((event) => {
      const provenance = { actor: "external", origin: "watcher" };
      const lowerPath = event.path.toLowerCase();
      const generated = GENERATED_OUTPUT_PATH.test(lowerPath)
        || TRANSIENT_TEMP_PATH.test(lowerPath)
        || sameWorkspacePath(event.path, previewPath);
      if (!generated && !saveInFlightRef.current) scheduleProjectChangeSet(provenance, event.path);
      if (sameWorkspacePath(event.path, sourcePathRef.current)) void check(provenance);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenWorkspace = unlisten;
    }).catch(() => {
      // Focus and Chat completion still provide bounded fallback checks.
    });
    void onChatDone(() => {
      const provenance = { actor: "chat", origin: "chat" };
      // Chat can modify files that are not open in a tab. Capture first at the
      // project boundary, then stage the active source for its detailed hunk
      // review when it is one of those files.
      flushProjectChangeSet(provenance, sourcePathRef.current);
      void check(provenance);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenChatDone = unlisten;
    }).catch(() => {
      // Polling remains the cross-writer fallback when the event bridge is not
      // available (for example, the browser preview).
    });
    return () => {
      disposed = true;
      window.removeEventListener("focus", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      unlistenChatDone?.();
      unlistenWorkspace?.();
    };
  }, [
    flushProjectChangeSet,
    loaded,
    presentExternalChange,
    previewPath,
    scheduleProjectChangeSet,
    sourcePath,
  ]);

  const refreshAfterChangeSetResolution = useCallback(async (resolved: TypesetChangeSet) => {
    removePendingChangeSet(resolved.id);
    const affectedPaths = resolved.decisions.map((item) => item.path);
    for (const path of affectedPaths) {
      openDraftsRef.current.delete(path);
      void typesetChangeProposalClear(path).catch(() => undefined);
      void typesetRecoveryClear(path).catch(() => undefined);
    }
    publishOpenDrafts();
    setDocumentSources((sources) => Object.fromEntries(
      Object.entries(sources).filter(([path]) => !affectedPaths.some((affected) => sameWorkspacePath(affected, path))),
    ));

    const activePath = sourcePathRef.current;
    if (activePath && affectedPaths.some((path) => sameWorkspacePath(path, activePath))) {
      // Retire the review before the editor is refilled. `changeDraft` pushes
      // the resolved bytes straight into both views, and a still-open proposal
      // would take that programmatic transaction for review-time typing.
      updateExternalChange(null);
      try {
        const file = await fileReadText(activePath);
        loadedRef.current = file;
        setLoaded(file);
        changeDraft(file.content);
        setDocumentSources((sources) => ({ ...sources, [file.path]: file.content }));
      } catch {
        setSourcePath(null);
        setPreviewPath(null);
        setLoaded(null);
        resetDraft("");
      }
    }
    setTreeRefreshKey((key) => key + 1);
    setSyncTexOutdated(true);
    dirtySinceRef.current = null;
  }, [changeDraft, publishOpenDrafts, removePendingChangeSet, resetDraft, updateExternalChange]);

  const finalizeExternalChange = useCallback(async (
    decisions: TypesetProposalDecision[],
    action: "accept" | "reject" | "apply",
    /**
     * Resolve the file as a whole instead of hunk by hunk. Used when the change
     * is too large to chunk: there are no hunks to answer, so the reviewer
     * chooses between the two complete versions and the merged bytes — not an
     * empty decision list — carry that choice to the backend.
     */
    wholeFile?: "incoming" | "local",
  ) => {
    const pending = externalChangeRef.current;
    if (!pending || externalReviewBusy) return;
    const reviewEpoch = documentEpochRef.current;
    const selectedWholeFile = wholeFile ?? pending.wholeFileDecision;
    // An empty decision list resolves to the local content unchanged. When the
    // local side already equals the incoming side that content hashes to the
    // operation's after-hash, so the backend records "accept" — a reject would
    // silently keep the external change. Never resolve a hunkless review.
    if (pending.tooLargeToChunk && !selectedWholeFile) return;
    if (!pending.tooLargeToChunk && !wholeFile
      && (decisions.length === 0 || decisions.some((decision) => decision === "pending"))) return;
    setExternalReviewBusy(action);
    setError(null);
    try {
      if (pending.tooLargeToChunk && selectedWholeFile) {
        // Record the complete-file choice before the resolving read. If the
        // file changes during that read, the newer proposal can replace this
        // one without an older selection racing it back onto disk.
        try {
          await typesetChangeProposalSave(
            pending.path,
            proposalRecord(pending, { wholeFileDecision: selectedWholeFile }),
          );
        } catch {
          // The actual resolve still has a chance to succeed; the next open
          // will simply show the choice again if this durable write failed.
        }
      }
      // Re-read before resolving so no button can apply an already stale review
      // while an agent is still writing the file.
      const latest = await fileReadText(pending.path);
      if (reviewEpoch !== documentEpochRef.current || sourcePathRef.current !== pending.path) return;
      if (!sameFileSnapshot(latest, pending.file)) {
        await presentExternalChange(latest);
        setError(copy.externalChangeUpdatedAgain(basename(pending.path)));
        return;
      }
      // The whole-file choice needs no merge: the reviewer picked one of the
      // two complete versions, and the backend derives accept/reject/partial
      // from the bytes it receives rather than from the decision list.
      let merged: string;
      if (selectedWholeFile) {
        // Taking the disk version replaces the file, which is exactly what that
        // choice means; keeping the local side keeps whatever was typed during
        // the review, because that text is the local side now.
        merged = selectedWholeFile === "incoming"
          ? latest.content
          : pending.reviewDraft ?? pending.localContent;
      } else {
        // Resolve the exact ranges shown on screen — recomputing here with the
        // fallback could assign the same decisions to different hunks — then
        // fold in anything the reviewer typed into those ranges' surroundings.
        const resolved = await resolveReviewedContent(pending, decisions);
        if (reviewEpoch !== documentEpochRef.current || sourcePathRef.current !== pending.path) return;
        if (!resolved.reliable) {
          setError(copy.externalChangeEditConflict(basename(pending.path)));
          return;
        }
        merged = resolved.content;
      }
      const changeSet = pendingChangeSetsRef.current.find((item) => (
        item.status === "pending"
        && item.decisions.some((decision) => sameWorkspacePath(decision.path, pending.path))
      ));
      const operation = changeSet?.decisions.find((decision) => sameWorkspacePath(decision.path, pending.path));

      if (changeSet && operation) {
        const hunkDecisions = decisions as Array<Exclude<TypesetProposalDecision, "pending">>;
        const staged = await typesetChangeSetStageText({
          id: changeSet.id,
          operationId: operation.operationId,
          path: operation.path,
          content: merged,
          hunkDecisions,
          hunkIds: pending.reviewDiff.changes.map((change) => change.id),
        });
        upsertPendingChangeSet(staged);
        const stagedProposal = { ...pending, decisions, wholeFileDecision: selectedWholeFile };
        updateExternalChange(stagedProposal);
        await typesetChangeProposalSave(pending.path, proposalRecord(stagedProposal, {
          incomingContent: latest.content,
          incomingVersion: latest.version ?? null,
        }));

        // Answering the last open file finishes the transaction — but only
        // when no other file in it is holding an unsaved draft. Resolving drops
        // those drafts, and this path has no way to carry them: staging a draft
        // into the transaction is what "Apply reviewed changes" does, so leave
        // that case to the explicit button rather than losing the edit here.
        const carriesUnsavedWork = staged.decisions.some((item) => {
          if (sameWorkspacePath(item.path, pending.path)) return false;
          const snapshot = openDraftsRef.current.get(item.path);
          return Boolean(snapshot && snapshot.draft !== snapshot.loaded.content);
        });
        if (!carriesUnsavedWork && staged.decisions.every((item) => item.decision !== "pending")) {
          let resolved = await typesetChangeSetResolve(staged.id, staged.decisions);
          if (resolved.status === "pending" && resolved.decisions.every((item) => item.decision !== "pending")) {
            // The project moved under this write, but the rebase kept every
            // answer this file (and the rest of the transaction) already
            // carried — retry once instead of leaving the banner's own click
            // looking like it did nothing.
            resolved = await typesetChangeSetResolve(resolved.id, resolved.decisions);
          }
          if (resolved.status === "pending") {
            // Still unwritten after the retry: leave the review open — the
            // last answer this banner gave has nowhere to go otherwise — and
            // say why, rather than letting it disappear as if it had resolved.
            upsertPendingChangeSet(resolved);
            setError(copy.pendingReviewChangedAgain);
          } else {
            await refreshAfterChangeSetResolution(resolved);
          }
        }
        return;
      }

      // A detailed proposal can still exist when an older installation did not
      // capture a project ChangeSet. Keep that compatibility path optimistic and
      // audited, but all new external/agent writes use the staged transaction.
      const resolved = latest.version
        ? await fileWriteText(pending.path, merged, latest.version)
        : await fileWriteText(pending.path, merged);
      if (reviewEpoch !== documentEpochRef.current || sourcePathRef.current !== pending.path) return;
      updateExternalChange(null);
      loadedRef.current = resolved;
      setLoaded(resolved);
      changeDraft(resolved.content);
      setSourcePath(resolved.path);
      setDocumentSources((sources) => ({ ...sources, [resolved.path]: resolved.content }));
      setTreeRefreshKey((key) => key + 1);
      setSyncTexOutdated(true);
      dirtySinceRef.current = null;
      void typesetChangeProposalClear(pending.path).catch(() => undefined);
      void typesetRecoveryClear(pending.path).catch(() => undefined);
    } catch (reviewError) {
      if (String(reviewError).includes("FILE_CONFLICT")) {
        try {
          const latest = await fileReadText(pending.path);
          if (reviewEpoch === documentEpochRef.current && sourcePathRef.current === pending.path) {
            await presentExternalChange(latest);
            setError(copy.externalChangeUpdatedAgain(basename(pending.path)));
          }
        } catch {
          setError(String(reviewError));
        }
      } else {
        setError(String(reviewError));
      }
    } finally {
      if (reviewEpoch === documentEpochRef.current) setExternalReviewBusy(null);
    }
  }, [
    changeDraft,
    copy,
    externalReviewBusy,
    presentExternalChange,
    refreshAfterChangeSetResolution,
    updateExternalChange,
    upsertPendingChangeSet,
  ]);

  const acceptExternalChange = useCallback(() => {
    const pending = externalChangeRef.current;
    if (!pending) return;
    void finalizeExternalChange(pending.decisions.map(() => "accept"), "accept");
  }, [finalizeExternalChange]);

  const rejectExternalChange = useCallback(() => {
    const pending = externalChangeRef.current;
    if (!pending) return;
    void finalizeExternalChange(pending.decisions.map(() => "reject"), "reject");
  }, [finalizeExternalChange]);

  // The two ways out of a change too large to review hunk by hunk. Persist the
  // choice before resolving so a process interruption cannot turn the empty
  // hunk list back into an ambiguous proposal on the next open.
  const chooseWholeFile = useCallback((decision: ExternalWholeFileDecision) => {
    const pending = externalChangeRef.current;
    if (!pending?.tooLargeToChunk || externalReviewBusy) return;
    const next = { ...pending, wholeFileDecision: decision };
    updateExternalChange(next);
    void finalizeExternalChange([], decision === "incoming" ? "accept" : "reject", decision);
  }, [externalReviewBusy, finalizeExternalChange, updateExternalChange]);

  const takeIncomingWholeFile = useCallback(() => {
    chooseWholeFile("incoming");
  }, [chooseWholeFile]);

  const keepLocalWholeFile = useCallback(() => {
    chooseWholeFile("local");
  }, [chooseWholeFile]);

  const decideExternalChange = useCallback((index: number, decision: TypesetProposalDecision) => {
    const pending = externalChangeRef.current;
    if (!pending || index < 0 || index >= pending.decisions.length) return;
    const decisions = pending.decisions.map((value, current) => current === index ? decision : value);
    const next = { ...pending, decisions };
    updateExternalChange(next);
    void typesetChangeProposalSave(pending.path, proposalRecord(next)).catch(() => undefined);
  }, [updateExternalChange]);

  /**
   * Adopt a keystroke made while a review is open.
   *
   * The review surface is the live editor, so the transaction that swaps the
   * proposal onto screen also reaches this callback. Only text that differs
   * from what the surface was asked to show can be a person typing; anything
   * equal to it is that echo and must not be recorded as an edit.
   *
   * The typing is held on the proposal instead of in `draft`: `draft` is the
   * merge's local side, and moving it would make every later recomputation
   * compare the incoming change against a copy of itself.
   */
  const editReviewDraft = useCallback((next: string) => {
    const pending = externalChangeRef.current;
    if (!pending) return;
    if (next === reviewDisplayText(pending)) return;
    const edited = { ...pending, reviewDraft: next };
    updateExternalChange(edited);
    setSyncTexOutdated(true);
    window.clearTimeout(reviewDraftSaveRef.current);
    reviewDraftSaveRef.current = window.setTimeout(() => {
      const latest = externalChangeRef.current;
      if (latest?.id !== edited.id) return;
      void typesetChangeProposalSave(latest.path, proposalRecord(latest)).catch(() => undefined);
    }, REVIEW_DRAFT_SAVE_QUIET_MS);
  }, [updateExternalChange]);

  /** Put the untouched proposal back on screen, dropping review-time typing. */
  const discardReviewDraft = useCallback(() => {
    const pending = externalChangeRef.current;
    if (!pending || pending.reviewDraft === null) return;
    window.clearTimeout(reviewDraftSaveRef.current);
    const restored = { ...pending, reviewDraft: null };
    updateExternalChange(restored);
    void typesetChangeProposalSave(restored.path, proposalRecord(restored)).catch(() => undefined);
  }, [updateExternalChange]);

  useEffect(() => () => window.clearTimeout(reviewDraftSaveRef.current), []);

  const applyExternalChangeReview = useCallback(() => {
    const pending = externalChangeRef.current;
    if (!pending) return;
    void finalizeExternalChange(pending.decisions, "apply");
  }, [finalizeExternalChange]);

  const resolveProjectChangeSet = useCallback(async (decision: "accept" | "reject" | null) => {
    const changeSet = pendingChangeSet;
    if (!changeSet || externalReviewBusy) return;
    if (decision === "reject") {
      // Rejecting restores this transaction's base. A transaction covers one
      // action, so that is normally "undo what Chat just did" and needs no
      // ceremony — but the first one after a gap starts at the last review that
      // was actually settled, which can be a day of work the reviewer never
      // opened a single file of. Warn exactly then: how far back it reaches is
      // the one thing the button does not say, and a dialog that fires every
      // time is a dialog nobody reads. Accepting keeps what is already on disk,
      // so this is the only blanket answer that can destroy anything.
      const unopened = changeSet.decisions.filter((item) => (
        item.decision === "pending" && !item.operationId.startsWith("comment:")
      ));
      let base: { createdAtMs: number } | undefined;
      try {
        base = (await typesetRevisionList())
          ?.find((revision) => revision.id === changeSet.baseRevisionId);
      } catch {
        // An unreadable ledger is exactly when the reach is unknown, which the
        // prompt below says in place of a date rather than skipping the ask.
      }
      const reach = base ? changeSet.createdAtMs - base.createdAtMs : Number.POSITIVE_INFINITY;
      if (unopened.length > 0 && reach > REJECT_REACH_WARNING_MS) {
        const since = base
          ? new Date(base.createdAtMs).toLocaleString()
          : copy.pendingReviewRejectSinceUnknown;
        if (!window.confirm(copy.pendingReviewRejectConfirm(unopened.length, since))) return;
      }
    }
    if (decision) {
      // A blanket answer must not become a shortcut around the explicit
      // complete-file choice. Inspect every still-open text operation first;
      // non-text operations keep their compact accept/reject review.
      for (const item of changeSet.decisions) {
        if (item.decision !== "pending") continue;
        try {
          const operation = await typesetChangeSetReadText(changeSet.id, item.path);
          if (!["create", "modify"].includes(operation.kind)
            || operation.baseContent === null
            || operation.incomingContent === null) continue;
          const diff = await externalTextDiffReliable(
            operation.baseContent,
            operation.incomingContent,
            operation.path,
            0,
          );
          if (diff.tooLargeToChunk) {
            setError(copy.pendingReviewLargeFileBlock(basename(operation.path)));
            return;
          }
        } catch {
          // Deletes, moves and binary files are intentionally handled by the
          // existing compact operation review.
        }
      }
    }
    // Bulk accept/reject answers what is still open; it does not undo answers
    // already on record. That matters beyond convenience: a rebase carries the
    // user's own saves in as `accept`, and overwriting those with a blanket
    // reject would restore their file to its pre-save content.
    const decisions = decision
      ? changeSet.decisions.map((item) => (item.decision === "pending"
          ? { ...item, decision, resolvedHash: null, resolvedBytes: null, hunkDecisions: [], hunkIds: [] }
          : item))
      : changeSet.decisions;
    if (decisions.some((item) => item.decision === "pending")) return;
    setExternalReviewBusy("apply");
    setError(null);
    try {
      let stagedChangeSet = { ...changeSet, decisions };
      const localDrafts = new Map<string, { draft: string; loaded: FileText }>();
      const activePath = sourcePathRef.current;
      const activeFile = loadedRef.current;
      if (activePath && activeFile && draftRef.current !== activeFile.content) {
        localDrafts.set(activePath, { draft: draftRef.current, loaded: activeFile });
      }
      for (const [path, snapshot] of openDraftsRef.current) {
        if (snapshot.draft !== snapshot.loaded.content) localDrafts.set(path, snapshot);
      }

      // Typing done inside the open review answers the same operation this
      // blanket decision does, and it is not a local draft: its base is the
      // proposal the reviewer was reading, not the file the editor loaded.
      // Merging it as a draft makes the incoming hunk look like a conflict with
      // the correction made *to* that hunk and resolves it back to the raw
      // incoming bytes — the reviewer's work, silently undone. Resolve it
      // through the same path the per-file banner uses so both agree.
      const reviewing = externalChangeRef.current;
      if (reviewing?.reviewDraft != null
        && !reviewing.tooLargeToChunk
        && sameWorkspacePath(reviewing.path, activePath)) {
        const item = stagedChangeSet.decisions.find((entry) => sameWorkspacePath(entry.path, reviewing.path));
        const answers: TypesetProposalDecision[] | null = item?.decision === "accept" || item?.decision === "reject"
          ? reviewing.decisions.map(() => item.decision as TypesetProposalDecision)
          : item?.hunkDecisions?.length === reviewing.decisions.length
            ? [...item.hunkDecisions]
            : null;
        if (item && answers) {
          const reviewed = await resolveReviewedContent(reviewing, answers);
          if (!reviewed.reliable) throw new Error(copy.externalChangeEditConflict(basename(reviewing.path)));
          localDrafts.delete(reviewing.path);
          const staged = await typesetChangeSetStageText({
            id: stagedChangeSet.id,
            operationId: item.operationId,
            path: item.path,
            content: reviewed.content,
            hunkDecisions: answers as Array<Exclude<TypesetProposalDecision, "pending">>,
            hunkIds: reviewing.reviewDiff.changes.map((change) => change.id),
          });
          stagedChangeSet = withBlanketAnswers(staged, item.operationId, stagedChangeSet);
        }
      }

      // Saving was intentionally blocked while a ChangeSet was pending, but
      // project-level review was also disabled by an affected local draft.
      // Stage each draft into the transaction so acceptance stays atomic and
      // local writing is preserved instead of creating an impossible loop.
      for (const [path, snapshot] of localDrafts) {
        const item = stagedChangeSet.decisions.find((entry) => sameWorkspacePath(entry.path, path));
        if (!item || item.decision === "pending") continue;
        const textOperation = await typesetChangeSetReadText(stagedChangeSet.id, item.path);
        if (!["create", "modify"].includes(textOperation.kind)) {
          throw new Error(copy.pendingReviewLocalDraftBlock);
        }
        const reviewedContent = item.decision === "accept"
          ? textOperation.incomingContent ?? ""
          : item.decision === "reject"
            ? textOperation.baseContent ?? ""
            : textOperation.resolvedContent ?? snapshot.loaded.content;
        const merged = await threeWayExternalProposalReliable(
          snapshot.loaded.content,
          snapshot.draft,
          reviewedContent,
          path,
          0,
        );
        const staged = await typesetChangeSetStageText({
          id: stagedChangeSet.id,
          operationId: textOperation.operationId,
          path: textOperation.path,
          content: merged.content,
          hunkDecisions: merged.diff.changes.map(() => "accept" as const),
          hunkIds: merged.diff.changes.map((change) => change.id),
        });
        stagedChangeSet = withBlanketAnswers(staged, textOperation.operationId, stagedChangeSet);
      }

      // `resolve` treats a pending decision as an answer still owed, not an
      // error: it stores the partial progress and quietly returns the change
      // set unwritten. Catch that here — resolving anyway would silently
      // re-stage the same unresolved bytes on every click.
      if (stagedChangeSet.decisions.some((item) => item.decision === "pending")) {
        throw new Error(copy.pendingReviewIncomplete);
      }
      let resolved = await typesetChangeSetResolve(stagedChangeSet.id, stagedChangeSet.decisions);
      if (resolved.status === "pending" && resolved.decisions.every((item) => item.decision !== "pending")) {
        // The project moved under this write, so the backend rebased instead of
        // writing — but the rebase kept every answer we just gave, meaning the
        // drift was absorbed rather than reopening any of them. Retry once with
        // the rebased decisions instead of leaving the click looking dead.
        resolved = await typesetChangeSetResolve(resolved.id, resolved.decisions);
      }
      if (resolved.status === "pending") {
        upsertPendingChangeSet(resolved);
        setError(copy.pendingReviewChangedAgain);
      } else {
        await refreshAfterChangeSetResolution(resolved);
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setExternalReviewBusy(null);
    }
  }, [
    copy,
    externalReviewBusy,
    pendingChangeSet,
    refreshAfterChangeSetResolution,
    upsertPendingChangeSet,
  ]);

  const resolvePreviewedChangeSetOperation = useCallback(async (decision: "accept" | "reject") => {
    const changeSet = pendingChangeSetsRef.current[0];
    const preview = changeSetOperationPreview;
    if (!changeSet || !preview || externalReviewBusy) return;
    const nextDecisions = changeSet.decisions.map((item) => (
      item.operationId === preview.operationId
        ? { ...item, decision, resolvedHash: null, resolvedBytes: null, hunkDecisions: [], hunkIds: [] }
        : item
    ));
    setExternalReviewBusy(decision);
    setError(null);
    try {
      const resolved = await typesetChangeSetResolve(changeSet.id, nextDecisions);
      setChangeSetOperationPreview(null);
      if (resolved.status === "pending") upsertPendingChangeSet(resolved);
      else await refreshAfterChangeSetResolution(resolved);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setExternalReviewBusy(null);
    }
  }, [changeSetOperationPreview, externalReviewBusy, refreshAfterChangeSetResolution, upsertPendingChangeSet]);

  const prepareCitationKeys = useCallback(async (ids: string[]) => {
    const keysById = await ensureCitationKeys(ids);
    return ids.map((id) => keysById[id]).filter((key): key is string => Boolean(key));
  }, [ensureCitationKeys]);

  const synchronizeBibliography = useCallback(async (
    expectedSourcePath = sourcePathRef.current,
    expectedDraft = draftRef.current,
  ) => {
    const activeSourcePath = expectedSourcePath;
    if (!activeSourcePath) throw new Error(copy.openSourceBeforeCitation);
    // The export and file operations below are asynchronous. Capture both
    // identities at the call site so a delayed sync cannot modify a newly
    // opened document.
    const remainsCurrent = () => (
      sourcePathRef.current === activeSourcePath && draftRef.current === expectedDraft
    );
    const bibliography = await literatureExportBibliography<{ content: string }>({ format: "bibtex" });
    if (!remainsCurrent()) return;
    const bibliographyPath = bibliographyPathForSource(activeSourcePath);
    const managedContent = `${SOMNIQ_BIBLIOGRAPHY_HEADER}${bibliography.content}`;
    let existing: FileText | null = null;
    try {
      existing = await fileReadText(bibliographyPath);
    } catch {
      // A missing generated bibliography is created below. Other read failures
      // are caught by the subsequent write/create operation.
    }
    if (!remainsCurrent()) return;
    if (existing && !existing.content.startsWith(SOMNIQ_BIBLIOGRAPHY_HEADER)) {
      throw new Error(copy.bibAlreadyExists(SOMNIQ_BIBLIOGRAPHY_FILE));
    }
    if (existing) {
      await fileWriteText(bibliographyPath, managedContent);
    } else {
      try {
        await fileCreateText(bibliographyPath, managedContent);
      } catch (createError) {
        // Another writer may have created the file after the read above. Never
        // overwrite an unmanaged bibliography in that race; only refresh the
        // managed file we own.
        let racedFile: FileText;
        try {
          racedFile = await fileReadText(bibliographyPath);
        } catch {
          throw createError;
        }
        if (!remainsCurrent()) return;
        if (!racedFile.content.startsWith(SOMNIQ_BIBLIOGRAPHY_HEADER)) {
          throw new Error(copy.bibAlreadyExists(SOMNIQ_BIBLIOGRAPHY_FILE));
        }
        await fileWriteText(bibliographyPath, managedContent);
      }
    }
    if (!remainsCurrent()) return;
    const sourceWithBibliography = withSomniqBibliography(expectedDraft);
    if (sourceWithBibliography !== expectedDraft) changeDraft(sourceWithBibliography);
    setTreeRefreshKey((value) => value + 1);
  }, [changeDraft]);

  const citationLibraryFingerprint = useMemo(
    () => literaturePapers
      .map((paper) => [
        paper.id,
        paper.citationKey,
        paper.title,
        paper.authors.join("\u0001"),
        paper.year,
        paper.venue,
        paper.doi,
        paper.isbn,
        paper.url,
        paper.abstract,
        paper.tags.join("\u0001"),
      ].join("\u0002"))
      .sort()
      .join("\u0003"),
    [literaturePapers],
  );
  const sourceUsesManagedBibliography = sourceUsesSomniqBibliography(draft);

  useEffect(() => {
    if (!sourcePath || !sourceUsesManagedBibliography) return;
    let active = true;
    const expectedSourcePath = sourcePath;
    const expectedDraft = draft;
    const timer = window.setTimeout(() => {
      void synchronizeBibliography(expectedSourcePath, expectedDraft).catch((syncError) => {
        if (active) setError(copy.couldNotSyncBibliography(SOMNIQ_BIBLIOGRAPHY_FILE, String(syncError)));
      });
    }, 150);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [citationLibraryFingerprint, draft, sourcePath, sourceUsesManagedBibliography, synchronizeBibliography]);

  const undoDraft = useCallback(() => {
    const view = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
    if (view) undo(view);
  }, [editorMode]);

  const redoDraft = useCallback(() => {
    const view = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
    if (view) redo(view);
  }, [editorMode]);

  const changeEditorMode = useCallback((nextMode: EditorMode) => {
    if (nextMode === editorMode) return;
    const sourceView = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
    const selection = sourceView?.state.selection.main;
    const line = selection && sourceView
      ? sourceView.state.doc.lineAt(selection.head).number
      : currentSourceLine;
    setCurrentSourceLine(line);
    setEditorMode(nextMode);
    const targetView = nextMode === "code" ? editorRef.current?.view : visualViewRef.current;
    if (!targetView) return;
    const fallback = lineOffsetFor(draft, line);
    const anchor = clampNumber(selection?.anchor ?? fallback, 0, targetView.state.doc.length);
    const head = clampNumber(selection?.head ?? fallback, 0, targetView.state.doc.length);
    targetView.focus();
    targetView.dispatch({ selection: { anchor, head } });
    if (nextMode === "code") {
      scrollCodeEditorToLine(targetView, line);
    } else {
      targetView.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
    }
  }, [currentSourceLine, draft, editorMode]);

  const openSource = useCallback(async (
    path: string,
    initialLine = 1,
    preserveDocument = false,
  ): Promise<boolean> => {
    const currentPath = sourcePathRef.current;
    if (sameWorkspacePath(currentPath, path)) {
      setCurrentSourceLine(initialLine);
      setPendingSourceNavigation({ path, line: initialLine });
      return true;
    }
    // Switching files keeps the one being left open, unsaved edits and all —
    // that is what a tab *is*. The old prompt existed because the editor could
    // only hold one document at a time.
    const currentFile = loadedRef.current;
    if (currentPath && currentFile && draftRef.current !== currentFile.content) {
      // A draft in an inactive tab used to exist only in memory. Flush it before
      // moving it into the tab cache so a quick file switch cannot outrun the
      // typing-pause timer below.
      await persistDraftRef.current();
    }
    const latestPath = sourcePathRef.current;
    const latestFile = loadedRef.current;
    if (latestPath && latestFile) {
      openDraftsRef.current.set(latestPath, { draft: draftRef.current, loaded: latestFile });
      publishOpenDrafts();
    }
    const documentEpoch = ++documentEpochRef.current;
    const currentRoot = documentRootPathRef.current;
    const belongsToCurrentDocument = preserveDocument
      || sameWorkspacePath(path, currentRoot)
      || Object.keys(documentSourcesRef.current).some((source) => sameWorkspacePath(source, path));
    invalidateActiveCompile();
    setLoading(true);
    setSaving(false);
    setError(null);
    try {
      const snapshot = openDraftsRef.current.get(path);
      const [file, contextResolution, recovery, storedProposal] = await Promise.all([
        // A tab's cached draft is only authoritative while it is dirty. A clean
        // inactive tab must be re-read so edits made outside SomniQ are visible
        // as soon as the tab is selected, rather than being discovered later by
        // the next compile.
        fileReadText(path),
        belongsToCurrentDocument
          ? Promise.resolve({ context: null, error: null })
          : latexDocumentContext(path)
              .then((context) => ({ context, error: null }))
              .catch((contextError) => ({ context: null, error: String(contextError) })),
        typesetRecoveryLoad(path).catch(() => null),
        typesetChangeProposalLoad(path).catch(() => null),
      ]);
      if (documentEpochRef.current !== documentEpoch) return false;
      const snapshotChangedExternally = Boolean(snapshot && !sameFileSnapshot(snapshot.loaded, file));
      // A tab switch is not consent to external edits. Keep the last editor
      // snapshot — clean or dirty — visible and stage the new disk version in
      // the same review UI used by the live watcher.
      const preserveSnapshotForReview = Boolean(snapshot && snapshotChangedExternally);
      const proposalMatchesDisk = Boolean(
        !snapshot
        && storedProposal
        && (
          storedProposal.incomingVersion === file.version
          || storedProposal.incomingContent === file.content
        ),
      );
      const recoveryIsDirty = Boolean(recovery && recovery.content !== file.content);
      const recoveryConflicts = Boolean(
        !snapshot
        && recoveryIsDirty
        && recovery?.baseContent
        && recovery.baseVersion
        && recovery.baseVersion !== file.version,
      );
      const recoveredBase: FileText = recoveryConflicts && recovery
        ? {
            path: file.path,
            content: recovery.baseContent,
            bytes: new TextEncoder().encode(recovery.baseContent).byteLength,
            version: recovery.baseVersion ?? undefined,
          }
        : file;
      const proposalBase: FileText = proposalMatchesDisk && storedProposal
        ? {
            path: file.path,
            content: storedProposal.baseContent,
            bytes: new TextEncoder().encode(storedProposal.baseContent).byteLength,
            version: storedProposal.baseVersion ?? undefined,
          }
        : recoveredBase;
      const activeFile = preserveSnapshotForReview && snapshot ? snapshot.loaded : proposalBase;
      const activeDraft = preserveSnapshotForReview && snapshot
        ? snapshot.draft
        : proposalMatchesDisk && storedProposal
          ? storedProposal.localContent
        : recoveryIsDirty && recovery
          ? recovery.content
          : file.content;
      setSourcePath(activeFile.path);
      setLoaded(activeFile);
      // These two refs are otherwise only assigned while rendering, so between
      // this commit and React's next render they still name the *previous*
      // file. Everything that awaits this function resumes inside that window:
      // the change-set drill-in read `sourcePathRef` to confirm the file it
      // asked for is the one now open, saw the old path, and returned without
      // opening the review — a menu entry that did nothing, intermittently,
      // depending on whether a render happened to land first. `resetDraft`
      // already keeps `draftRef` in step for the same reason.
      sourcePathRef.current = activeFile.path;
      loadedRef.current = activeFile;
      resetDraft(activeDraft);
      openDraftsRef.current.delete(file.path);
      setOpenTabs((tabs) => (tabs.includes(file.path) ? tabs : [...tabs, file.path]));
      publishOpenDrafts();
      setDocumentSources((sources) => belongsToCurrentDocument
        ? { ...sources, [activeFile.path]: activeDraft }
        : { [activeFile.path]: activeDraft });
      if (!belongsToCurrentDocument) {
        const rootPath = contextResolution.context?.rootPath ?? file.path;
        const outputPath = contextResolution.context?.outputPath ?? outputPathFor(rootPath);
        setDocumentRootPath(rootPath);
        setPreviewPath(outputPath);
        setLastPdfPreviewPath(outputPath);
        setDocumentGraphTruncated(false);
        setSyncTexOutdated(false);
        if (contextResolution.error) setError(contextResolution.error);
      }
      setVisualPdfCursor(null);
      setCurrentSourceLine(initialLine);
      setPendingSourceNavigation({ path: activeFile.path, line: initialLine });
      if (!belongsToCurrentDocument) {
        setCompileStatus("idle");
        setCompileResult(null);
        setCompileLiveLog(null);
      }
      if (proposalMatchesDisk && storedProposal) {
        const restoredMerge = await threeWayExternalProposalReliable(
          storedProposal.baseContent,
          storedProposal.localContent,
          storedProposal.incomingContent,
          path,
          0,
        );
        const restoredTooLargeToChunk = Boolean(
          storedProposal.tooLargeToChunk || restoredMerge.tooLargeToChunk,
        );
        const restoredHunkIds = restoredMerge.diff.changes.map((change) => change.id);
        const storedHunksStillMatch = storedProposal.hunkIds?.length === restoredHunkIds.length
          && storedProposal.hunkIds.every((id, index) => id === restoredHunkIds[index]);
        const restoredDecisions = restoredTooLargeToChunk
          ? []
          : storedHunksStillMatch
            ? storedProposal.decisions
            : restoredHunkIds.map(() => "pending" as const);
        const restoredWholeFileDecision = restoredTooLargeToChunk
          && (storedProposal.wholeFileDecision === "incoming" || storedProposal.wholeFileDecision === "local")
          ? storedProposal.wholeFileDecision
          : null;
        const restored: PendingExternalChange = {
          path: activeFile.path,
          file,
          id: storedProposal.id,
          baseContent: storedProposal.baseContent,
          baseVersion: storedProposal.baseVersion,
          localContent: storedProposal.localContent,
          reviewContent: restoredMerge.content,
          reviewDiff: restoredMerge.diff,
          decisions: restoredDecisions,
          actor: storedProposal.actor || "external",
          origin: storedProposal.origin || "proposal",
          tooLargeToChunk: restoredTooLargeToChunk,
          wholeFileDecision: restoredWholeFileDecision,
          // Review-time typing only means anything against the hunks it was
          // typed over. When those shifted, the stored text no longer describes
          // an answer to this proposal and restoring it would silently reapply
          // an edit to ranges the reviewer never saw.
          reviewDraft: storedHunksStillMatch || restoredTooLargeToChunk
            ? storedProposal.reviewDraft ?? null
            : null,
        };
        updateExternalChange(restored);
        // An older build could record the incoming content as the local draft,
        // leaving a stored proposal with no hunks. `updateExternalChange` drops
        // it; clear the file too so re-opening the tab cannot resurrect it.
        if (restored.decisions.length === 0 && !restored.tooLargeToChunk) {
          void typesetChangeProposalClear(path).catch(() => undefined);
        }
      } else if (snapshotChangedExternally || recoveryConflicts) {
        const proposal = await pendingExternalChange(activeFile.path, activeFile, activeDraft, file);
        updateExternalChange(proposal);
        if (proposal.decisions.length === 0 && !proposal.tooLargeToChunk) {
          if (storedProposal) void typesetChangeProposalClear(path).catch(() => undefined);
        } else {
          void typesetChangeProposalSave(activeFile.path, proposalRecord(proposal, {
            incomingContent: file.content,
            incomingVersion: file.version ?? null,
          })).catch(() => undefined);
        }
      } else if (storedProposal) {
        void typesetChangeProposalClear(path).catch(() => undefined);
      }
      dirtySinceRef.current = null;
      return true;
    } catch (openError) {
      if (documentEpochRef.current === documentEpoch) setError(String(openError));
      return false;
    } finally {
      if (documentEpochRef.current === documentEpoch) setLoading(false);
    }
  }, [copy.reviewExternalChangeBeforeSave, invalidateActiveCompile, publishOpenDrafts, resetDraft, updateExternalChange]);

  const reviewPendingChangeSetPath = useCallback(async (path: string) => {
    const changeSet = pendingChangeSetsRef.current[0];
    if (!changeSet) return;
    setError(null);
    try {
      const textOperation = await typesetChangeSetReadText(changeSet.id, path);
      if (!["create", "modify"].includes(textOperation.kind)) {
        setChangeSetOperationPreview(textOperation);
        return;
      }
      const activeForPath = sameWorkspacePath(sourcePathRef.current, path);
      const openSnapshot = openDraftsRef.current.get(path);
      const localBeforeOpen = activeForPath ? draftRef.current : openSnapshot?.draft;
      // The content this editor last held for the file, before the write being
      // reviewed arrived. See `baseContent` below.
      const loadedBeforeOpen = activeForPath
        ? loadedRef.current?.content
        : openSnapshot?.loaded.content;
      const opened = await openSource(path);
      if (!opened || !sameWorkspacePath(sourcePathRef.current, path)) return;
      const diskFile = loadedRef.current;
      if (!diskFile) return;
      const changeSetBase = textOperation.baseContent ?? "";
      const incomingContent = textOperation.incomingContent ?? diskFile.content;
      // A live proposal for this file was already built against the editor's own
      // baseline, and carries whatever the reviewer has typed into it. Rebuilding
      // it from the change set here would replace an exact, per-write review with
      // a coarser one and drop those edits. Nothing about the file has moved, so
      // there is nothing to rebuild.
      const live = externalChangeRef.current;
      if (live && sameWorkspacePath(live.path, path) && live.file.content === incomingContent) {
        setChangeSetOperationPreview(null);
        return;
      }
      // Which "before" the hunks are measured against.
      //
      // A change set spans everything since the last *settled* review, so its
      // base can be several unrelated actions old — project-open drift, an
      // earlier agent run, edits made while the app was closed. Diffing that far
      // back does not merely add noise: an edit that removes text introduced
      // inside the span cancels against it and disappears from the review
      // entirely, so the reviewer is never shown — and cannot reject — the very
      // write they opened the file to inspect. The editor's own last-loaded
      // content is the state immediately before this write, which is what the
      // reviewer is being asked about; fall back to the change set's base only
      // for a file no tab has ever loaded, or when the loaded copy already holds
      // the incoming write and would leave nothing to review.
      const baseContent = loadedBeforeOpen !== undefined && loadedBeforeOpen !== incomingContent
        ? loadedBeforeOpen
        : changeSetBase;
      // "Local" means the editor state as it would be had the external change
      // never arrived. That write already landed on disk, so a clean editor is
      // holding the incoming content, not a pre-change draft — passing it as
      // the local side makes the three-way merge compare the change against
      // itself and produce zero hunks. Only a draft that actually diverges
      // from what arrived is a local edit; otherwise the base is the local side.
      const localContent = localBeforeOpen !== undefined && localBeforeOpen !== incomingContent
        ? localBeforeOpen
        : baseContent;
      const baseFile: FileText = {
        path,
        content: baseContent,
        bytes: new TextEncoder().encode(baseContent).byteLength,
      };
      const incomingFile: FileText = {
        ...diskFile,
        content: incomingContent,
        bytes: new TextEncoder().encode(incomingContent).byteLength,
      };
      const proposal = await pendingExternalChange(
        path,
        baseFile,
        localContent,
        incomingFile,
        changeSet.actor,
        changeSet.origin,
      );
      const storedDecision = changeSet.decisions.find((item) => item.operationId === textOperation.operationId);
      const proposalHunkIds = proposal.reviewDiff.changes.map((change) => change.id);
      if (storedDecision?.hunkDecisions?.length === proposal.decisions.length
        && storedDecision.hunkIds?.length === proposalHunkIds.length
        && storedDecision.hunkIds.every((id, index) => id === proposalHunkIds[index])) {
        proposal.decisions = [...storedDecision.hunkDecisions];
      }
      updateExternalChange(proposal);
      setChangeSetOperationPreview(null);
      void typesetChangeProposalSave(path, proposalRecord(proposal, {
        evidence: changeSet.evidence,
      })).catch(() => undefined);
    } catch (reason) {
      const operation = changeSet.decisions.find((item) => sameWorkspacePath(item.path, path));
      if (operation) {
        setChangeSetOperationPreview({
          operationId: operation.operationId,
          kind: operation.operationId.split(":", 1)[0] || "modify",
          path: operation.path,
          previousPath: null,
          baseContent: null,
          incomingContent: null,
          resolvedContent: null,
          baseHash: null,
          incomingHash: null,
        });
      } else {
        setError(String(reason));
      }
    }
  }, [openSource, updateExternalChange]);

  /**
   * Close a tab. An unsaved draft is only discarded on an explicit confirm —
   * closing is the one place a tab can lose work, since switching no longer can.
   */
  const closeTab = useCallback((path: string) => {
    const isActive = sameWorkspacePath(path, sourcePathRef.current);
    const snapshot = openDraftsRef.current.get(path);
    const unsaved = isActive
      ? Boolean(loadedRef.current && draftRef.current !== loadedRef.current.content)
      : Boolean(snapshot && snapshot.draft !== snapshot.loaded.content);
    if (unsaved && !window.confirm(copy.discardUnsavedChangesClose(basename(path)))) return;
    openDraftsRef.current.delete(path);
    publishOpenDrafts();
    setOpenTabs((tabs) => {
      const remaining = tabs.filter((tab) => !sameWorkspacePath(tab, path));
      if (isActive) {
        const index = tabs.findIndex((tab) => sameWorkspacePath(tab, path));
        const next = remaining[Math.min(index, remaining.length - 1)];
        if (next) {
          // The draft of the tab being closed must not follow us into the next
          // one, so drop it before the load reads the snapshot map.
          // A neighboring tab may belong to a different LaTeX project. Let
          // openSource resolve that tab's document root instead of preserving
          // the project that is being closed.
          window.setTimeout(() => void openSource(next), 0);
        } else {
          setSourcePath(null);
          setLoaded(null);
          resetDraft("");
        }
      }
      return remaining;
    });
  }, [copy, openSource, publishOpenDrafts, resetDraft]);

  const openPath = useCallback((path: string) => {
    if (extension(path) === ".tex") {
      void openSource(path);
      return;
    }
    if (extension(path) === ".pdf") {
      forwardSearchEpochRef.current += 1;
      setPreviewPath(path);
      setLastPdfPreviewPath(path);
      setPdfPanelVisible(true);
      setSlideFocusMode(false);
      setRefreshKey((key) => key + 1);
      return;
    }
    if (isTypesetImagePath(path)) {
      forwardSearchEpochRef.current += 1;
      setPreviewPath(path);
      setPdfPanelVisible(true);
      setSlideFocusMode(false);
      setLogOpen(false);
      setRefreshKey((key) => key + 1);
    }
  }, [openSource]);

  const handleFileMutation = useCallback((mutation: TypesetFileMutation) => {
    const pathMatches = (path: string | null, target: string) => Boolean(path && (
      sameWorkspacePath(path, target)
      || (mutation.isDir && normalizePath(path).startsWith(`${normalizePath(target)}/`))
    ));
    if (mutation.type === "delete") {
      for (const path of [...openDraftsRef.current.keys()]) {
        if (pathMatches(path, mutation.path)) openDraftsRef.current.delete(path);
      }
      publishOpenDrafts();
      setOpenTabs((tabs) => tabs.filter((tab) => !pathMatches(tab, mutation.path)));
      setLastPdfPreviewPath((path) => pathMatches(path, mutation.path) ? null : path);
      if (pathMatches(sourcePath, mutation.path) || pathMatches(previewPath, mutation.path)) {
        documentEpochRef.current += 1;
        invalidateActiveCompile();
        setSourcePath(null);
        setPreviewPath(null);
        setLastPdfPreviewPath(null);
        setLoaded(null);
        resetDraft("");
        setDocumentRootPath(null);
        setDocumentSources({});
        setDocumentGraphTruncated(false);
        setSyncTexOutdated(false);
        setCompileStatus("idle");
        setCompileResult(null);
        setCompileLiveLog(null);
        setLogOpen(false);
      }
      setTreeRefreshKey((key) => key + 1);
      return;
    }

    const renamedPath = (path: string | null) => {
      if (!path) return null;
      if (sameWorkspacePath(path, mutation.path)) return mutation.newPath;
      const normalizedPath = normalizePath(path);
      const normalizedTarget = normalizePath(mutation.path);
      if (mutation.isDir && normalizedPath.startsWith(`${normalizedTarget}/`)) {
        return `${mutation.newPath}/${normalizedPath.slice(normalizedTarget.length + 1)}`;
      }
      return path;
    };
    const nextSourcePath = renamedPath(sourcePath);
    const nextDocumentRootPath = renamedPath(documentRootPath);
    if (nextSourcePath !== sourcePath) {
      documentEpochRef.current += 1;
      invalidateActiveCompile();
    }
    setSourcePath(nextSourcePath);
    setDocumentRootPath(nextDocumentRootPath);
    setPreviewPath(renamedPath(previewPath));
    setLastPdfPreviewPath((path) => renamedPath(path));
    setLoaded((file) => file && nextSourcePath ? { ...file, path: nextSourcePath } : file);
    setDocumentSources((sources) => Object.fromEntries(Object.entries(sources).map(([path, content]) => [renamedPath(path) ?? path, content])));
    setTreeRefreshKey((key) => key + 1);
  }, [documentRootPath, invalidateActiveCompile, previewPath, publishOpenDrafts, resetDraft, sourcePath]);

  const createSource = useCallback(async (path: string, template: TypesetTemplate = "article", title = "SomniQ LaTeX Draft") => {
    const documentEpoch = ++documentEpochRef.current;
    invalidateActiveCompile();
    setError(null);
    try {
      const normalized = normalizeNewTypesetPath(path);
      const file = await fileCreateText(normalized, defaultSourceFor(normalized, template, title));
      if (documentEpochRef.current !== documentEpoch) return;
      // Templates always seed their own folder, so that folder is the project
      // the library groups this document under until the next scan.
      const createdProjectPath = dirname(file.path);
      setStartDocuments((documents) => [
        {
          path: file.path,
          projectPath: createdProjectPath,
          title,
          kind: template,
          modifiedEpochMs: Date.now(),
          compileState: "missing",
        },
        ...documents.filter((document) => document.path !== file.path),
      ]);
      setStartProjects((projects) => (
        projects.some((project) => project.path === createdProjectPath)
          ? projects
          : [
            {
              path: createdProjectPath,
              name: basename(createdProjectPath),
              texFileCount: 1,
              modifiedEpochMs: Date.now(),
            },
            ...projects,
          ]
      ));
      setTreeRefreshKey((key) => key + 1);
      setSourcePath(file.path);
      setDocumentRootPath(file.path);
      setDocumentSources({ [file.path]: file.content });
      setDocumentGraphTruncated(false);
      setSyncTexOutdated(false);
      const outputPath = outputPathFor(file.path);
      setPreviewPath(outputPath);
      setLastPdfPreviewPath(outputPath);
      setLoaded(file);
      resetDraft(file.content);
      setVisualPdfCursor(null);
      setCurrentSourceLine(1);
      setCompileStatus("idle");
      setCompileResult(null);
      setCompileLiveLog(null);
    } catch (createError) {
      if (documentEpochRef.current === documentEpoch) setError(String(createError));
    }
  }, [invalidateActiveCompile, resetDraft]);

  const scanProject = useCallback(async () => {
    const documentEpoch = ++documentEpochRef.current;
    invalidateActiveCompile();
    setLoading(true);
    setSaving(false);
    setError(null);
    setLoaded(null);
    resetDraft("");
    setSourcePath(null);
    setDocumentRootPath(null);
    setDocumentSources({});
    setDocumentGraphTruncated(false);
    setSyncTexOutdated(false);
    setPreviewPath(null);
    setLastPdfPreviewPath(null);
    setCompileStatus("idle");
    setCompileResult(null);
    setCompileLiveLog(null);
    setLogOpen(false);
    setVisualPdfCursor(null);
    setCurrentSourceLine(1);
    try {
      const library = await typesetListDocuments();
      if (documentEpochRef.current !== documentEpoch) return;
      const documents = library.documents;
      const sortedMatches = sortedSources(documents.map((document) => document.path));
      setStartDocuments(documents);
      setStartProjects(library.projects);
      setTreeRefreshKey((key) => key + 1);
      if (isTypesetPreviewMode() && !previewAutoOpenedRef.current) {
        previewAutoOpenedRef.current = true;
        const previewSource = preferredSource(sortedMatches);
        if (previewSource) {
          const file = await fileReadText(previewSource);
          if (documentEpochRef.current !== documentEpoch) return;
          setSourcePath(file.path);
          setDocumentRootPath(file.path);
          setDocumentSources({ [file.path]: file.content });
          const outputPath = outputPathFor(file.path);
          setPreviewPath(outputPath);
          setLastPdfPreviewPath(outputPath);
          setLoaded(file);
          resetDraft(file.content);
          setVisualPdfCursor(null);
          setCurrentSourceLine(1);
          setSyncTexOutdated(false);
        }
      }
    } catch (scanError) {
      if (documentEpochRef.current === documentEpoch) {
        setStartDocuments([]);
        setStartProjects([]);
        setError(String(scanError));
      }
    } finally {
      if (documentEpochRef.current === documentEpoch) setLoading(false);
    }
  }, [invalidateActiveCompile, resetDraft]);

  useEffect(() => {
    void scanProject();
  }, [currentProject?.id, scanProject]);

  // Chat can request a TeX source or a standalone PDF before this lazy-loaded
  // workspace mounts. Consume that request once the project scan has started;
  // PDFs keep the source empty and render directly in the right-hand preview.
  useEffect(() => {
    if (!pendingTypesetFilePath) return;
    openPath(pendingTypesetFilePath);
    setPendingTypesetFilePath(null);
  }, [openPath, pendingTypesetFilePath, setPendingTypesetFilePath]);

  useEffect(() => {
    const liveView = editorModeRef.current === "code" ? editorRef.current?.view : visualViewRef.current;
    const lineCount = liveView?.state.doc.lines ?? 1;
    setCurrentSourceLine((line) => clampNumber(line, 1, lineCount));
  }, [draft]);

  const performSave = useCallback(async (): Promise<FileText | null> => {
    const savePath = sourcePathRef.current;
    const baseFile = loadedRef.current;
    if (!savePath || !baseFile) return null;
    if (awaitingReviewAnswer(savePath)) {
      // Only a file still waiting for its own review answer holds its write
      // back: its revision has to stay stable, and `resolveProjectChangeSet`
      // stages this recovery draft into the same atomic transaction. Every
      // other file saves normally — a pending review elsewhere in the project
      // used to strand unrelated edits in the recovery journal indefinitely.
      const pendingDraft = draftRef.current;
      if (pendingDraft !== baseFile.content) {
        await typesetRecoverySave(
          savePath,
          pendingDraft,
          baseFile.content,
          baseFile.version,
        ).catch(() => undefined);
      }
      return null;
    }
    if (externalChangeRef.current?.path === savePath) {
      setError(null);
      return null;
    }
    const documentEpoch = documentEpochRef.current;
    const latestDraft = draftRef.current;
    setSaving(true);
    setError(null);
    try {
      if (latestDraft === baseFile.content) {
        // Legacy/browser fixtures without a version cannot be validated. The
        // desktop backend always supplies a SHA-256 version.
        if (!baseFile.version) return baseFile;
        const diskFile = await fileReadText(savePath);
        if (documentEpochRef.current !== documentEpoch || sourcePathRef.current !== savePath) return diskFile;
        if (diskFile.version === baseFile.version && diskFile.content === baseFile.content) return baseFile;
        if (draftRef.current === baseFile.content) {
          await presentExternalChange(diskFile);
          setError(null);
          return null;
        }
      }

      const contentToWrite = draftRef.current;
      const file = baseFile.version
        ? await fileWriteText(savePath, contentToWrite, baseFile.version)
        : await fileWriteText(savePath, contentToWrite);
      if (documentEpochRef.current !== documentEpoch || sourcePathRef.current !== savePath) return file;
      loadedRef.current = file;
      setLoaded(file);
      if (draftRef.current === contentToWrite) resetDraft(file.content);
      setSourcePath(file.path);
      dirtySinceRef.current = null;
      void typesetRecoveryClear(savePath).catch(() => undefined);
      return file;
    } catch (saveError) {
      if (documentEpochRef.current === documentEpoch && sourcePathRef.current === savePath) {
        if (String(saveError).includes("FILE_CONFLICT")) {
          try {
            const diskFile = await fileReadText(savePath);
            if (documentEpochRef.current === documentEpoch && sourcePathRef.current === savePath) {
              await presentExternalChange(diskFile);
              setError(null);
            }
          } catch {
            setError(copy.fileSaveConflict(basename(savePath)));
          }
        } else setError(String(saveError));
      }
      return null;
    } finally {
      if (documentEpochRef.current === documentEpoch) setSaving(false);
    }
  }, [awaitingReviewAnswer, copy, presentExternalChange, resetDraft]);

  const save = useCallback(async function saveLatest(): Promise<FileText | null> {
    const pending = saveInFlightRef.current;
    if (pending) {
      await pending;
      const currentFile = loadedRef.current;
      if (currentFile && sourcePathRef.current && draftRef.current !== currentFile.content) {
        return saveLatest();
      }
      return currentFile;
    }
    const task = performSave();
    saveInFlightRef.current = task;
    try {
      return await task;
    } finally {
      if (saveInFlightRef.current === task) saveInFlightRef.current = null;
    }
  }, [performSave]);
  persistDraftRef.current = save;

  // Save source after the user pauses typing. Unlike Ctrl/Cmd+S, this does not
  // compile: autosave is for recovery, while PDF refresh remains intentional.
  useEffect(() => {
    if (!sourcePath || !loaded || draft === loaded.content || externalChange?.path === sourcePath) return undefined;
    const timer = window.setTimeout(() => {
      void save();
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, externalChange?.path, loaded, save, sourcePath]);

  // A small crash-recovery journal is independent from the user's 45-second
  // source-file preference. It never compiles or changes the paper itself.
  useEffect(() => {
    if (!sourcePath || !loaded || draft === loaded.content) return undefined;
    const timer = window.setTimeout(() => {
      void typesetRecoverySave(sourcePath, draft, loaded.content, loaded.version).catch(() => undefined);
    }, RECOVERY_DRAFT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, loaded, sourcePath]);

  useEffect(() => {
    if (!loaded || draft === loaded.content) {
      dirtySinceRef.current = null;
    } else if (dirtySinceRef.current == null) {
      dirtySinceRef.current = Date.now();
    }
  }, [draft, loaded]);

  // A debounce alone can postpone saving forever while someone types
  // continuously. Preserve the 45-second pause behavior, but bound the maximum
  // time a dirty source stays only in the recovery journal.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const activeFile = loadedRef.current;
      if (
        activeFile
        && draftRef.current !== activeFile.content
        && !externalChangeRef.current
        && dirtySinceRef.current != null
        && Date.now() - dirtySinceRef.current >= AUTOSAVE_MAX_WAIT_MS
      ) {
        void save();
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [save]);

  // When the app is backgrounded, do not leave a just-typed draft waiting for
  // the debounce interval. The optimistic version check in `save` still
  // protects an external writer.
  useEffect(() => {
    const saveWhenHidden = () => {
      const activeFile = loadedRef.current;
      if (
        document.visibilityState === "hidden"
        && activeFile
        && draftRef.current !== activeFile.content
        && externalChangeRef.current?.path !== sourcePathRef.current
      ) {
        void save();
      }
    };
    document.addEventListener("visibilitychange", saveWhenHidden);
    return () => document.removeEventListener("visibilitychange", saveWhenHidden);
  }, [save]);

  // Compiling is deliberately not gated on a pending review. Build output is
  // outside the revision system now, so a compile can neither drift a review
  // nor add operations to it — and refusing to render the very change under
  // review was the gate's whole cost.
  const compile = async (cleanCache = false) => {
    if (!sourcePath || saving || activeCompileRunIdRef.current) return;
    const openPath = sourcePath;
    const runId = `typeset-${Date.now()}-${++compileSequenceRef.current}`;
    const compileEpoch = ++compileEpochRef.current;
    if (compileProgressTimerRef.current !== null) window.clearTimeout(compileProgressTimerRef.current);
    compileProgressTimerRef.current = null;
    pendingCompileProgressRef.current = null;
    activeCompileRunIdRef.current = runId;
    const ownsCompile = () => (
      compileEpochRef.current === compileEpoch
      && activeCompileRunIdRef.current === runId
      && sourcePathRef.current === openPath
    );
    const flushCompileProgress = () => {
      if (compileProgressTimerRef.current !== null) {
        window.clearTimeout(compileProgressTimerRef.current);
        compileProgressTimerRef.current = null;
      }
      const progress = pendingCompileProgressRef.current;
      pendingCompileProgressRef.current = null;
      if (progress?.runId === runId && ownsCompile()) {
        setCompileLiveLog({ stdout: progress.stdout, stderr: progress.stderr, elapsedMs: progress.elapsedMs });
      }
    };
    const queueCompileProgress = (progress: CompileLiveLog & { runId: string }) => {
      pendingCompileProgressRef.current = progress;
      if (compileProgressTimerRef.current === null) {
        compileProgressTimerRef.current = window.setTimeout(flushCompileProgress, COMPILE_PROGRESS_UPDATE_MS);
      }
    };
    setCompileStatus("running");
    setSyncTexOutdated(true);
    setActiveCompileRunId(runId);
    setCompileResult(null);
    setCompileLiveLog({ stdout: "", stderr: "", elapsedMs: 0 });
    setError(null);
    setReviewCompileNotice(null);
    // Don't jump to the log while compiling — the PDF toolbar already shows a
    // "Compiling" status. The log only opens itself when a build actually fails
    // (below); a user watching it can still open it manually.
    await nextAnimationFrame();
    if (!ownsCompile()) return;
    const saved = await save();
    if (!ownsCompile()) return;
    // `save()` returns null on purpose for a file held back by its own review
    // — there is nothing to flush, since the write it is reviewing already
    // landed on disk. That is not a save failure: the build can still proceed
    // against the incoming version, it just is not what the reviewer is
    // looking at on screen.
    const heldForReview = !saved && externalChangeRef.current?.path === openPath;
    if (!saved && !heldForReview) {
      setCompileStatus("idle");
      setCompileLiveLog(null);
      activeCompileRunIdRef.current = null;
      setActiveCompileRunId(null);
      return;
    }
    const effectiveSaved = saved ?? externalChangeRef.current!.file;
    setReviewCompileNotice(heldForReview ? copy.reviewCompileShowsDisk(basename(effectiveSaved.path || openPath)) : null);
    // A chosen main document wins over whatever file happens to be open: in a
    // thesis every chapter is a fragment, and TeX has to be pointed at the root.
    // Detection (`% !TeX root`, `\input` scanning) still covers projects that
    // never set one.
    const openedPath = effectiveSaved.path || openPath;
    const compilePath = mainDocumentPath?.trim() ? mainDocumentPath : openedPath;
    // Freeze what TeX is about to read. `save()` has just flushed the open file,
    // and the rest of the graph is whatever was last loaded from disk — the same
    // bytes the compiler will see, and the baseline every later SyncTeX result
    // is numbered against. Only committed once the run actually yields a PDF:
    // after a failed build the PDF (and its SyncTeX data) still describe the
    // previous snapshot, so replacing it here would remap against the wrong file.
    const compiledSnapshot = { ...documentSourcesRef.current, [openedPath]: effectiveSaved.content };
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onLatexCompileProgress((progress) => {
        if (progress.runId === runId && ownsCompile()) {
          queueCompileProgress({ runId, stdout: progress.stdout, stderr: progress.stderr, elapsedMs: progress.elapsedMs });
        }
      });
      if (!ownsCompile()) return;
      const outputPath = outputPathFor(compilePath);
      const result = await latexCompile(
        compilePath,
        outputPath,
        cleanCache,
        runId,
        compileErrorHandling === "continue",
        latexEngine === "auto" ? null : latexEngine,
      );
      if (!ownsCompile()) return;
      setCompileResult(result);
      setDocumentRootPath(result.inputPath || compilePath);
      const interrupted = result.interrupted;
      setCompileStatus(interrupted ? "idle" : result.success ? "success" : result.partialOutput ? "partial" : "error");
      // Reveal the log only when the build reported problems; a clean success
      // returns focus to the freshly rendered PDF.
      setLogOpen(!interrupted && !result.success);
      const pdfState = result.pdfState ?? (result.success ? "fresh" : result.partialOutput ? "partial" : "missing");
      setSyncTexOutdated(!(result.success && pdfState === "fresh"));
      // "stale" means the project changed under the compiler, so the SyncTeX
      // data does not describe this snapshot either.
      if (pdfState === "fresh" || pdfState === "partial") compiledSourcesRef.current = compiledSnapshot;
      if (pdfState === "fresh" || pdfState === "partial" || pdfState === "stale") {
        setPreviewPath(result.outputPath || outputPath);
        setLastPdfPreviewPath(result.outputPath || outputPath);
        setRefreshKey((key) => key + 1);
      }
      setTreeRefreshKey((key) => key + 1);
    } catch (compileError) {
      if (ownsCompile()) {
        setCompileStatus("error");
        setError(String(compileError));
        setLogOpen(true);
      }
    } finally {
      flushCompileProgress();
      unlisten?.();
      if (ownsCompile()) {
        activeCompileRunIdRef.current = null;
        setActiveCompileRunId(null);
      }
    }
  };

  const cancelCompile = useCallback(() => {
    const runId = activeCompileRunIdRef.current;
    if (!runId) return;
    void latexCompileCancel(runId).catch((cancelError) => {
      setError(String(cancelError));
    });
  }, []);
  compileRef.current = () => {
    void compile();
  };

  /**
   * Write, then rebuild. Compiling *through* the save rather than instead of it
   * keeps `save()`'s serialisation — a second Ctrl+S while the first write is
   * still in flight still queues the newer draft — and the compile's own
   * `save()` is a no-op by the time it runs.
   */
  const saveThenCompile = useCallback(async () => {
    const saved = await save();
    if (saved && compileOnSaveRef.current) compileRef.current();
  }, [save]);

  /**
   * A file under review is held back from disk on purpose: its revision has to
   * stay stable until the transaction resolves. Save there has nothing to
   * write, but the rebuild gesture still means something — it is the one way
   * to see the incoming version compiled — so both Ctrl+S and the toolbar's
   * Save trigger it instead of silently doing nothing.
   */
  const handleHeldForReviewSave = useCallback((path: string) => {
    if (activeCompileRunIdRef.current) {
      // Nothing to ride along with; say directly what a rebuild would have said.
      setReviewCompileNotice(copy.reviewCompileShowsDisk(basename(path)));
      return;
    }
    compileRef.current();
  }, [copy]);

  const saveCurrentEditor = useCallback(() => {
    const reviewing = externalChangeRef.current;
    if (reviewing && sameWorkspacePath(reviewing.path, sourcePathRef.current)) {
      handleHeldForReviewSave(reviewing.path);
      return;
    }
    if (!loaded || draftRef.current === loaded.content) return;
    if (activeCompileRunIdRef.current) {
      setError(copy.compileStillReading);
      return;
    }
    // The explicit Save action in the compiled Beamer canvas refreshes its PDF
    // preview.
    if (editorMode === "visual" && beamerSlides.length > 0) {
      if (saving) return;
      compileRef.current();
      return;
    }
    void saveThenCompile();
  }, [beamerSlides.length, editorMode, handleHeldForReviewSave, loaded, saveThenCompile, saving]);

  /**
   * Ctrl+S. Compiling here — rather than a few seconds after every keystroke,
   * the way Overleaf does against its own build farm — keeps the PDF from
   * reflowing under the reader while they type, and still means the preview is
   * never stale after a deliberate save.
   */
  const saveShortcut = useCallback(() => {
    const reviewing = externalChangeRef.current;
    if (reviewing && sameWorkspacePath(reviewing.path, sourcePathRef.current)) {
      handleHeldForReviewSave(reviewing.path);
      return;
    }
    if (!loaded || draftRef.current === loaded.content) return;
    if (activeCompileRunIdRef.current) {
      setError(copy.compileStillReading);
      return;
    }
    void saveThenCompile();
  }, [handleHeldForReviewSave, loaded, saveThenCompile]);

  // CodeEditor captures `extraKeymap` once at mount, so route through refs kept
  // fresh every render rather than closing over these (non-memoized, in `compile`'s
  // case) callbacks directly.
  const saveRef = useRef(saveShortcut);
  saveRef.current = saveShortcut;
  compileOnSaveRef.current = compileOnSave;
  const codeEditorKeymapRef = useRef<KeyBinding[]>([
    { key: "Mod-s", run: () => { void saveRef.current(); return true; } },
    // `compileRef` (defined above, near `compile`) is already a stable wrapper.
    { key: "Mod-Enter", run: () => { compileRef.current(); return true; } },
  ]);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      const shortcut = event.ctrlKey || event.metaKey;
      if (!shortcut || event.key.toLowerCase() !== "s") return;
      if (!sourcePath || !loaded) return;
      event.preventDefault();
      saveShortcut();
    };
    window.addEventListener("keydown", handleSaveShortcut, { capture: true });
    return () => window.removeEventListener("keydown", handleSaveShortcut, { capture: true });
  }, [loaded, saveShortcut, sourcePath]);

  const openCodeAtLine = useCallback((line: number) => {
    const offset = lineOffsetFor(draftRef.current, line);
    setCurrentSourceLine(line);
    setEditorMode("code");
    window.setTimeout(() => {
      const editor = editorRef.current;
      editor?.focus();
      editor?.dispatch({ selection: { anchor: offset, head: offset } });
      if (editor) scrollCodeEditorToLine(editor.view, line);
      setCurrentSourceLine(line);
      window.requestAnimationFrame(() => setCurrentSourceLine(line));
    }, 0);
  }, []);

  const navigateToLine = useCallback((line: number, column = 0) => {
    const offset = lineOffsetFor(draftRef.current, line) + Math.max(0, column);
    setCurrentSourceLine(line);
    window.setTimeout(() => {
      const view = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
      if (!view) return;
      const safeOffset = clampNumber(offset, 0, view.state.doc.length);
      view.focus();
      view.dispatch({
        selection: { anchor: safeOffset, head: safeOffset },
        effects: EditorView.scrollIntoView(safeOffset, { y: "center" }),
      });
      if (editorMode === "code") scrollCodeEditorToLine(view, line);
    }, 0);
  }, [editorMode]);

  const openDiagnostic = useCallback((diagnostic: LatexDiagnostic) => {
    const line = diagnostic.line ?? 1;
    const reportedPath = diagnostic.filePath?.trim();
    if (!reportedPath || !sourcePath) {
      navigateToLine(line);
      return;
    }
    const compileRootPath = compileResult?.inputPath || sourcePath;
    const normalizedReportedPath = normalizePath(reportedPath).replace(/^\.\//, "");
    const normalizedSourcePath = normalizePath(sourcePath);
    if (normalizedReportedPath === normalizedSourcePath) {
      navigateToLine(line);
      return;
    }
    const targetPath = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(reportedPath)
      ? reportedPath
      : `${dirname(compileRootPath)}/${normalizedReportedPath}`.replace(/\\/g, "/");
    if (normalizePath(targetPath) === normalizedSourcePath) {
      navigateToLine(line);
      return;
    }
    void openSource(targetPath, line, true);
  }, [compileResult?.inputPath, navigateToLine, openSource, sourcePath]);

  const openCodeRange = useCallback((start: number, end: number) => {
    const source = draftRef.current;
    const safeStart = clampNumber(start, 0, source.length);
    const safeEnd = clampNumber(end, safeStart, source.length);
    const line = lineNumberForOffset(source, safeStart);
    setCurrentSourceLine(line);
    setEditorMode("code");
    window.requestAnimationFrame(() => {
      const editor = editorRef.current;
      if (!editor) return;
      const editorStart = clampNumber(safeStart, 0, editor.view.state.doc.length);
      const editorEnd = clampNumber(safeEnd, editorStart, editor.view.state.doc.length);
      editor.focus();
      editor.dispatch({
        selection: { anchor: editorStart, head: editorEnd },
        effects: EditorView.scrollIntoView(editorStart, { y: "center" }),
      });
      window.requestAnimationFrame(() => scrollCodeEditorToLine(editor.view, line));
      setCurrentSourceLine(line);
      window.requestAnimationFrame(() => setCurrentSourceLine(line));
    });
  }, []);

  const openComments = useCallback(() => {
    const selection = editorMode === "visual"
      ? visualViewRef.current?.state.selection.main
      : editorRef.current?.getSelection().main;
    setCommentSelection(selection
      ? { from: selection.from, to: selection.to }
      : { from: 0, to: 0 });
    setCommentsOpen(true);
  }, [editorMode]);

  useEffect(() => {
    if (!pendingSourceNavigation || loading || !sameWorkspacePath(pendingSourceNavigation.path, sourcePath)) return;
    const navigation = pendingSourceNavigation;
    setPendingSourceNavigation(null);
    // A SyncTeX hit arrives numbered against the source that was compiled, and
    // with no column at all. Both are resolved here rather than at the call
    // site, because this is the first point at which `draft` is guaranteed to
    // be the target file — a hit in an \input'd chapter has to wait for that
    // file to load before its line numbers mean anything.
    const compiled = navigation.fromSyncTex
      ? compiledSourceFor(compiledSourcesRef.current, navigation.path)
      : undefined;
    const remapped = compiled !== undefined && compiled !== draft;
    const line = remapped ? remapCompiledLine(compiled, draft, navigation.line) : navigation.line;
    const lineStart = lineOffsetFor(draft, line);
    const lineBreak = draft.indexOf("\n", lineStart);
    const lineText = draft.slice(lineStart, lineBreak < 0 ? draft.length : lineBreak);
    const refined = navigation.word
      ? refineSourceColumn(lineText, navigation.word, wordRatioIn(navigation.pdfText ?? "", navigation.word))
      : null;
    if (navigation.fromSyncTex) setForwardSearchNotice(remapped ? copy.syncTexRemappedAfterEdit : null);

    const column = refined?.column ?? navigation.column;
    const start = navigation.start ?? lineStart + Math.max(0, column ?? 0);
    const end = navigation.end ?? (refined ? start + refined.length : start);
    const hasExactOffset = navigation.start != null || column != null;
    const cursor = {
      line,
      start: clampNumber(start, 0, draft.length),
      end: clampNumber(end, clampNumber(start, 0, draft.length), draft.length),
      text: draft.slice(start, end),
    };
    setVisualPdfCursor(cursor);
    if (navigation.forceCode || editorModeRef.current === "code") {
      if (end > start || hasExactOffset) openCodeRange(start, end);
      else openCodeAtLine(line);
    } else {
      navigateToLine(line, column ?? 0);
    }
  }, [draft, loading, navigateToLine, openCodeAtLine, openCodeRange, pendingSourceNavigation, sourcePath]);

  const navigateToPdfTextFallback = useCallback((text: string, context = text, forceCode = false): boolean => {
    // Guessing from text needs enough text to identify a place. A CJK PDF gives
    // one text item per glyph — each font subset holds a handful of characters —
    // so an unguarded search for a single character lands on its first
    // occurrence in the file, which is worse than not moving at all.
    if (!pdfTextCarriesEnoughSignal(text)) return false;
    const currentSource = editorModeRef.current === "code"
      ? editorRef.current?.view.state.doc.toString() || draftRef.current
      : draftRef.current;
    const candidates: Array<[string, string]> = sourcePathRef.current
      ? [[sourcePathRef.current, currentSource]]
      : [];
    for (const [path, source] of Object.entries(documentSourcesRef.current)) {
      if (!candidates.some(([candidate]) => sameWorkspacePath(candidate, path))) candidates.push([path, source]);
    }
    const located = candidates
      .map(([path, source]) => ({ path, source, match: findLatexOffsetForPdfText(source, text, context) }))
      .find((candidate) => candidate.match != null);
    if (!located?.match) return false;
    const { path, source, match } = located;
    const cursor = {
      line: lineNumberForOffset(source, match.start),
      start: match.start,
      end: match.end,
      text: normalizePdfText(text),
    };
    setVisualPdfCursor(cursor);
    setCurrentSourceLine(cursor.line);
    if (!sameWorkspacePath(path, sourcePathRef.current)) {
      void openSource(path, cursor.line, true).then((opened) => {
        if (opened) setPendingSourceNavigation({ path, line: cursor.line, start: match.start, end: match.end, forceCode });
      });
      return true;
    }
    if (editorModeRef.current === "visual" && !forceCode) {
      setEditorMode("visual");
      navigateToLine(cursor.line);
      return true;
    }
    openCodeRange(match.start, match.end);
    return true;
  }, [navigateToLine, openCodeRange, openSource]);

  const openSourceForPdfText = useCallback((text: string, context = text, forceCode = false) => {
    navigateToPdfTextFallback(text, context, forceCode);
  }, [navigateToPdfTextFallback]);

  // Forward search: double-click in Code or Visual jumps the PDF preview to
  // the exact compiled position, via the real SyncTeX data latexmk/xelatex
  // now emit (-synctex=1). Reports back through `forwardSearchNotice` instead
  // of failing silently — a stale (pre-synctex) PDF, a missing `synctex`
  // binary, or a line with no typeset material (blank lines, comments) are
  // all real, visible-to-the-user reasons the jump didn't happen.
  const jumpToPdfForSource = useCallback((targetSourcePath: string | null, line: number, column: number) => {
    if (!targetSourcePath || !previewPath || extension(previewPath) !== ".pdf") {
      setForwardSearchNotice(copy.compileBeforeJumping);
      return;
    }
    // The mirror of inverse search: here the *line* is current and the PDF is
    // old, so the line has to be translated back into the numbering the build
    // recorded before asking SyncTeX about it. Without a snapshot to translate
    // through there is nothing to correct with, so keep the old refusal rather
    // than jumping somewhere plausible-looking and wrong.
    const currentSource = sameWorkspacePath(targetSourcePath, sourcePathRef.current)
      ? draftRef.current
      : compiledSourceFor(documentSourcesRef.current, targetSourcePath);
    const compiled = compiledSourceFor(compiledSourcesRef.current, targetSourcePath);
    if (syncTexMappingStale && (compiled === undefined || currentSource === undefined)) {
      setForwardSearchNotice(copy.syncTexNeedsRecompile);
      return;
    }
    const remapped = compiled !== undefined && currentSource !== undefined && compiled !== currentSource;
    const compiledLine = remapped ? remapCompiledLine(currentSource, compiled, line) : line;
    const requestEpoch = ++forwardSearchEpochRef.current;
    void latexForwardSearch(targetSourcePath, previewPath, compiledLine, column)
      .then((result) => {
        if (requestEpoch !== forwardSearchEpochRef.current) return;
        const location = result.locations[0];
        if (location) {
          setPdfForwardTarget({ location, nonce: Date.now() });
          setForwardSearchNotice(remapped ? copy.syncTexRemappedAfterEdit : null);
        } else {
          setForwardSearchNotice(result.stderr.trim() || copy.noPdfMatchForLine);
        }
      })
      .catch((forwardError) => {
        if (requestEpoch !== forwardSearchEpochRef.current) return;
        setForwardSearchNotice(String(forwardError));
      });
  }, [previewPath, syncTexMappingStale]);

  const jumpToPdfForLine = useCallback((line: number, column: number) => {
    jumpToPdfForSource(sourcePath, line, column);
  }, [jumpToPdfForSource, sourcePath]);

  /**
   * Inverse search: a click in the compiled PDF opens the source behind it.
   *
   * Unlike forward search this does *not* refuse to run once the buffer is
   * dirty. SyncTeX still knows exactly which source line produced the point —
   * it just numbers it against the snapshot that was compiled — so the answer
   * is remapped through the edits made since (`remapCompiledLine`) instead of
   * being thrown away for a whole-file text search, which lands on whichever
   * paragraph happens to repeat the clicked word first.
   *
   * `word` then buys back the column: TeX records `Column:-1` for every result,
   * so an unrefined jump parks the cursor at the start of the line, which for a
   * paragraph written on one source line is nowhere near what was clicked.
   */
  const openSourceForPdfPosition = useCallback((
    page: number,
    x: number,
    y: number,
    text: string,
    context: string,
    word?: string,
  ) => {
    if (!previewPath || extension(previewPath) !== ".pdf") {
      navigateToPdfTextFallback(text, context);
      return;
    }
    const requestEpoch = ++forwardSearchEpochRef.current;
    void latexInverseSearch(previewPath, page, x, y)
      .then((result) => {
        if (requestEpoch !== forwardSearchEpochRef.current) return;
        const location = result.locations[0];
        if (!location) {
          // Falling back to a text search is a guess, so say so even when it
          // lands: an unannounced wrong jump is indistinguishable from a right
          // one, which is how "the jump is inaccurate" hides for weeks.
          const fallbackFound = navigateToPdfTextFallback(text, context);
          const diagnostic = result.stderr.trim();
          setForwardSearchNotice(
            diagnostic
            || (fallbackFound ? copy.pdfPointMatchedByTextOnly : copy.noSourceMatchForPdfPoint),
          );
          return;
        }
        const targetPath = location.sourcePath;
        const navigate = () => {
          setPendingSourceNavigation({
            path: targetPath,
            line: location.line,
            column: location.column ?? 0,
            fromSyncTex: true,
            word,
            pdfText: text,
          });
        };
        if (sameWorkspacePath(targetPath, sourcePathRef.current)) {
          navigate();
          return;
        }
        void openSource(targetPath, location.line, true).then((opened) => {
          if (opened) navigate();
        });
      })
      .catch((inverseError) => {
        if (requestEpoch !== forwardSearchEpochRef.current) return;
        navigateToPdfTextFallback(text, context);
        // A PDF built outside Typeset (by a skill, or a terminal `latexmk`
        // without -synctex=1) has no SyncTeX file at all, and `synctex` says so
        // in its own words. That is a one-recompile fix, not an error.
        const message = String(inverseError);
        setForwardSearchNotice(
          /no synctex available/i.test(message) ? copy.pdfHasNoSyncTexData : message,
        );
      });
  }, [navigateToPdfTextFallback, openSource, previewPath]);

  const lastPdfPositionRef = useRef<{ page: number; x: number; y: number; word?: string } | null>(null);

  const syncEditorToPdf = useCallback(() => {
    const activeEditorView = editorMode === "code" ? editorRef.current?.view : visualViewRef.current;
    if (!activeEditorView) return;
    const pos = activeEditorView.state.selection.main.head;
    const lineObj = activeEditorView.state.doc.lineAt(pos);
    jumpToPdfForLine(lineObj.number, pos - lineObj.from + 1);
  }, [editorMode, jumpToPdfForLine]);

  const syncPdfToEditor = useCallback(() => {
    if (lastPdfPositionRef.current) {
      const pos = lastPdfPositionRef.current;
      openSourceForPdfPosition(pos.page, pos.x, pos.y, "", "", pos.word);
    } else {
      openSourceForPdfPosition(1, 72, 100, "", "");
    }
  }, [openSourceForPdfPosition]);

  const jumpFromOutline = useCallback((line: number, file: string | null) => {
    // An outline item represents a source heading. Open the exact source line
    // and use SyncTeX to bring the compiled PDF to the corresponding output.
    setPdfPanelVisible(true);
    setLogOpen(false);
    // A heading that came in through \input lives in another file: open that
    // file at the heading instead of scrolling the current one to a line that
    // means nothing here.
    if (file && !sameWorkspacePath(file, sourcePathRef.current)) {
      void openSource(file, line, true).then((opened) => {
        if (opened) jumpToPdfForSource(file, line, 1);
      });
      return;
    }
    navigateToLine(line);
    jumpToPdfForLine(line, 1);
  }, [jumpToPdfForLine, jumpToPdfForSource, navigateToLine, openSource]);

  useEffect(() => {
    if (!pdfForwardTarget) return;
    const timeout = window.setTimeout(() => setPdfForwardTarget(null), 2500);
    return () => window.clearTimeout(timeout);
  }, [pdfForwardTarget]);

  useEffect(() => {
    if (!forwardSearchNotice) return;
    const timeout = window.setTimeout(() => setForwardSearchNotice(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [forwardSearchNotice]);

  const refreshAfterRevisionRestore = useCallback(async () => {
    const activePath = sourcePathRef.current;
    if (!activePath) return;
    if (externalChangeRef.current) throw new Error(copy.reviewExternalChangeBeforeSave(basename(activePath)));
    let restored: FileText;
    try {
      restored = await fileReadText(activePath);
    } catch {
      // Restoring a revision in which this file was absent is a valid way to
      // recover a deletion. Leave the editor on the start page instead of
      // masking the successful restore with a stale-tab read error.
      documentEpochRef.current += 1;
      setSourcePath(null);
      setPreviewPath(null);
      setLoaded(null);
      resetDraft("");
      setDocumentSources({});
      setTreeRefreshKey((key) => key + 1);
      return;
    }
    loadedRef.current = restored;
    setLoaded(restored);
    resetDraft(restored.content);
    setDocumentSources((sources) => ({ ...sources, [restored.path]: restored.content }));
    setSyncTexOutdated(true);
    setTreeRefreshKey((key) => key + 1);
    dirtySinceRef.current = null;
    await typesetRecoveryClear(activePath).catch(() => undefined);
  }, [copy, resetDraft]);

  const prepareProjectReplace = useCallback(async (): Promise<boolean> => {
    const activePath = sourcePathRef.current;
    if (externalChangeRef.current) {
      if (activePath) {
        setError(null);
      }
      return false;
    }
    const saved = await save();
    if (!saved) return false;
    return true;
  }, [copy, save]);

  const refreshAfterProjectReplace = useCallback(async (_result: TypesetProjectReplaceResult) => {
    const activePath = sourcePathRef.current;
    if (!activePath) return;
    const file = await fileReadText(activePath);
    loadedRef.current = file;
    setLoaded(file);
    resetDraft(file.content);
    setDocumentSources((sources) => ({ ...sources, [file.path]: file.content }));
    updateExternalChange(null);
    setTreeRefreshKey((key) => key + 1);
    setSyncTexOutdated(true);
    dirtySinceRef.current = null;
    await typesetRecoveryClear(activePath).catch(() => undefined);
  }, [resetDraft, updateExternalChange]);

  const openProjectSearchMatch = useCallback((match: TypesetProjectSearchMatch) => {
    void openSource(match.path, match.line, true).then((opened) => {
      if (opened) navigateToLine(match.line);
    });
  }, [navigateToLine, openSource]);

  const returnToStart = useCallback(() => {
    if (dirty && !window.confirm(copy.discardReturnToList)) {
      return;
    }
    void scanProject();
  }, [dirty, scanProject]);

  useEffect(() => {
    if (editorMode !== "code") return;
    const view = editorRef.current?.view;
    if (!view) return;
    const scrollTarget = view.scrollDOM;
    let frame = 0;
    const updateLine = (preferSelection = false) => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (preferSelection && view.hasFocus) {
          setCurrentSourceLine(view.state.doc.lineAt(view.state.selection.main.head).number);
          return;
        }
        setCurrentSourceLine(codeVisibleLineForView(view));
      });
    };
    const updateFromScroll = () => updateLine(false);
    const updateFromSelection = () => updateLine(true);
    scrollTarget.addEventListener("scroll", updateFromScroll, { passive: true });
    view.contentDOM.addEventListener("click", updateFromSelection);
    view.contentDOM.addEventListener("keyup", updateFromSelection);
    document.addEventListener("selectionchange", updateFromSelection);
    updateLine(true);
    return () => {
      window.cancelAnimationFrame(frame);
      scrollTarget.removeEventListener("scroll", updateFromScroll);
      view.contentDOM.removeEventListener("click", updateFromSelection);
      view.contentDOM.removeEventListener("keyup", updateFromSelection);
      document.removeEventListener("selectionchange", updateFromSelection);
    };
  }, [editorMode, sourcePath]);

  const hasWorkspaceDocument = Boolean(sourcePath || loaded || previewPath);
  const pendingReviewPaths = useMemo(() => {
    const paths: string[] = [];
    for (const item of pendingChangeSet?.decisions ?? []) {
      if (!item.operationId.startsWith("comment:") && !paths.some((path) => sameWorkspacePath(path, item.path))) {
        paths.push(item.path);
      }
    }
    if (externalChange?.path && !paths.some((path) => sameWorkspacePath(path, externalChange.path))) {
      paths.push(externalChange.path);
    }
    return paths;
  }, [externalChange?.path, pendingChangeSet]);
  /**
   * Files that still owe an answer. A change set applies atomically, so an
   * answered file stays open in the editor until the whole transaction
   * resolves — but it must stop advertising itself as unreviewed, otherwise
   * answering the last hunk of a file changes nothing anywhere on screen and
   * every remaining button reads as broken.
   */
  const unansweredReviewPaths = useMemo(() => {
    const paths: string[] = [];
    const answered: string[] = [];
    for (const item of pendingChangeSet?.decisions ?? []) {
      if (item.operationId.startsWith("comment:")) continue;
      if (item.decision === "pending") {
        if (!paths.some((path) => sameWorkspacePath(path, item.path))) paths.push(item.path);
      } else {
        answered.push(item.path);
      }
    }
    if (externalChange?.path
      && !answered.some((path) => sameWorkspacePath(path, externalChange.path))
      && !paths.some((path) => sameWorkspacePath(path, externalChange.path))) {
      paths.push(externalChange.path);
    }
    return paths;
  }, [externalChange?.path, pendingChangeSet]);
  // Answers are recorded against whichever change set owns the file, which is
  // not necessarily the one the project banner is currently showing. A renamed
  // file carries more than one operation, and it is answered only once every
  // one of them is.
  const activeReviewDecisions = useMemo(() => (externalChange
    ? pendingChangeSets
      .flatMap((changeSet) => changeSet.decisions)
      .filter((item) => (
        !item.operationId.startsWith("comment:") && sameWorkspacePath(item.path, externalChange.path)
      ))
    : []), [externalChange, pendingChangeSets]);
  /**
   * The transaction this file's review belongs to.
   *
   * Its provenance outranks the proposal's own. A watcher notification arrives
   * before the Chat-completed event and stamps the proposal `external`, so the
   * two banners ended up describing one write as "Changed by Chat" above
   * "Changed by an external program" — the same event, contradicting itself.
   */
  const activeReviewChangeSet = useMemo(() => (externalChange
    ? pendingChangeSets.find((changeSet) => changeSet.decisions.some((item) => (
      !item.operationId.startsWith("comment:") && sameWorkspacePath(item.path, externalChange.path)
    )))
    : undefined), [externalChange, pendingChangeSets]);
  const activeReviewStaged = activeReviewDecisions.length > 0
    && activeReviewDecisions.every((item) => item.decision !== "pending");
  /**
   * The answer this file already carries, read from what the reviewer actually
   * clicked (`externalChange`) rather than the change set's own ledger entry.
   * The ledger's decision is derived from a byte comparison after the merge,
   * which can read "partial" even when every hunk was answered the same way —
   * that mismatch left an answered file with no button lit up at all.
   */
  const activeReviewStagedDecision = useMemo<"accept" | "reject" | "partial" | null>(() => {
    if (!activeReviewStaged || !externalChange) return null;
    if (externalChange.tooLargeToChunk) {
      return externalChange.wholeFileDecision === "incoming"
        ? "accept"
        : externalChange.wholeFileDecision === "local" ? "reject" : null;
    }
    const decisions = externalChange.decisions;
    if (decisions.length === 0) return null;
    if (decisions.every((decision) => decision === "accept")) return "accept";
    if (decisions.every((decision) => decision === "reject")) return "reject";
    return "partial";
  }, [activeReviewStaged, externalChange]);
  const nextUnansweredReviewPath = unansweredReviewPaths.find((path) => (
    !sameWorkspacePath(path, sourcePath)
  )) ?? null;
  const pendingCommentDecisionCount = pendingChangeSet?.decisions
    .filter((item) => item.operationId.startsWith("comment:")).length ?? 0;
  const showProjectChangeSetReview = Boolean(
    pendingChangeSet
    && pendingChangeSet.decisions.length > 0
    && (pendingReviewPaths.length > 0 || pendingCommentDecisionCount > 0)
    && (pendingReviewPaths.length + (pendingCommentDecisionCount > 0 ? 1 : 0) > 1
      || !externalChange?.path
      || !pendingReviewPaths.some((path) => sameWorkspacePath(path, externalChange.path))),
  );
  const changeSetFullyReviewed = Boolean(
    pendingChangeSet?.decisions.length
    && pendingChangeSet.decisions.every((item) => item.decision !== "pending"),
  );
  // Review happens in the editor itself. The proposal already includes every
  // non-overlapping local edit through the three-way merge, so a second
  // "review in editor / view draft" mode switch only hid what was being judged.
  const reviewingIncoming = externalChange?.path === sourcePath;
  const externalReviewProposal = reviewingIncoming && externalChange
    ? { content: externalChange.reviewContent, diff: externalChange.reviewDiff }
    : null;
  const externalReviewIncoming = externalChange?.tooLargeToChunk
    ? externalChange.file.content
    : externalReviewProposal?.content ?? externalChange?.file.content ?? "";
  const reviewDraft = reviewingIncoming ? externalChange?.reviewDraft ?? null : null;
  const editorDisplayDraft = reviewingIncoming && externalChange
    ? reviewDisplayText(externalChange)
    : draft;
  // The surface stays writable during a review: a reviewer who spots a typo in
  // an incoming paragraph fixes it here. `editReviewDraft` keeps that typing on
  // the proposal (and rejects the doc-swap echo) instead of letting it land in
  // `draft`, which is the merge's local side.
  const reviewSafeOnChange = reviewingIncoming ? editReviewDraft : changeDraft;
  const externalReviewDiff = externalReviewProposal?.diff ?? null;
  const externalReviewChanges = useMemo(
    () => externalReviewDiff?.changes ?? EMPTY_REVIEW_CHANGES,
    [externalReviewDiff],
  );
  const externalReviewDecisions = externalChange?.decisions ?? EMPTY_REVIEW_DECISIONS;
  /**
   * Where each proposal line sits in the text now on screen.
   *
   * Review markers are addressed by line number, so review-time typing would
   * otherwise slide every marker below it onto the wrong line. `null` means the
   * reviewer rewrote that line themselves, which is not a hunk to answer any
   * more and correctly loses its marker.
   */
  const reviewLineMap = useMemo(
    () => reviewLineMapper(externalChange?.reviewContent ?? "", reviewDraft),
    [externalChange?.reviewContent, reviewDraft],
  );
  const externalReviewDiffLines = useMemo<CodeDiffLine[]>(() => {
    if (!externalReviewDiff) return [];
    // Which change a line belongs to decides how its answer reads in the text:
    // an accepted insertion is being kept, a rejected one is on its way out.
    const decisionByLine = new Map<number, CodeReviewDecision>();
    externalReviewChanges.forEach((change, index) => {
      const decision = externalReviewDecisions[index] ?? "pending";
      for (let line = change.newStart + 1; line <= change.newEnd; line += 1) {
        decisionByLine.set(line, decision);
      }
    });
    const added = externalReviewDiff.hunks.flatMap((hunk) => (
      hunk.lines.flatMap((line): CodeDiffLine[] => {
        if (line.kind !== "added" || !line.newLine) return [];
        const mapped = reviewLineMap(line.newLine);
        if (mapped === null) return [];
        // Once the drawer is open the hunk controls are already on screen;
        // the line no longer needs to advertise itself as clickable.
        return [{ line: mapped, type: "added" as const, decision: decisionByLine.get(line.newLine) ?? "pending", interactive: !changesExpanded }];
      })
    ));
    // Removed source has no line in the proposal document. Keep it as a
    // deletion marker anchored at the first surviving proposal line after the
    // gap; editorDecorations renders the exact old text in a red inline widget
    // instead of painting the unchanged line that happens to close the gap.
    const removed = externalReviewChanges.flatMap((change, index): CodeDiffLine[] => {
      if (change.beforeLines.length === 0) return [];
      const anchor = reviewLineMap(Math.max(1, change.newStart + 1));
      if (anchor === null) return [];
      return [{
        line: Math.max(1, anchor),
        type: "removed" as const,
        text: change.beforeLines.join("\n"),
        decision: externalReviewDecisions[index] ?? "pending",
        interactive: !changesExpanded,
      }];
    });
    return [...removed, ...added];
  }, [changesExpanded, externalReviewChanges, externalReviewDecisions, externalReviewDiff, reviewLineMap]);

  const decideExternalReviewHunk = useCallback((index: number, decision: TypesetProposalDecision) => {
    const pending = externalChangeRef.current;
    if (!pending || externalReviewBusy || pending.decisions.length === 0) return;
    const safeIndex = clampNumber(index, 0, pending.decisions.length - 1);
    const decisions = pending.decisions.map((current, currentIndex) => (
      currentIndex === safeIndex ? decision : current
    ));
    // Undoing a hunk back to "pending" is a real answer to record, not a
    // reason to auto-finalize — the transaction is not more complete than it
    // was a moment ago.
    if (decision !== "pending" && !decisions.includes("pending")) {
      void finalizeExternalChange(decisions, "apply");
      return;
    }
    decideExternalChange(safeIndex, decision);
  }, [decideExternalChange, externalReviewBusy, finalizeExternalChange]);
  const externalChangeReviewCopy = useMemo<ExternalChangeReviewCopy>(() => ({
    title: copy.externalChangeTitle,
    description: copy.externalChangeDescription,
    localDraftWarning: copy.externalChangeLocalDraftWarning,
    additions: copy.externalChangeAdditions,
    deletions: copy.externalChangeDeletions,
    showChanges: copy.externalChangeShowChanges,
    hideChanges: copy.externalChangeHideChanges,
    accept: copy.externalChangeAccept,
    reject: copy.externalChangeReject,
    answeredAccept: copy.externalChangeAnsweredAccept,
    answeredReject: copy.externalChangeAnsweredReject,
    answeredPartial: copy.externalChangeAnsweredPartial,
    accepting: copy.externalChangeAccepting,
    rejecting: copy.externalChangeRejecting,
    apply: copy.externalChangeApply,
    applying: copy.externalChangeApplying,
    acceptOne: copy.externalChangeAcceptOne,
    rejectOne: copy.externalChangeRejectOne,
    acceptedOne: copy.externalChangeAcceptedOne,
    rejectedOne: copy.externalChangeRejectedOne,
    undoOne: copy.externalChangeUndoOne,
    pending: copy.externalChangePending,
    oldLine: copy.externalChangeOldLine,
    newLine: copy.externalChangeNewLine,
    reviewInEditor: copy.externalChangeReviewInEditor,
    viewDraft: copy.externalChangeViewDraft,
    previousChange: copy.externalChangePrevious,
    nextChange: copy.externalChangeNext,
    changePosition: copy.externalChangePosition,
    changePositionUnknown: copy.externalChangePositionUnknown,
    answeredCount: copy.externalChangeAnswered,
    reviewed: copy.externalChangeReviewed,
    reviewNext: copy.externalChangeReviewNext,
    edited: copy.externalChangeEdited,
    discardEdits: copy.externalChangeDiscardEdits,
    tooLargeTitle: copy.externalChangeTooLargeTitle,
    tooLargeDetail: copy.externalChangeTooLargeDetail,
    takeIncoming: copy.externalChangeTakeIncoming,
    keepLocal: copy.externalChangeKeepLocal,
    compare: copy.externalChangeCompare,
    closeCompare: copy.externalChangeCloseCompare,
    localVersion: copy.externalChangeLocalVersion,
    incomingVersion: copy.externalChangeIncomingVersion,
    compareTruncated: copy.externalChangeCompareTruncated,
  }), [copy]);
  const externalReviewHunks = useMemo<CodeReviewConfig | null>(() => {
    if (!reviewingIncoming || externalChange?.tooLargeToChunk || externalReviewChanges.length === 0) return null;
    // A pure deletion at EOF is anchored one line past the candidate document;
    // CodeMirror clamps the widget to its final line, so the review config must
    // use that same visible line for click-to-reveal hit testing.
    const visibleLineCount = Math.max(1, editorDisplayDraft.split("\n").length);
    const hunks = externalReviewChanges.flatMap((change, index) => {
      // A pure deletion has no line of its own in the proposal; anchor its
      // control to the line that closed over the gap.
      const anchor = reviewLineMap(Math.max(1, change.newStart + 1));
      if (anchor === null) return [];
      const mappedEnd = reviewLineMap(Math.max(1, change.newEnd));
      return [{
        id: change.id,
        index,
        line: Math.min(visibleLineCount, Math.max(1, anchor)),
        endLine: Math.min(visibleLineCount, Math.max(1, anchor, mappedEnd ?? anchor)),
        decision: externalReviewDecisions[index] ?? ("pending" as const),
      }];
    });
    if (hunks.length === 0) return null;
    return {
      hunks,
      // Collapsed by default: clicking the highlighted line (`onReveal`) or
      // pressing "Show changes" in the banner both just open the same drawer.
      showControls: changesExpanded,
      onReveal: () => setChangesExpanded(true),
      acceptLabel: externalChangeReviewCopy.acceptOne,
      rejectLabel: externalChangeReviewCopy.rejectOne,
      acceptedLabel: externalChangeReviewCopy.acceptedOne,
      rejectedLabel: externalChangeReviewCopy.rejectedOne,
      undoLabel: externalChangeReviewCopy.undoOne,
      positionLabel: externalChangeReviewCopy.changePosition,
      busy: externalReviewBusy !== null,
      onDecision: decideExternalReviewHunk,
    };
  }, [
    changesExpanded,
    decideExternalReviewHunk,
    externalChange?.tooLargeToChunk,
    externalReviewBusy,
    externalChangeReviewCopy,
    externalReviewChanges,
    externalReviewDecisions,
    reviewLineMap,
    editorDisplayDraft,
    reviewingIncoming,
  ]);
  /**
   * Jump the live editor to a change.
   *
   * A "1 / 2" counter above a 300-line diff is a claim the reviewer cannot act
   * on: the second change may be four screens down. These move through the same
   * hunks the inline controls answer, in whichever surface is on screen, and
   * select the hunk so it is obvious which one is now under the cursor.
   */
  /**
   * Which change the caret is in, 1-based, for the counter between the arrows.
   *
   * Null between changes rather than clamped to a neighbour: claiming a
   * position the caret is not in is exactly the kind of number that stops
   * meaning anything.
   */
  const currentReviewChange = useMemo(() => {
    const hunks = externalReviewHunks?.hunks ?? [];
    const hit = hunks.find((hunk) => (
      currentSourceLine >= hunk.line && currentSourceLine <= (hunk.endLine ?? hunk.line)
    ));
    return hit ? hit.index + 1 : null;
  }, [currentSourceLine, externalReviewHunks]);

  const focusReviewHunk = useCallback((step: 1 | -1) => {
    const hunks = externalReviewHunks?.hunks ?? [];
    if (hunks.length === 0) return;
    const view = editorModeRef.current === "code" ? editorRef.current?.view : visualViewRef.current;
    if (!view) return;
    const current = view.state.doc.lineAt(view.state.selection.main.head).number;
    const ordered = [...hunks].sort((left, right) => left.line - right.line);
    const next = step === 1
      ? ordered.find((hunk) => hunk.line > current) ?? ordered[0]
      : [...ordered].reverse().find((hunk) => hunk.line < current) ?? ordered[ordered.length - 1];
    const line = view.state.doc.line(clampNumber(next.line, 1, view.state.doc.lines));
    setCurrentSourceLine(line.number);
    view.focus();
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    if (editorModeRef.current === "code") scrollCodeEditorToLine(view, line.number);
  }, [externalReviewHunks]);
  const gridClassName = [
    "typeset-main-grid ide-redesign-body",
    !hasWorkspaceDocument ? "start-mode" : "",
    !effectiveProjectPanelVisible ? "project-hidden" : "",
    !effectivePdfPanelVisible ? "pdf-hidden" : "",
    slideFocusActive ? "slide-focus-mode" : "",
  ].filter(Boolean).join(" ");
  const gridStyle = {
    "--typeset-left-user-w": `${projectPanelWidth}px`,
    "--typeset-preview-user-w": `${pdfPanelWidth}px`,
  } as CSSProperties;

  return (
    <div className={`typeset-workbench ide-redesign-main${browserPreviewMode ? " browser-preview" : ""}`}>
      {browserPreviewMode && (
        <div className="typeset-runtime-banner" role="status">
          <strong>{copy.browserPreview}</strong>
          <span>{copy.sampleDataOnly}</span>
          <em>{copy.desktopModeHint}</em>
        </div>
      )}
      <div
        className={gridClassName}
        style={gridStyle}
      >
        {hasWorkspaceDocument && (
          <nav className="typeset-rail ide-rail" aria-label={copy.typesetSectionsLabel}>
            <div className="ide-rail-tabs-nav">
              <div className="ide-rail-tabs-wrapper">
                <button
                  type="button"
                  className={`ide-rail-tab-link${effectiveProjectPanelVisible && activeLeftTab === "files" ? " open-rail active" : ""}`}
                  title={effectiveProjectPanelVisible && activeLeftTab === "files" ? copy.hideProjectFiles : copy.showProjectFiles}
                  aria-label={effectiveProjectPanelVisible && activeLeftTab === "files" ? copy.hideProjectFiles : copy.showProjectFiles}
                  aria-pressed={effectiveProjectPanelVisible && activeLeftTab === "files"}
                  onClick={() => {
                    if (slideFocusActive) {
                      setSlideFocusMode(false);
                      setProjectPanelVisible(true);
                      setActiveLeftTab("files");
                    } else if (effectiveProjectPanelVisible && activeLeftTab === "files") {
                      setProjectPanelVisible(false);
                    } else {
                      setProjectPanelVisible(true);
                      setActiveLeftTab("files");
                    }
                  }}
                >
                  <ToolIcon name="files" className="ide-rail-tab-link-icon" />
                </button>
                <button
                  type="button"
                  className={`ide-rail-tab-link${effectiveProjectPanelVisible && activeLeftTab === "review" ? " open-rail active" : ""}`}
                  title={effectiveProjectPanelVisible && activeLeftTab === "review" ? copy.hideReviewPanel : copy.showReviewPanel}
                  aria-label={effectiveProjectPanelVisible && activeLeftTab === "review" ? copy.hideReviewPanel : copy.showReviewPanel}
                  aria-pressed={effectiveProjectPanelVisible && activeLeftTab === "review"}
                  onClick={() => {
                    if (slideFocusActive) {
                      setSlideFocusMode(false);
                      setProjectPanelVisible(true);
                      setActiveLeftTab("review");
                    } else if (effectiveProjectPanelVisible && activeLeftTab === "review") {
                      setProjectPanelVisible(false);
                    } else {
                      setProjectPanelVisible(true);
                      setActiveLeftTab("review");
                    }
                  }}
                >
                  <ToolIcon name="review" className="ide-rail-tab-link-icon" />
                </button>
                <button
                  type="button"
                  className={`ide-rail-tab-link${effectiveProjectPanelVisible && activeLeftTab === "ai" ? " open-rail active" : ""}`}
                  title={effectiveProjectPanelVisible && activeLeftTab === "ai" ? copy.hideAiPanel : copy.showAiPanel}
                  aria-label={effectiveProjectPanelVisible && activeLeftTab === "ai" ? copy.hideAiPanel : copy.showAiPanel}
                  aria-pressed={effectiveProjectPanelVisible && activeLeftTab === "ai"}
                  onClick={() => {
                    if (slideFocusActive) {
                      setSlideFocusMode(false);
                      setProjectPanelVisible(true);
                      setActiveLeftTab("ai");
                    } else if (effectiveProjectPanelVisible && activeLeftTab === "ai") {
                      setProjectPanelVisible(false);
                    } else {
                      setProjectPanelVisible(true);
                      setActiveLeftTab("ai");
                    }
                  }}
                >
                  <ToolIcon name="ai" className="ide-rail-tab-link-icon" />
                </button>
                <button
                  type="button"
                  className="ide-rail-tab-link"
                  disabled={saving || compileStatus === "running"}
                  title={copy.backToSourceList}
                  aria-label={copy.home}
                  onClick={returnToStart}
                >
                  <ToolIcon name="home" className="ide-rail-tab-link-icon" />
                </button>
              </div>
              <nav aria-label={editorSettingsCopy.title}>
                <button
                  ref={railSettingsButtonRef}
                  type="button"
                  className={`ide-rail-tab-link typeset-rail-settings-btn${editorSettingsOpen ? " active" : ""}`}
                  title={editorSettingsCopy.title}
                  aria-label={editorSettingsCopy.title}
                  aria-expanded={editorSettingsOpen}
                  onClick={() => setEditorSettingsOpen((open) => !open)}
                >
                  <ToolIcon name="settings" className="ide-rail-tab-link-icon" />
                </button>
                <TypesetEditorSettings
                  open={editorSettingsOpen}
                  anchorRef={railSettingsButtonRef}
                  side="right"
                  align="end"
                  onClose={() => setEditorSettingsOpen(false)}
                />
              </nav>
            </div>
          </nav>
        )}
        {!hasWorkspaceDocument ? (
          <TypesetStartPage
            projectPath={currentProject?.path ?? null}
            documents={startDocuments}
            projects={startProjects}
            latexAvailable={latexAvailable}
            loading={loading}
            error={error}
            onOpenSource={openPath}
            onCreateSource={createSource}
            onRefresh={() => void scanProject()}
          />
        ) : (
          <>
            {effectiveProjectPanelVisible && (
              <>
                <div className="typeset-left-panel file-tree-outline-panel-group">
                  {activeLeftTab === "files" && (
                    <>
                      <TypesetExplorer
                        projectPath={currentProject?.path ?? null}
                        rootPath={activeWorkDir}
                        activeSourcePath={sourcePath}
                        activePreviewPath={previewPath}
                        mainDocumentPath={mainDocumentPath}
                        refreshKey={treeRefreshKey}
                        reviewPaths={unansweredReviewPaths}
                        reviewLabel={copy.pendingReviewBadge}
                        onOpenPath={openPath}
                        onFileMutation={handleFileMutation}
                        onSetMainDocument={(path) => {
                          setMainDocumentPreference(path);
                          setTreeRefreshKey((key) => key + 1);
                        }}
                      />
                      <TypesetOutlinePanel
                        activeLine={activeOutlineItem?.line ?? null}
                        collapsed={outlineCollapsed}
                        currentPath={sourcePath}
                        outline={numberedOutline}
                        height={outlinePanelHeight}
                        wordCount={documentWordCount}
                        onJumpToLine={jumpFromOutline}
                        onResizeKeyDown={handleOutlineResizeKey}
                        onResizePointerDown={beginOutlineResizeFromPointer}
                        onToggleCollapsed={() => setOutlineCollapsed((collapsed) => !collapsed)}
                      />
                    </>
                  )}
                  {activeLeftTab === "review" && (
                    <TypesetReviewPanel
                      trackChangesEnabled={trackChangesEnabled}
                      onToggleTrackChanges={() => setTrackChangesEnabled((on) => !on)}
                      currentLine={currentSourceLine}
                      sourcePath={sourcePath}
                      onJumpToLine={navigateToLine}
                      onClose={() => setProjectPanelVisible(false)}
                    />
                  )}
                  {activeLeftTab === "ai" && (
                    <TypesetAiPanel />
                  )}
                </div>
                <div
                  className="typeset-resize-handle project"
                  data-resize-panel="project"
                  role="separator"
                  aria-label={copy.resizeProjectFiles}
                  aria-orientation="vertical"
                  aria-valuemin={PROJECT_PANEL_MIN_W}
                  aria-valuemax={PROJECT_PANEL_MAX_W}
                  aria-valuenow={projectPanelWidth}
                  title={copy.dragResizeProjectFiles}
                  tabIndex={0}
                  onPointerDown={(event) => beginPanelResizeFromPointer("project", event)}
                  onKeyDown={(event) => handlePanelResizeKey("project", event)}
                >
                  <span className="typeset-resize-handle-hit" aria-hidden="true" />
                  <div className="typeset-resizer-grip upper" aria-hidden="true">
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                  </div>
                  <button
                    type="button"
                    className="typeset-resizer-collapse-btn"
                    title={copy.hideProjectFiles}
                    aria-label="Collapse project panel"
                    onClick={(event) => {
                      event.stopPropagation();
                      setProjectPanelVisible(false);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <ToolIcon name="previous" />
                  </button>
                  <div className="typeset-resizer-grip lower" aria-hidden="true">
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                  </div>
                </div>
              </>
            )}
            {!effectiveProjectPanelVisible && (
              <button
                type="button"
                className="typeset-edge-expand-btn left"
                title={copy.showProjectFiles}
                aria-label="Expand project panel"
                onClick={() => setProjectPanelVisible(true)}
              >
                <ToolIcon name="next" />
              </button>
            )}
            <section className={`typeset-editor-pane ide-redesign-editor-container ${editorMode === "visual" ? "visual-mode" : "code-mode"}`} aria-label={copy.sourceEditorLabel}>
              {loaded && (
                <TypesetEditorToolbar
                  spellCheck={spellCheck}
                  onToggleSpellCheck={toggleSpellCheck}
                  activeSlide={activeBeamerSlide}
                  slides={beamerSlides}
                  path={sourcePath}
                  tabs={openTabs}
                  dirtyTabs={inactiveDirtyPaths}
                  reviewTabs={unansweredReviewPaths}
                  reviewLabel={copy.pendingReviewBadge}
                  // Tab switches can cross projects; resolve the selected
                  // source so the file-tree root and PDF follow the tab too.
                  onSelectTab={(path) => void openSource(path)}
                  onCloseTab={closeTab}
                  draft={draft}
                  mode={editorMode}
                  canRedo={canRedoDraft}
                  canUndo={canUndoDraft}
                  editorRef={editorRef}
                  visualViewRef={visualViewRef}
                  onChange={changeDraft}
                  onModeChange={changeEditorMode}
                  onNavigateToLine={navigateToLine}
                  onEditSlideSource={openCodeAtLine}
                  onRedo={redoDraft}
                  onSave={saveCurrentEditor}
                  onHistory={() => setHistoryOpen(true)}
                  historyLabel={copy.historyTitle}
                  onProjectSearch={() => setProjectSearchOpen(true)}
                  projectSearchLabel={copy.projectSearchTitle}
                  onComments={openComments}
                  commentsLabel={copy.commentsTitle}
                  onSearch={openCodeRange}
                  onUndo={undoDraft}
                  saving={saving}
                  citationPapers={literaturePapers}
                  projectImagePaths={projectImagePaths}
                  onPrepareCitationKeys={prepareCitationKeys}
                  onSynchronizeBibliography={synchronizeBibliography}
                  compiling={compileStatus === "running"}
                  // Review-time typing lands in `reviewDraft`, not `draft`, so
                  // `dirty` alone left Save greyed out on a review the reviewer
                  // had just edited.
                  dirty={dirty || reviewDraft !== null}
                />
              )}
              {error && <div className="typeset-error-bar">{error}</div>}
              {((showProjectChangeSetReview && pendingChangeSet) || externalChange?.path === sourcePath) && (
              <div className={`typeset-review-dock${showProjectChangeSetReview && pendingChangeSet && externalChange?.path === sourcePath ? " docked-unified" : ""}`}>
              {showProjectChangeSetReview && pendingChangeSet && (
                <TypesetChangeSetMenu
                  files={pendingReviewPaths.map((path) => {
                    const operations = pendingChangeSet.decisions.filter((item) => sameWorkspacePath(item.path, path));
                    const deleted = operations.length > 0 && operations.every((item) => item.operationId.startsWith("delete:"));
                    // An answered file keeps its entry — the transaction still
                    // needs it — but it must read as done, not as waiting.
                    const answered = !unansweredReviewPaths.some((pending) => sameWorkspacePath(pending, path));
                    return {
                      path,
                      label: `${basename(path)}${deleted ? ` · ${copy.pendingReviewDeleted}` : ""}`,
                      title: [
                        path,
                        deleted ? copy.pendingReviewDeleted : "",
                        answered ? copy.externalChangeReviewed(unansweredReviewPaths.length) : "",
                      ].filter(Boolean).join(" · "),
                      answered,
                      active: sameWorkspacePath(path, sourcePath),
                    };
                  })}
                  copy={{
                    headline: copy.pendingReviewFiles(pendingReviewPaths.length),
                    actor: copy.pendingReviewActor(pendingChangeSet.actor),
                    actorTitle: `${pendingChangeSet.actor} · ${pendingChangeSet.origin}`,
                    // How far through the transaction the reviewer is. Chips show
                    // it per file, but only a count answers "can I stop yet"
                    // without reading every one of them.
                    progress: pendingReviewPaths.length > 1
                      ? copy.externalChangePosition(pendingReviewPaths.length - unansweredReviewPaths.length, pendingReviewPaths.length)
                      : null,
                    comments: pendingCommentDecisionCount > 0 ? copy.pendingReviewComments(pendingCommentDecisionCount) : null,
                    explanation: copy.pendingReviewExplanation,
                    carried: pendingChangeSet.carriedPaths?.length
                      ? copy.pendingReviewCarried(pendingChangeSet.carriedPaths.length)
                      : null,
                    carriedTitle: pendingChangeSet.carriedPaths?.length
                      ? pendingChangeSet.carriedPaths.join("\n")
                      : null,
                    menuLabel: copy.pendingReviewMenu,
                    selectFile: copy.pendingReviewSelectFile,
                    acceptAll: copy.pendingReviewAcceptAll,
                    rejectAll: copy.pendingReviewRejectAll,
                    apply: copy.pendingReviewApply,
                  }}
                  busy={externalReviewBusy !== null}
                  fullyReviewed={changeSetFullyReviewed}
                  // The open file (or non-text operation preview) owns the bar's
                  // right edge, so the change-set-wide answers move into the
                  // menu instead of doubling the accept/reject pair on screen.
                  actionsInMenu={Boolean((externalChange && externalChange.path === sourcePath) || changeSetOperationPreview)}
                  onSelect={(path) => void reviewPendingChangeSetPath(path)}
                  onAcceptAll={() => void resolveProjectChangeSet("accept")}
                  onRejectAll={() => void resolveProjectChangeSet("reject")}
                  onApply={() => void resolveProjectChangeSet(null)}
                />
              )}
              {externalChange?.path === sourcePath && (
                <TypesetExternalChangeReview
                  key={externalChange.id}
                  name={basename(sourcePath)}
                  current={externalChange.localContent}
                  incoming={externalReviewIncoming}
                  dirty={dirty}
                  busy={externalReviewBusy}
                  decisions={externalChange.decisions}
                  staged={activeReviewStaged}
                  remaining={unansweredReviewPaths.length}
                  actor={copy.pendingReviewActor(activeReviewChangeSet?.actor ?? externalChange.actor)}
                  origin={activeReviewChangeSet?.origin ?? externalChange.origin}
                  showActor={!showProjectChangeSetReview}
                  dockedWithChangeSet={showProjectChangeSetReview}
                  copy={externalChangeReviewCopy}
                  tooLargeToChunk={externalChange.tooLargeToChunk}
                  wholeFileDecision={externalChange.wholeFileDecision}
                  stagedDecision={activeReviewStagedDecision}
                  onTakeIncoming={takeIncomingWholeFile}
                  onKeepLocal={keepLocalWholeFile}
                  added={externalChange.reviewDiff.added}
                  removed={externalChange.reviewDiff.removed}
                  approximateStats={Boolean(externalChange.reviewDiff.countsApproximate)}
                  edited={reviewDraft !== null}
                  onDiscardEdits={discardReviewDraft}
                  onPreviousChange={externalReviewHunks ? () => focusReviewHunk(-1) : null}
                  onNextChange={externalReviewHunks ? () => focusReviewHunk(1) : null}
                  currentChange={currentReviewChange}
                  changesExpanded={changesExpanded}
                  onToggleChanges={() => setChangesExpanded((expanded) => !expanded)}
                  reviewChanges={externalReviewChanges}
                  onDecideChange={decideExternalChange}
                  onAccept={() => void acceptExternalChange()}
                  onReject={() => void rejectExternalChange()}
                  onApply={() => void applyExternalChangeReview()}
                  onNext={nextUnansweredReviewPath
                    ? () => void reviewPendingChangeSetPath(nextUnansweredReviewPath)
                    : null}
                />
              )}
              </div>
              )}
              {changeSetOperationPreview && pendingChangeSet && (
                <section className="typeset-changeset-operation-preview" aria-label={`${basename(changeSetOperationPreview.path)} review`}>
                  <div>
                    <strong>{basename(changeSetOperationPreview.path)}</strong>
                    <span>
                      {changeSetOperationPreview.kind === "delete"
                        ? copy.pendingReviewDeleted
                        : changeSetOperationPreview.previousPath
                          ? `${changeSetOperationPreview.previousPath} → ${changeSetOperationPreview.path}`
                          : changeSetOperationPreview.kind}
                    </span>
                  </div>
                  {changeSetOperationPreview.baseContent && <pre>{changeSetOperationPreview.baseContent}</pre>}
                  <div className="typeset-changeset-actions">
                    <button type="button" disabled={externalReviewBusy !== null} onClick={() => void resolvePreviewedChangeSetOperation("reject")}>{copy.externalChangeReject}</button>
                    <button type="button" className="accept" disabled={externalReviewBusy !== null} onClick={() => void resolvePreviewedChangeSetOperation("accept")}>{copy.externalChangeAccept}</button>
                    <button type="button" onClick={() => setChangeSetOperationPreview(null)}>×</button>
                  </div>
                </section>
              )}
              {documentGraphTruncated && (
                <div className="typeset-warning-bar" role="status">{copy.documentGraphTruncated(INCLUDE_MAX_FILES)}</div>
              )}
              {reviewCompileNotice && externalChange?.path === sourcePath && (
                <div className="typeset-warning-bar" role="status">{reviewCompileNotice}</div>
              )}
              {loading && !previewPath ? (
                <div className="typeset-empty">{copy.loadingSource}</div>
              ) : loaded ? (
                <>
                  <div
                    className="typeset-editor-body ide-redesign-editor-content"
                    hidden={editorMode !== "code"}
                    aria-hidden={editorMode !== "code"}
                  >
                    <CodeEditor
                      value={editorDisplayDraft}
                      language="latex"
                      onChange={reviewSafeOnChange}
                      diffLines={externalReviewDiffLines}
                      reviewHunks={externalReviewHunks}
                      extraKeymap={codeEditorKeymapRef.current}
                      onReady={(handle) => {
                        editorRef.current = handle;
                      }}
                      onDoubleClickPos={jumpToPdfForLine}
                      readOnly={saving}
                      wrap
                      dataEditor="typeset-code"
                      placeholder="\\section{Title}"
                      latexVscodeTheme
                    />
                  </div>
                  <div
                    className="typeset-editor-body typeset-visual-editor-host"
                    hidden={editorMode !== "visual"}
                    aria-hidden={editorMode !== "visual"}
                  >
                    {beamerSlides.length > 0 ? (
                      <TypesetCompiledVisual
                        path={previewPath}
                        refreshKey={refreshKey}
                        page={activeBeamerPage}
                        slide={activeBeamerSlide}
                        slides={beamerSlides}
                        source={editorDisplayDraft}
                        dirty={dirty}
                        compiling={compileStatus === "running"}
                        onChangeSource={changeDraft}
                        onSave={saveCurrentEditor}
                        onNavigateToLine={navigateToLine}
                        onOpenCodeAtLine={openCodeAtLine}
                        onOpenCodeRange={openCodeRange}
                        onSourceTextClick={openSourceForPdfText}
                        focused={slideFocusActive}
                        onToggleFocus={() => setSlideFocusMode((focused) => !focused)}
                      />
                    ) : (
                    <TypesetVisualEditor
                        path={sourcePath}
                        draft={editorDisplayDraft}
                        diffLines={externalReviewDiffLines}
                        reviewHunks={externalReviewHunks}
                        numbering={visualNumbering}
                        pdfCursor={visualPdfCursor}
                        onChange={reviewSafeOnChange}
                        onVisibleLineChange={setCurrentSourceLine}
                        onOpenCodeRange={openCodeRange}
                        onForwardSearch={jumpToPdfForLine}
                        onViewReady={onVisualViewReady}
                      onPasteImage={async (file) => {
                        const sourceName = file.name || `pasted-image.${file.type.split("/")[1] || "png"}`;
                        const imported = await typesetImportImageData(sourceName, new Uint8Array(await file.arrayBuffer()));
                        setTreeRefreshKey((key) => key + 1);
                        const imagePath = imported.path.replace(/\\/g, "/");
                        return `\n\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=\\linewidth]{${imagePath}}\n\\end{figure}\n`;
                      }}
                      onPasteError={(pasteError) => setError(String(pasteError))}
                      spellCheck={spellCheck}
                      readOnly={saving}
                      />
                    )}
                  </div>
                </>
              ) : (
                <div className="typeset-empty">
                  {previewPath ? copy.pdfOpenInSidePanel : copy.createOrOpenTex}
                </div>
              )}
            </section>
            {!effectivePdfPanelVisible && (
              <button
                type="button"
                className="typeset-edge-expand-btn right"
                title={copy.showPdfPanel}
                aria-label={copy.showPdfPanel}
                onClick={() => setPdfPanelVisible(true)}
              >
                <ToolIcon name="previous" />
              </button>
            )}
            {effectivePdfPanelVisible && (
              <>
                <div
                  className="typeset-resize-handle pdf"
                  data-resize-panel="pdf"
                  role="separator"
                  aria-label={copy.resizePdfPreview}
                  aria-orientation="vertical"
                  aria-valuemin={PDF_PANEL_MIN_W}
                  aria-valuemax={PDF_PANEL_MAX_W}
                  aria-valuenow={pdfPanelWidth}
                  title={copy.dragResizePdfPreview}
                  tabIndex={0}
                  onPointerDown={(event) => beginPanelResizeFromPointer("pdf", event)}
                  onKeyDown={(event) => handlePanelResizeKey("pdf", event)}
                >
                  <span className="typeset-resize-handle-hit" aria-hidden="true" />
                  <div className="typeset-resizer-sync-bar" role="toolbar" aria-label="SyncTeX navigation">
                    <button
                      type="button"
                      className="typeset-resizer-sync-btn sync-to-pdf"
                      title={copy.syncToPdf}
                      aria-label={copy.syncToPdf}
                      onClick={(event) => {
                        event.stopPropagation();
                        syncEditorToPdf();
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <ToolIcon name="syncToPdf" />
                    </button>
                    <button
                      type="button"
                      className="typeset-resizer-sync-btn sync-to-source"
                      title={copy.syncToSource}
                      aria-label={copy.syncToSource}
                      onClick={(event) => {
                        event.stopPropagation();
                        syncPdfToEditor();
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <ToolIcon name="syncToCode" />
                    </button>
                  </div>
                  <div className="typeset-resizer-grip upper" aria-hidden="true">
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                  </div>
                  <button
                    type="button"
                    className="typeset-resizer-collapse-btn"
                    title={copy.hidePdfPreview}
                    aria-label={copy.hidePdfPreview}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPdfPanelVisible(false);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <ToolIcon name="next" />
                  </button>
                  <div className="typeset-resizer-grip lower" aria-hidden="true">
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                    <span className="typeset-resizer-dot" />
                  </div>
                </div>
                <div className="typeset-preview-stack ide-redesign-pdf-container">
                  {isTypesetImagePath(previewPath) ? (
                    <TypesetImagePreview
                      path={previewPath}
                      refreshKey={refreshKey}
                      onBackToPdf={lastPdfPreviewPath ? () => setPreviewPath(lastPdfPreviewPath) : undefined}
                      onHide={() => setPdfPanelVisible(false)}
                    />
                  ) : (
                    <TypesetPdfPreview
                      path={previewPath}
                      sourcePath={sourcePath}
                      refreshKey={refreshKey}
                      status={compileStatus}
                      result={compileResult}
                      dirty={dirty}
                      disabled={!sourcePath || saving || loading}
                      logOpen={logOpen}
                      diagnosticsCount={diagnosticsCount}
                      continueOnError={compileErrorHandling === "continue"}
                      canCancel={Boolean(activeCompileRunId)}
                      onCompile={() => void compile()}
                      onCancelCompile={cancelCompile}
                      onClearCacheCompile={() => void compile(true)}
                      onSetContinueOnError={(value) => setCompileErrorHandlingPreference(value ? "continue" : "stop")}
                      engine={latexEngine}
                      compileOnSave={compileOnSave}
                      inverted={pdfInverted}
                      onSetEngine={setLatexEnginePreference}
                      onSetCompileOnSave={setCompileOnSavePreference}
                      onToggleInverted={togglePdfInverted}
                      onExportPdf={() => void exportPreviewPdf()}
                      onExportProject={() => void exportProjectArchive()}
                      onExportOutputFile={(file) => void exportOutputFile(file)}
                      onToggleLog={() => setLogOpen((open) => !open)}
                      onSourceTextClick={(text, context, position) => {
                        if (position) {
                          lastPdfPositionRef.current = { page: position.page, x: position.x, y: position.y, word: position.word };
                          openSourceForPdfPosition(position.page, position.x, position.y, text, context, position.word);
                        } else {
                          openSourceForPdfText(text, context);
                        }
                      }}
                      onHide={() => setPdfPanelVisible(false)}
                      forwardTarget={pdfForwardTarget}
                      forwardSearchNotice={forwardSearchNotice}
                    />
                  )}
                  {logOpen && !isTypesetImagePath(previewPath) && (
                    <CompileLog
                      result={compileResult}
                      status={compileStatus}
                      error={error}
                      liveLog={compileLiveLog}
                      disabled={!sourcePath || saving || loading}
                      onClearCacheCompile={() => void compile(true)}
                      onDiagnosticClick={openDiagnostic}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {historyOpen && sourcePath && (
        <TypesetHistoryPanel
          path={sourcePath}
          onClose={() => setHistoryOpen(false)}
          onBeforeSnapshot={async () => Boolean(await save())}
          onRestored={refreshAfterRevisionRestore}
          reviewPending={pendingChangeSets.length > 0}
        />
      )}
      {projectSearchOpen && (
        <TypesetProjectSearchPanel
          onClose={() => setProjectSearchOpen(false)}
          onOpenMatch={openProjectSearchMatch}
          onBeforeReplace={prepareProjectReplace}
          onReplaced={refreshAfterProjectReplace}
        />
      )}
      {commentsOpen && sourcePath && (
        <TypesetCommentsPanel
          path={sourcePath}
          source={draft}
          selection={commentSelection}
          onClose={() => setCommentsOpen(false)}
          onNavigate={(range) => {
            setCommentsOpen(false);
            openCodeRange(range.from, range.to);
          }}
        />
      )}
    </div>
  );
}
