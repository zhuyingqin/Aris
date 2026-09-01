// Pure tool-output interpreters extracted from ChatMessage.tsx. Everything
// here maps raw tool blocks / turns onto plain data — no React, no DOM — so it
// can be unit tested directly.
import type { ChatBlock, ChatTurn } from "../types";
// Type-only: erased at compile time, so this stays free of any React import.
import type { MarkdownEvidenceSource } from "./MarkdownContent";
import { isPreviewableImagePath } from "./ChatImagePreview";
import { isFileChangeTool, parseToolBlockJson, parseToolBlockObject } from "./model";
const MAX_TOOL_IMAGE_PREVIEWS = 6;
const MAX_TOOL_IMAGE_SCAN_CHARS = 8_000;
// Match any non-whitespace run ending in an image extension. The previous
// pattern used nested/overlapping quantifiers (`[A-Za-z0-9_.-]+(?:[\\/]...)*`
// inside an alternation) which caused CATASTROPHIC backtracking — a single
// slash/path-heavy tool output with no image extension could hang the main
// thread for minutes, freezing the whole conversation on open. A single greedy
// character class with one required suffix backtracks linearly, not
// exponentially, and still captures URLs, Windows/relative paths, and bare
// filenames.
const TOOL_IMAGE_PATH_RE = /[^\s"'`<>|]*\.(?:png|jpe?g|gif|webp|svg|bmp)(?::\d+(?::\d+)?)?/gi;

export interface FileChange {
  path: string;
  diff: string;
  changeId?: string;
}

export type ChatToolBlock = Extract<ChatBlock, { kind: "tool" }>;

interface EvidenceSearchItem {
  citation?: string;
  excerpt: string;
  sourceType: "confirmedKnowledge" | "originalPdfText";
}

interface EvidenceSearchSummary {
  query?: string;
  status?: string;
  items: EvidenceSearchItem[];
}

interface WebSearchCoverageSummary {
  totalHits?: number;
  fetched: number;
  unique: number;
  exhausted: boolean;
  nextCursor?: string;
  truncatedReason?: string;
}

interface WebSearchHitSummary {
  title: string;
  url: string;
  snippet?: string;
  provider?: string;
  rank?: number;
  sourceKind?: string;
  authorName?: string;
}

interface WebSearchAttemptSummary {
  provider: string;
  status: string;
  fetched: number;
  unique: number;
  exhausted: boolean;
  truncatedReason?: string;
  error?: string;
}

interface WebSearchRetrievalControlSummary {
  decisionOwner?: string;
  batchLimit?: number;
  hardBatchCeiling?: number;
  continuationAvailable: boolean;
  availableUnsearchedProviders: string[];
  recommendedAction?: string;
}

interface WebSearchToolSummary {
  query?: string;
  status?: string;
  provider?: string;
  maxResults?: number;
  cached: boolean;
  coverage: WebSearchCoverageSummary;
  retrievalControl?: WebSearchRetrievalControlSummary;
  attempts: WebSearchAttemptSummary[];
  hits: WebSearchHitSummary[];
  variants: Array<{ kind: string; query: string }>;
}

interface OracleWebToolSummary {
  kind: "consult" | "image";
  status?: string;
  sessionId?: string;
  output?: string;
  imageCount: number;
}

// Diff construction can be expensive for completed writes. Stream updates use
// new block objects for in-flight changes, so a per-block WeakMap is safe and
// lets finished file cards be reused without retaining old conversations.
const fileDiffsByToolBlock = new WeakMap<ChatToolBlock, FileChange[]>();

export interface CountedFileChange extends FileChange {
  addedLines: number;
  removedLines: number;
  sourceTool: string;
  toolUseId?: string;
}

export interface TurnFileSummary {
  path: string;
  addedLines: number;
  removedLines: number;
  changes: CountedFileChange[];
}

export interface TurnFileChangeSummary {
  fileCount: number;
  addedLines: number;
  removedLines: number;
  files: TurnFileSummary[];
  changes: CountedFileChange[];
  changeIds: string[];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function citationFromPaperPage(paperId: unknown, page: unknown): string | undefined {
  const paper = nonEmptyString(paperId);
  if (!paper) return undefined;
  return typeof page === "number" && Number.isFinite(page)
    ? `[${paper} p.${page}]`
    : `[${paper}]`;
}

/**
 * Reads both the compact evidence contract and historical full diagnostic
 * results, so saved conversations become understandable without migration.
 */
export function evidenceSearchSummaryFromTool(block: ChatToolBlock): EvidenceSearchSummary | null {
  if (block.name !== "ProjectEvidenceSearch") return null;
  const input = parseToolBlockObject(block, "input");
  const output = parseToolBlockObject(block, "output");
  const query = nonEmptyString(output?.query) ?? nonEmptyString(input?.query);
  const status = nonEmptyString(output?.status);
  const items: EvidenceSearchItem[] = [];

  const confirmedKnowledge = Array.isArray(output?.confirmedKnowledge)
    ? output.confirmedKnowledge
    : [];
  for (const raw of confirmedKnowledge) {
    const item = objectValue(raw);
    if (!item) continue;
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    const firstEvidence = objectValue(evidence[0]);
    const excerpt = nonEmptyString(item.statement);
    if (!excerpt) continue;
    items.push({
      citation: nonEmptyString(firstEvidence?.citation),
      excerpt,
      sourceType: "confirmedKnowledge",
    });
  }

  const pdfEvidence = Array.isArray(output?.pdfEvidence) ? output.pdfEvidence : [];
  for (const raw of pdfEvidence) {
    const item = objectValue(raw);
    if (!item) continue;
    const excerpt = nonEmptyString(item.excerpt);
    if (!excerpt) continue;
    items.push({
      citation: nonEmptyString(item.citation)
        ?? citationFromPaperPage(item.paperId, item.pageStart),
      excerpt,
      sourceType: "originalPdfText",
    });
  }

  // Older saved sessions contain the complete ProjectRagSearchResponse.
  if (items.length === 0) {
    const knowledge = objectValue(output?.knowledge);
    const results = Array.isArray(knowledge?.results) ? knowledge.results : [];
    for (const raw of results) {
      const hit = objectValue(raw);
      const point = objectValue(hit?.knowledge);
      const excerpt = nonEmptyString(point?.statement) ?? nonEmptyString(point?.answer);
      if (!excerpt) continue;
      const evidence = Array.isArray(point?.evidence) ? point.evidence : [];
      const firstEvidence = objectValue(evidence[0]);
      items.push({
        citation: citationFromPaperPage(firstEvidence?.paperId, firstEvidence?.page),
        excerpt,
        sourceType: "confirmedKnowledge",
      });
    }
    const literature = objectValue(output?.literature);
    const literatureResults = Array.isArray(literature?.results) ? literature.results : [];
    for (const raw of literatureResults) {
      const hit = objectValue(raw);
      const chunk = objectValue(hit?.chunk);
      const excerpt = nonEmptyString(chunk?.text);
      if (!excerpt) continue;
      items.push({
        citation: citationFromPaperPage(chunk?.paperId, chunk?.pageStart),
        excerpt,
        sourceType: "originalPdfText",
      });
    }
  }

  return { query, status, items };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function webSearchSummaryFromTool(block: ChatToolBlock): WebSearchToolSummary | null {
  if (block.name !== "WebSearch" || block.output === undefined) return null;
  const input = parseToolBlockObject(block, "input");
  const output = parseToolBlockObject(block, "output");
  if (!output) return null;
  const coverage = objectValue(output.coverage);
  const retrievalControl = objectValue(output.retrievalControl);
  const attempts = Array.isArray(output.sourceAttempts)
    ? output.sourceAttempts.flatMap((raw): WebSearchAttemptSummary[] => {
      const attempt = objectValue(raw);
      const attemptCoverage = objectValue(attempt?.coverage);
      const provider = nonEmptyString(attempt?.provider);
      if (!attempt || !attemptCoverage || !provider) return [];
      return [{
        provider,
        status: nonEmptyString(attempt.status) ?? "unknown",
        fetched: finiteNumber(attemptCoverage.fetched) ?? 0,
        unique: finiteNumber(attemptCoverage.unique) ?? 0,
        exhausted: attemptCoverage.exhausted === true,
        truncatedReason: nonEmptyString(attemptCoverage.truncatedReason),
        error: nonEmptyString(attempt.error),
      }];
    })
    : [];
  const resultBlocks = Array.isArray(output.results) ? output.results : [];
  const hits = resultBlocks.flatMap((raw): WebSearchHitSummary[] => {
    const blockValue = objectValue(raw);
    const content = Array.isArray(blockValue?.content) ? blockValue.content : [];
    return content.flatMap((item): WebSearchHitSummary[] => {
      const hit = objectValue(item);
      const sourceMetadata = objectValue(hit?.sourceMetadata);
      const title = nonEmptyString(hit?.title);
      const url = nonEmptyString(hit?.url);
      if (!hit || !title || !url || !/^https?:\/\//i.test(url)) return [];
      return [{
        title,
        url,
        snippet: nonEmptyString(hit.snippet),
        provider: nonEmptyString(hit.provider),
        rank: finiteNumber(hit.rank),
        sourceKind: nonEmptyString(sourceMetadata?.sourceKind),
        authorName: nonEmptyString(sourceMetadata?.authorName),
      }];
    });
  });
  const variants = Array.isArray(output.queryVariants)
    ? output.queryVariants.flatMap((raw): Array<{ kind: string; query: string }> => {
      const variant = objectValue(raw);
      const kind = nonEmptyString(variant?.kind);
      const query = nonEmptyString(variant?.query);
      return kind && query ? [{ kind, query }] : [];
    })
    : [];
  return {
    query: nonEmptyString(output.query) ?? nonEmptyString(input?.query),
    status: nonEmptyString(output.status),
    provider: nonEmptyString(output.provider),
    maxResults: finiteNumber(output.maxResults),
    cached: output.cached === true,
    coverage: {
      totalHits: finiteNumber(coverage?.totalHits),
      fetched: finiteNumber(coverage?.fetched) ?? 0,
      unique: finiteNumber(coverage?.unique) ?? hits.length,
      exhausted: coverage?.exhausted === true,
      nextCursor: nonEmptyString(coverage?.nextCursor),
      truncatedReason: nonEmptyString(coverage?.truncatedReason),
    },
    retrievalControl: retrievalControl
      ? {
        decisionOwner: nonEmptyString(retrievalControl.decisionOwner),
        batchLimit: finiteNumber(retrievalControl.batchLimit),
        hardBatchCeiling: finiteNumber(retrievalControl.hardBatchCeiling),
        continuationAvailable: retrievalControl.continuationAvailable === true,
        availableUnsearchedProviders: Array.isArray(
          retrievalControl.availableUnsearchedProviders,
        )
          ? retrievalControl.availableUnsearchedProviders.flatMap((provider) => {
            const value = nonEmptyString(provider);
            return value ? [value] : [];
          })
          : [],
        recommendedAction: nonEmptyString(retrievalControl.recommendedAction),
      }
      : undefined,
    attempts,
    hits,
    variants,
  };
}

export function oracleWebSummaryFromTool(block: ChatToolBlock): OracleWebToolSummary | null {
  if (block.name !== "ChatGptWebConsult" && block.name !== "ChatGptWebImage") return null;
  const output = parseToolBlockObject(block, "output");
  const images = Array.isArray(output?.images) ? output.images : [];
  return {
    kind: block.name === "ChatGptWebImage" ? "image" : "consult",
    status: nonEmptyString(output?.status),
    sessionId: nonEmptyString(output?.sessionId),
    output: nonEmptyString(output?.output)
      ?? (block.isError ? nonEmptyString(block.output) : undefined),
    imageCount: images.length,
  };
}

export function evidenceSourcesFromTool(block: ChatToolBlock): MarkdownEvidenceSource[] {
  if (block.name !== "ProjectEvidenceSearch") return [];
  const output = parseToolBlockObject(block, "output");
  if (!output) return [];
  const sources = new Map<string, MarkdownEvidenceSource>();
  const pdfPaths = new Map<string, string>();
  const addSource = ({
    paperId,
    page,
    pdfPath,
    citation,
    quote,
  }: {
    paperId: unknown;
    page: unknown;
    pdfPath: unknown;
    citation?: unknown;
    quote?: unknown;
  }) => {
    const normalizedPaperId = nonEmptyString(paperId);
    const normalizedPath = nonEmptyString(pdfPath);
    if (
      !normalizedPaperId
      || !normalizedPath
      || typeof page !== "number"
      || !Number.isFinite(page)
    ) return;
    const normalizedPage = Math.max(1, Math.trunc(page));
    const key = `${normalizedPaperId}\u0000${normalizedPage}\u0000${normalizedPath}`;
    const normalizedQuote = nonEmptyString(quote);
    const current = sources.get(key);
    if (current) {
      if (normalizedQuote && !current.quotes.includes(normalizedQuote)) {
        current.quotes.push(normalizedQuote);
      }
      return;
    }
    sources.set(key, {
      paperId: normalizedPaperId,
      page: normalizedPage,
      pdfPath: normalizedPath,
      citation: nonEmptyString(citation) ?? `[${normalizedPaperId} p.${normalizedPage}]`,
      quotes: normalizedQuote ? [normalizedQuote] : [],
    });
  };

  const pdfEvidence = Array.isArray(output.pdfEvidence) ? output.pdfEvidence : [];
  for (const raw of pdfEvidence) {
    const item = objectValue(raw);
    if (!item) continue;
    const paperId = nonEmptyString(item.paperId);
    const pdfPath = nonEmptyString(item.pdfPath);
    if (paperId && pdfPath) pdfPaths.set(paperId, pdfPath);
  }

  // Historical tool output stores the path on each literature chunk.
  const legacyLiterature = objectValue(output.literature);
  const legacyResults = Array.isArray(legacyLiterature?.results) ? legacyLiterature.results : [];
  for (const raw of legacyResults) {
    const hit = objectValue(raw);
    const chunk = objectValue(hit?.chunk);
    const paperId = nonEmptyString(chunk?.paperId);
    const pdfPath = nonEmptyString(chunk?.relativePath);
    if (paperId && pdfPath) pdfPaths.set(paperId, pdfPath);
  }

  const confirmedKnowledge = Array.isArray(output.confirmedKnowledge)
    ? output.confirmedKnowledge
    : [];
  for (const raw of confirmedKnowledge) {
    const item = objectValue(raw);
    const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
    for (const rawEvidence of evidence) {
      const source = objectValue(rawEvidence);
      const paperId = nonEmptyString(source?.paperId);
      addSource({
        paperId,
        page: source?.page,
        pdfPath: source?.pdfPath ?? (paperId ? pdfPaths.get(paperId) : undefined),
        citation: source?.citation,
        quote: source?.quote,
      });
    }
  }
  for (const raw of pdfEvidence) {
    const item = objectValue(raw);
    addSource({
      paperId: item?.paperId,
      page: item?.pageStart,
      pdfPath: item?.pdfPath,
      citation: item?.citation,
      quote: item?.highlightQuote ?? item?.excerpt,
    });
  }

  const legacyKnowledge = objectValue(output.knowledge);
  const legacyKnowledgeResults = Array.isArray(legacyKnowledge?.results)
    ? legacyKnowledge.results
    : [];
  for (const raw of legacyKnowledgeResults) {
    const hit = objectValue(raw);
    const point = objectValue(hit?.knowledge);
    const evidence = Array.isArray(point?.evidence) ? point.evidence : [];
    for (const rawEvidence of evidence) {
      const source = objectValue(rawEvidence);
      const paperId = nonEmptyString(source?.paperId);
      addSource({
        paperId,
        page: source?.page,
        pdfPath: paperId ? pdfPaths.get(paperId) : undefined,
        quote: source?.quote,
      });
    }
  }
  for (const raw of legacyResults) {
    const hit = objectValue(raw);
    const chunk = objectValue(hit?.chunk);
    addSource({
      paperId: chunk?.paperId,
      page: chunk?.pageStart,
      pdfPath: chunk?.relativePath,
      quote: chunk?.text,
    });
  }

  return Array.from(sources.values());
}

function attachChangeId(change: Omit<FileChange, "changeId">, changeId?: string): FileChange {
  return changeId ? { ...change, changeId } : change;
}

function changeIdFromOutput(output: Record<string, unknown> | null): string | undefined {
  return nonEmptyString(output?.changeId) ?? nonEmptyString(output?.change_id);
}

function diffLineStats(diff: string): Pick<CountedFileChange, "addedLines" | "removedLines"> {
  let addedLines = 0;
  let removedLines = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
  }
  return { addedLines, removedLines };
}

export function formatCount(value: number, sign: "+" | "-") {
  return `${sign}${value.toLocaleString()}`;
}

function cleanImageCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[([{<]+/, "")
    .replace(/[)\],.;]+$/, "");
}

function addImagePath(candidate: string, paths: string[], seen: Set<string>) {
  const path = cleanImageCandidate(candidate);
  if (!isPreviewableImagePath(path) || seen.has(path) || paths.length >= MAX_TOOL_IMAGE_PREVIEWS) return;
  seen.add(path);
  paths.push(path);
}

function collectImagePathsFromText(text: string, paths: string[], seen: Set<string>) {
  const excerpt = text.slice(0, MAX_TOOL_IMAGE_SCAN_CHARS);
  TOOL_IMAGE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOOL_IMAGE_PATH_RE.exec(excerpt)) !== null) {
    addImagePath(match[0], paths, seen);
    if (paths.length >= MAX_TOOL_IMAGE_PREVIEWS) return;
  }
}

