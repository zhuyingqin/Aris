import type { ChatBlock, ChatTurn, DesktopProject } from "../types";
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
  return {
    id: raw.id || makeId("chat"),
    projectId: raw.projectId || fallbackProjectId,
    title: raw.title || "New chat",
    turns: Array.isArray(raw.turns)
      ? raw.turns.map((turn) => migrateTurn(turn as Partial<ChatTurn> & Record<string, unknown>))
      : [],
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

export function titleFromTurns(turns: ChatTurn[]): string {
  const first = turns.find((turn) => turn.role === "user");
  const text = first ? textFromTurn(first).trim() : "";
  return text ? `${text.slice(0, 48)}${text.length > 48 ? "..." : ""}` : "New chat";
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

export function fuzzyMatch(query: string, value: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = value.toLowerCase();
  if (haystack.includes(needle)) return true;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
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
