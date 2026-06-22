import type {
  ChatBlock,
  ChatFileChange,
  ChatFileChangeStatus,
  ChatTodoItem,
  ChatTodoStatus,
  ChatTurn,
  DesktopProject,
} from "../types";
import type { ChatSession } from "./types";

export const SESSIONS_KEY = "aris-chat-sessions-v2";
export const CURRENT_KEY = "aris-chat-current-id";

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeSession(projectId = "default"): ChatSession {
  const now = Date.now();
  return {
    id: makeId("chat"),
    projectId,
    title: "New chat",
    model: null,
    turns: [],
    draft: "",
    draftAttachments: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function migrateTurn(raw: Partial<ChatTurn> & Record<string, unknown>): ChatTurn {
  const blocks = Array.isArray(raw.blocks) ? raw.blocks as ChatBlock[] : [];
  if (blocks.length === 0 && typeof raw.text === "string" && raw.text.trim()) {
    blocks.push({ kind: "text", text: raw.text });
  }
  if (Array.isArray(raw.tools)) {
    for (const tool of raw.tools as Record<string, unknown>[]) {
      blocks.push({
        kind: "tool",
        id: typeof tool.id === "string" ? tool.id : undefined,
        name: String(tool.name ?? "tool"),
        input: String(tool.input ?? "{}"),
        output: typeof tool.output === "string" ? tool.output : undefined,
        isError: Boolean(tool.isError),
      });
    }
  }
  return {
    id: typeof raw.id === "string" ? raw.id : makeId("turn"),
    role: raw.role === "assistant" ? "assistant" : "user",
    blocks,
    streaming: false,
    error: typeof raw.error === "string" ? raw.error : undefined,
    stopped: Boolean(raw.stopped),
    attachments: Array.isArray(raw.attachments) ? raw.attachments : undefined,
  };
}

export function migrateSession(raw: Partial<ChatSession>, fallbackProjectId = "default"): ChatSession {
  const now = Date.now();
  const turns = Array.isArray(raw.turns)
    ? raw.turns.map((turn) => migrateTurn(turn as Partial<ChatTurn> & Record<string, unknown>))
    : [];
  const rawTitle = typeof raw.title === "string" ? raw.title : "";
  const cleanedTitle = cleanChatTitle(rawTitle);
  const title = cleanedTitle && cleanedTitle !== "New chat" ? cleanedTitle : titleFromTurns(turns);
  return {
    id: raw.id || makeId("chat"),
    projectId: raw.projectId || fallbackProjectId,
    title,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model : null,
    turns,
    draft: raw.draft || "",
    draftAttachments: Array.isArray(raw.draftAttachments) ? raw.draftAttachments : [],
    pinned: Boolean(raw.pinned),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
  };
}

export function textFromTurn(turn: ChatTurn): string {
  return turn.blocks
    .filter((block): block is Extract<ChatBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("\n");
}

export function transcriptFromTurn(turn: ChatTurn): string {
  const sections: string[] = [];
  for (const block of turn.blocks) {
    if (block.kind === "text") {
      if (block.text.trim()) sections.push(block.text);
      continue;
    }
    if (block.kind === "tool") {
      const label = block.id ? `${block.name} (${block.id})` : block.name;
      const parts = [`[Tool call: ${label}]`];
      if (block.input && block.input !== "{}") parts.push(block.input);
      if (block.output !== undefined) {
        parts.push(`[Tool result: ${block.name}${block.isError ? " failed" : ""}]`);
        if (block.output.trim()) parts.push(block.output);
      } else {
        parts.push(`[Tool result: ${block.name} interrupted before output]`);
      }
      sections.push(parts.join("\n"));
    }
  }
  return sections.join("\n\n");
}

function stripReasoningMarkup(value: string): string {
  let output = "";
  let rest = value;
  while (rest) {
    const lower = rest.toLowerCase();
    const start = lower.indexOf("<think");
    if (start < 0) {
      output += rest;
      break;
    }
    output += rest.slice(0, start);
    const openEnd = lower.indexOf(">", start);
    if (openEnd < 0) break;
    const bodyStart = openEnd + 1;
    const remaining = lower.slice(bodyStart);
    const closeThink = remaining.indexOf("</think>");
    const closeThinking = remaining.indexOf("</thinking>");
    const candidates = [
      closeThink >= 0 ? { index: closeThink, length: "</think>".length } : null,
      closeThinking >= 0 ? { index: closeThinking, length: "</thinking>".length } : null,
    ].filter((item): item is { index: number; length: number } => item !== null);
    if (candidates.length === 0) break;
    const close = candidates.reduce((best, item) => item.index < best.index ? item : best);
    rest = rest.slice(bodyStart + close.index + close.length);
  }
  return output;
}

function isUnusableChatTitle(value: string): boolean {
  const lower = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (!lower) return true;
  if ([
    "new chat",
    "untitled",
    "no title",
    "no subject",
    "(no subject)",
    "无标题",
    "无主题",
  ].includes(lower)) return true;
  if (lower.startsWith("<think") || lower.includes("</think")) return true;
  return [
    /^the user (asked|asks|requested|wants|wanted)\b/,
    /^user (asked|asks|requested|wants|wanted)\b/,
    /^chat (title|summary|conversation)\b/,
    /^conversation (title|summary)\b/,
    /^the conversation\b/,
    /^this chat\b/,
  ].some((pattern) => pattern.test(lower));
}

export function cleanChatTitle(raw: string): string {
  let title = stripReasoningMarkup(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  title = title.replace(/^(?:title|\u6807\u9898)\s*[:\uff1a]\s*/i, "");
  title = title
    .replace(/^[\s"'`*#[\]():;.,!?_\-\u300c\u300d\u201c\u201d\u300a\u300b\u3002\uff0c\uff01\uff1f\uff1a\uff1b]+/, "")
    .replace(/[\s"'`*#[\]():;.,!?_\-\u300c\u300d\u201c\u201d\u300a\u300b\u3002\uff0c\uff01\uff1f\uff1a\uff1b]+$/, "")
    .replace(/\s+/g, " ");
  title = [...title].slice(0, 48).join("");
  return isUnusableChatTitle(title) ? "" : title;
}

const TODO_STATUSES: ChatTodoStatus[] = ["pending", "in_progress", "completed"];
const FILE_CHANGE_TOOL_NAMES = new Set([
  "write_file",
  "append_file",
  "edit_file",
  "str_replace_based_edit_tool",
  "NotebookEdit",
]);
const SHELL_TOOL_NAMES = new Set(["bash", "PowerShell"]);

function parseTodoList(input: string): ChatTodoItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  const raw = (parsed as { todos?: unknown })?.todos;
  if (!Array.isArray(raw)) return null;
  const todos: ChatTodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const content = typeof value.content === "string" ? value.content : "";
    if (!content) continue;
    const activeForm = typeof value.activeForm === "string" && value.activeForm ? value.activeForm : content;
    const status = TODO_STATUSES.includes(value.status as ChatTodoStatus)
      ? (value.status as ChatTodoStatus)
      : "pending";
    todos.push({ content, activeForm, status });
  }
  return todos;
}

// The latest TodoWrite plan for the current user request drives the floating
// workflow box. The model emits a fresh full list on every update, so the last
// call in the current turn wins.
export function latestTodosFromTurns(turns: ChatTurn[]): ChatTodoItem[] {
  const start = latestUserTurnIndex(turns);
  for (let turnIndex = turns.length - 1; turnIndex >= start; turnIndex -= 1) {
    const blocks = turns[turnIndex].blocks;
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (block.kind !== "tool" || block.name !== "TodoWrite") continue;
      const todos = parseTodoList(block.input);
      if (todos && todos.length > 0) return todos;
    }
  }
  return [];
}

function parseJsonObject(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function normalizeFileChangePath(path: string, projectRoot?: string | null): string {
  const trimmed = path.trim().replace(/^[`"'<]+|[`"'>]+$/g, "");
  if (!trimmed) return "";
  const normalized = trimmed.replace(/\\/g, "/");
  const root = projectRoot?.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (root) {
    const lowerPath = normalized.toLowerCase();
    const lowerRoot = root.toLowerCase();
    if (lowerPath === lowerRoot) return ".";
    if (lowerPath.startsWith(`${lowerRoot}/`)) return normalized.slice(root.length + 1);
  }
  return normalized.replace(/^\.\//, "");
}

function unquoteGitStatusPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "string" ? parsed : trimmed;
  } catch {
    return trimmed.slice(1, -1);
  }
}

function statusFromGitCode(code: string): ChatFileChangeStatus | null {
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A") || code === "??") return "added";
  if (code.includes("M")) return "modified";
  return null;
}

function parseGitStatusChanges(output: string, projectRoot?: string | null): ChatFileChange[] {
  const changes: ChatFileChange[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const match = rawLine.match(/^(.{2})\s+(.+)$/);
    if (!match) continue;
    const code = match[1];
    if (code === "!!") continue;
    const status = statusFromGitCode(code);
    if (!status) continue;
    const rawPath = match[2].includes(" -> ")
      ? match[2].split(" -> ").pop() ?? match[2]
      : match[2];
    const path = normalizeFileChangePath(unquoteGitStatusPath(rawPath), projectRoot);
    if (path) changes.push({ path, status, sourceTool: "git status" });
  }
  return changes;
}

function toolInputPath(input: Record<string, unknown> | null): string | null {
  return stringField(input, ["path", "file_path", "target_file", "notebook_path"]);
}

function statusFromCodexChangeType(change: Record<string, unknown>): ChatFileChangeStatus | null {
  const type = typeof change.type === "string" ? change.type : "";
  if (type === "add") return "added";
  if (type === "delete") return "deleted";
  if (type === "update") return typeof change.move_path === "string" && change.move_path.trim()
    ? "renamed"
    : "modified";
  return null;
}

function changesFromCodexOutput(
  output: Record<string, unknown> | null,
  sourceTool: string,
  projectRoot?: string | null,
): ChatFileChange[] {
  const rawChanges = output?.changes;
  if (!rawChanges || typeof rawChanges !== "object" || Array.isArray(rawChanges)) return [];
  const changes: ChatFileChange[] = [];
  for (const [rawPath, rawChange] of Object.entries(rawChanges as Record<string, unknown>)) {
    if (!rawPath || !rawChange || typeof rawChange !== "object" || Array.isArray(rawChange)) continue;
    const change = rawChange as Record<string, unknown>;
    const status = statusFromCodexChangeType(change);
    if (!status) continue;
    const path = normalizeFileChangePath(
      typeof change.move_path === "string" && change.move_path.trim() ? change.move_path : rawPath,
      projectRoot,
    );
    if (path) changes.push({ path, status, sourceTool });
  }
  return changes;
}

function changesFromWriteTool(
  block: Extract<ChatBlock, { kind: "tool" }>,
  projectRoot?: string | null,
): ChatFileChange[] {
  if (!FILE_CHANGE_TOOL_NAMES.has(block.name) || block.isError || block.output === undefined) return [];
  const input = parseJsonObject(block.input);
  const output = parseJsonObject(block.output);
  const codexChanges = changesFromCodexOutput(output, block.name, projectRoot);
  if (codexChanges.length > 0) return codexChanges;

  const outputPath = stringField(output, ["filePath", "path", "target_file", "notebook_path"]);
  const path = normalizeFileChangePath(outputPath ?? toolInputPath(input) ?? "", projectRoot);
  if (!path) return [];

  const outputKind = stringField(output, ["type"]);
  const created = output?.created === true;
  const status: ChatFileChangeStatus = (
    (block.name === "write_file" && outputKind === "create")
    || (block.name === "append_file" && created)
  )
    ? "added"
    : "modified";
  return [{ path, status, sourceTool: block.name }];
}

function changesFromShellTool(
  block: Extract<ChatBlock, { kind: "tool" }>,
  projectRoot?: string | null,
): ChatFileChange[] {
  if (!SHELL_TOOL_NAMES.has(block.name) || block.isError || block.output === undefined) return [];
  const input = parseJsonObject(block.input);
  const command = stringField(input, ["command"]) ?? "";
  if (!/\bgit\b[^\r\n;&|]*\bstatus\b/i.test(command) || !/(?:--short|\s-s\b|--porcelain)/i.test(command)) {
    return [];
  }
  const output = parseJsonObject(block.output);
  const stdout = stringField(output, ["stdout"]) ?? block.output;
  return parseGitStatusChanges(stdout, projectRoot);
}

function mergedStatus(
  previous: ChatFileChangeStatus | undefined,
  next: ChatFileChangeStatus,
): ChatFileChangeStatus {
  if (next === "deleted" || next === "renamed") return next;
  if (previous === "added" && next === "modified") return "added";
  return next;
}

function rememberFileChange(changes: Map<string, ChatFileChange>, next: ChatFileChange) {
  const previous = changes.get(next.path);
  changes.set(next.path, {
    ...previous,
    ...next,
    status: mergedStatus(previous?.status, next.status),
  });
}

function latestUserTurnIndex(turns: ChatTurn[]): number {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index].role === "user") return index;
  }
  return 0;
}

// File changes are scoped to the latest user request. That keeps the floating
// panel focused on "this turn" instead of accumulating old session history.
export function latestFileChangesFromTurns(
  turns: ChatTurn[],
  projectRoot?: string | null,
): ChatFileChange[] {
  const changes = new Map<string, ChatFileChange>();
  const start = latestUserTurnIndex(turns);
  for (const turn of turns.slice(start)) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks) {
      if (block.kind !== "tool") continue;
      for (const direct of changesFromWriteTool(block, projectRoot)) {
        rememberFileChange(changes, direct);
      }
      for (const shellChange of changesFromShellTool(block, projectRoot)) {
        rememberFileChange(changes, shellChange);
      }
    }
  }
  return [...changes.values()];
}

function attachmentTitleFromTurn(turn: ChatTurn): string {
  const attachments = turn.attachments ?? [];
  if (attachments.length === 0) return "";
  const labels = attachments
    .map((attachment) => attachment.path || attachment.name)
    .filter(Boolean);
  if (labels.length === 0) return "";
  return labels.length === 1 ? labels[0] : `${labels[0]} + ${labels.length - 1} files`;
}

export function titleFromTurns(turns: ChatTurn[]): string {
  const first = turns.find((turn) => turn.role === "user");
  if (!first) return "New chat";
  const text = textFromTurn(first).trim();
  const candidates = [
    text === "Attached context" ? "" : text,
    attachmentTitleFromTurn(first),
    transcriptFromTurn(first).trim(),
  ];
  for (const candidate of candidates) {
    const title = cleanChatTitle(candidate);
    if (title) return title;
  }
  return "New chat";
}

export function appendTextDelta(blocks: ChatBlock[], delta: string): ChatBlock[] {
  const copy = blocks.slice();
  const last = copy[copy.length - 1];
  if (last?.kind === "text") copy[copy.length - 1] = { ...last, text: last.text + delta };
  else copy.push({ kind: "text", text: delta });
  return copy;
}

export function appendThinkingDelta(blocks: ChatBlock[], delta: string): ChatBlock[] {
  const copy = blocks.slice();
  const last = copy[copy.length - 1];
  if (last?.kind === "thinking") {
    copy[copy.length - 1] = { ...last, thinking: last.thinking + delta };
  } else {
    copy.push({ kind: "thinking", thinking: delta });
  }
  return copy;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().normalize("NFKD");
}

function compactSearchText(value: string): string {
  return value.replace(/[^a-z0-9]+/g, "");
}

function searchTokens(value: string): string[] {
  return value.split(/[^a-z0-9]+/).filter(Boolean);
}

function subsequenceScore(needle: string, haystack: string): number | null {
  let index = 0;
  let first = -1;
  let last = -1;
  let gaps = 0;
  for (let i = 0; i < haystack.length; i += 1) {
    if (haystack[i] !== needle[index]) continue;
    if (first < 0) first = i;
    if (last >= 0) gaps += i - last - 1;
    last = i;
    index += 1;
    if (index === needle.length) return 80 + first + gaps;
  }
  return null;
}

export function fuzzyScore(query: string, value: string): number | null {
  const needle = compactSearchText(normalizeSearchText(query.trim()));
  if (!needle) return 0;
  const haystack = normalizeSearchText(value);
  const compactHaystack = compactSearchText(haystack);
  if (!compactHaystack) return null;

  const tokens = searchTokens(haystack);
  const exactToken = tokens.findIndex((token) => token === needle);
  if (exactToken >= 0) return exactToken;

  const prefixToken = tokens.findIndex((token) => token.startsWith(needle));
  if (prefixToken >= 0) return 10 + prefixToken;

  const contiguous = compactHaystack.indexOf(needle);
  if (contiguous >= 0) return 30 + contiguous;

  const acronym = tokens.map((token) => token[0]).join("");
  if (acronym.startsWith(needle)) return 45;

  return subsequenceScore(needle, compactHaystack);
}

export function fuzzyMatch(query: string, value: string): boolean {
  return fuzzyScore(query, value) !== null;
}

export type SessionGroup = { id: string; label: string; sessions: ChatSession[] };

export function groupSessionsByProject(
  sessions: ChatSession[],
  projects: DesktopProject[],
): SessionGroup[] {
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const order = new Map(projects.map((project, index) => [project.id, index]));
  const grouped = new Map<string, ChatSession[]>();
  for (const session of sessions) {
    const list = grouped.get(session.projectId) ?? [];
    list.push(session);
    grouped.set(session.projectId, list);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER))
    .map(([projectId, projectSessions]) => ({
      id: projectId,
      label: names.get(projectId) ?? (projectId === "default" ? "ARIS Desktop Workspace" : "Unknown project"),
      sessions: projectSessions.sort((left, right) =>
        Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt),
    }));
}