function collectImagePathsFromValue(value: unknown, paths: string[], seen: Set<string>, depth = 0) {
  if (paths.length >= MAX_TOOL_IMAGE_PREVIEWS || depth > 5 || value === null || value === undefined) return;
  if (typeof value === "string") {
    collectImagePathsFromText(value, paths, seen);
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectImagePathsFromValue(item, paths, seen, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    collectImagePathsFromText(key, paths, seen);
    collectImagePathsFromValue(item, paths, seen, depth + 1);
    if (paths.length >= MAX_TOOL_IMAGE_PREVIEWS) return;
  }
}

export function imagePathsFromTool(
  block: Extract<ChatBlock, { kind: "tool" }>,
  change: FileChange | null,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  // Oracle image output includes the final project artifact in `images`, while
  // its verbose `output` text can also mention the browser-profile source file.
  // Those two paths contain the same pixels. Only project the canonical result
  // so one generation appears once, and never render input reference images as
  // though they were newly generated while the tool is still running.
  if (block.name === "ChatGptWebImage") {
    const output = parseToolBlockObject(block, "output");
    const images = Array.isArray(output?.images) ? output.images : [];
    for (const image of images) {
      if (typeof image === "string") {
        addImagePath(image, paths, seen);
        continue;
      }
      const value = objectValue(image);
      const path = nonEmptyString(value?.path)
        ?? nonEmptyString(value?.url)
        ?? nonEmptyString(value?.src);
      if (path) addImagePath(path, paths, seen);
    }
    return paths;
  }

  if (change) addImagePath(change.path, paths, seen);

  // Shell output often repeats paths from a preceding structured image tool
  // (for example when copying the generated artifact into a figures folder).
  // Keep the path in the auditable tool body, but do not create another image
  // preview from incidental command/log text.
  if (block.name === "bash") return paths;

  collectImagePathsFromValue(parseToolBlockJson(block, "output"), paths, seen);
  if (block.output) collectImagePathsFromText(block.output, paths, seen);
  return paths;
}

function diffsFromCodexChanges(output: Record<string, unknown> | null): FileChange[] {
  const changes = output?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  const outputChangeId = changeIdFromOutput(output);
  const parsed: FileChange[] = [];
  for (const [path, rawChange] of Object.entries(changes as Record<string, unknown>)) {
    if (!path || !rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) continue;
    const change = rawChange as Record<string, unknown>;
    const changeId =
      nonEmptyString(change.changeId) ?? nonEmptyString(change.change_id) ?? outputChangeId;
    const type = typeof change.type === "string" ? change.type : "";
    if (type === "update") {
      const diff = typeof change.unified_diff === "string" ? change.unified_diff : "";
      if (diff) parsed.push(attachChangeId({ path, diff }, changeId));
      continue;
    }
    if (type === "add") {
      const content = typeof change.content === "string" ? change.content : "";
      parsed.push(attachChangeId({
        path,
        diff: [`--- /dev/null`, `+++ ${path}`, ...content.split("\n").map((line) => `+${line}`)].join("\n"),
      }, changeId));
      continue;
    }
    if (type === "delete") {
      const content = typeof change.content === "string" ? change.content : "";
      parsed.push(attachChangeId({
        path,
        diff: [`--- ${path}`, `+++ /dev/null`, ...content.split("\n").map((line) => `-${line}`)].join("\n"),
      }, changeId));
    }
  }
  return parsed;
}

function notebookDiffFromTool(
  input: Record<string, unknown>,
  output: Record<string, unknown> | null,
  path: string,
  changeId?: string,
): FileChange[] {
  const mode = String(output?.edit_mode ?? input.edit_mode ?? "replace");
  const cellId = String(output?.cell_id ?? input.cell_id ?? "new cell");
  const oldSource = typeof input.old_source === "string" ? input.old_source : "";
  const newSource = mode === "delete"
    ? ""
    : String(input.new_source ?? output?.new_source ?? "");
  const removed = oldSource
    ? oldSource.split("\n").map((line) => `-${line}`)
    : mode === "delete" ? [`- [cell ${cellId} deleted]`] : [];
  const added = newSource
    ? newSource.split("\n").map((line) => `+${line}`)
    : mode === "delete" ? [] : [`+ [cell ${cellId} ${mode}]`];
  return [attachChangeId({
    path,
    diff: [
      `--- ${path} (cell ${cellId})`,
      `+++ ${path} (cell ${cellId})`,
      ...removed,
      ...added,
    ].join("\n"),
  }, changeId)];
}

function diffsFromTool(block: ChatToolBlock): FileChange[] {
  if (!isFileChangeTool(block.name) || block.isError) return [];
  if (block.output !== undefined) {
    const cached = fileDiffsByToolBlock.get(block);
    if (cached) return cached;
  }

  const output = parseToolBlockObject(block, "output");
  const codexChanges = diffsFromCodexChanges(output);
  if (codexChanges.length > 0) {
    if (block.output !== undefined) fileDiffsByToolBlock.set(block, codexChanges);
    return codexChanges;
  }

  const input = parseToolBlockObject(block, "input") ?? {};
  const path = String(
    output?.filePath
      ?? output?.notebookPath
      ?? output?.notebook_path
      ?? input.path
      ?? input.file_path
      ?? input.target_file
      ?? input.notebook_path
      ?? "",
  );
  if (!path) return [];
  const changeId = changeIdFromOutput(output);
  let changes: FileChange[];
  if (block.name === "NotebookEdit") {
    changes = notebookDiffFromTool(input, output, path, changeId);
  } else if (block.name === "write_file") {
    const content = String(input.content ?? "");
    changes = [attachChangeId({
      path,
      diff: [`--- /dev/null`, `+++ ${path}`, ...content.split("\n").map((line) => `+${line}`)].join("\n"),
    }, changeId)];
  } else if (block.name === "append_file") {
    const content = String(input.content ?? "");
    changes = [attachChangeId({
      path,
      diff: [`--- ${path}`, `+++ ${path}`, ...content.split("\n").map((line) => `+${line}`)].join("\n"),
    }, changeId)];
  } else if (block.name === "commit_large_write") {
    const summary = output?.diff_summary as Record<string, unknown> | undefined;
    const added = Number(summary?.addedLines ?? 0);
    const removed = Number(summary?.removedLines ?? 0);
    changes = [attachChangeId({
      path,
      diff: [
        `--- ${path}`,
        `+++ ${path}`,
        ` [atomic staged write committed: +${added} / -${removed} lines]`,
      ].join("\n"),
    }, changeId)];
  } else if (block.name === "edit_file" || block.name === "str_replace_based_edit_tool") {
    const before = String(input.old_string ?? input.old_str ?? input.old_text ?? "");
    const after = String(input.new_string ?? input.new_str ?? input.new_text ?? "");
    changes = [attachChangeId({
      path,
      diff: [
        `--- ${path}`,
        `+++ ${path}`,
        ...before.split("\n").map((line) => `-${line}`),
        ...after.split("\n").map((line) => `+${line}`),
      ].join("\n"),
    }, changeId)];
  } else {
    changes = [];
  }

  if (block.output !== undefined) fileDiffsByToolBlock.set(block, changes);
  return changes;
}

export function diffFromTool(block: ChatToolBlock): FileChange | null {
  return diffsFromTool(block)[0] ?? null;
}

export function fileChangesFromTurn(turn: ChatTurn): TurnFileChangeSummary | null {
  if (turn.role !== "assistant") return null;
  const files = new Map<string, TurnFileSummary>();
  const changes: CountedFileChange[] = [];
  const changeIds: string[] = [];
  const seenChangeIds = new Set<string>();

  for (const block of turn.blocks) {
    if (block.kind !== "tool" || block.output === undefined) continue;
    for (const change of diffsFromTool(block)) {
      const counted: CountedFileChange = {
        ...change,
        ...diffLineStats(change.diff),
        sourceTool: block.name,
        toolUseId: block.id,
      };
      changes.push(counted);
      if (counted.changeId && !seenChangeIds.has(counted.changeId)) {
        seenChangeIds.add(counted.changeId);
        changeIds.push(counted.changeId);
      }
      const existing = files.get(counted.path) ?? {
        path: counted.path,
        addedLines: 0,
        removedLines: 0,
        changes: [],
      };
      existing.addedLines += counted.addedLines;
      existing.removedLines += counted.removedLines;
      existing.changes.push(counted);
      files.set(counted.path, existing);
    }
  }

  if (changes.length === 0) return null;
  return {
    fileCount: files.size,
    addedLines: changes.reduce((total, change) => total + change.addedLines, 0),
    removedLines: changes.reduce((total, change) => total + change.removedLines, 0),
    files: Array.from(files.values()),
    changes,
    changeIds,
  };
}

export function fileChangeSummaryFromTurns(turns: ChatTurn[]): TurnFileChangeSummary | null {
  let start = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === "user") {
      start = index;
      break;
    }
  }

  const files = new Map<string, TurnFileSummary>();
  const changes: CountedFileChange[] = [];
  const changeIds: string[] = [];
  const seenChangeIds = new Set<string>();
  for (const turn of turns.slice(start)) {
    const summary = fileChangesFromTurn(turn);
    if (!summary) continue;
    for (const change of summary.changes) {
      changes.push(change);
      if (change.changeId && !seenChangeIds.has(change.changeId)) {
        seenChangeIds.add(change.changeId);
        changeIds.push(change.changeId);
      }
      const existing = files.get(change.path) ?? {
        path: change.path,
        addedLines: 0,
        removedLines: 0,
        changes: [],
      };
      existing.addedLines += change.addedLines;
      existing.removedLines += change.removedLines;
      existing.changes.push(change);
      files.set(change.path, existing);
    }
  }

  if (changes.length === 0) return null;
  return {
    fileCount: files.size,
    addedLines: changes.reduce((total, change) => total + change.addedLines, 0),
    removedLines: changes.reduce((total, change) => total + change.removedLines, 0),
    files: Array.from(files.values()),
    changes,
    changeIds,
  };
}
