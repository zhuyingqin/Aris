import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chatDelete,
  chatPermissionRespond,
  chatPermissionSet,
  chatQuestionRespond,
  isTauri,
  type ChatSendRequest,
} from "../api/tauri";
import { useStore } from "../store";
import type { ChatAttachment, ChatTurn, PermissionModeView } from "../types";
import ChatComposer from "./ChatComposer";
import ChatThread from "./ChatThread";
import {
  assistantTextTurn,
  assistantTurn,
  completedAssistantBlocks,
  outgoingMessage,
  userTurn,
  visibleTurnError,
} from "./chatRunHelpers";
import { makeId, patchLastAssistantTurn, textFromTurn } from "./model";
import type { SidePanelMetadata } from "./sidePanelFiles";
import { useChatStream } from "./useChatStream";

const READ_ONLY_PERMISSION: PermissionModeView = {
  mode: "read-only",
  label: "Plan",
  description: "Inspect and search only",
};

const SIDE_TASK_INSTRUCTION = `You are handling a temporary SomniQ side task.
The project workspace, durable mission, and current milestone are available in your system context. Do not assume or reconstruct the parent chat history.
This task is strictly read-only: inspect, search, reason, and report, but do not modify project files or external state.
Answer the user's side question directly and make the result easy to send back to the main task.`;

const SIDE_TASK_STATE_KEY = "somniq-side-task-state-v1";
const SIDE_TASK_MAX_STORED_TURNS = 40;

type StoredSideTaskState = {
  turns: ChatTurn[];
  input: string;
  lastResult: string;
};

function storedSideTaskKey(projectId: string, taskId: string): string {
  return `${SIDE_TASK_STATE_KEY}:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}`;
}

function readStoredSideTaskState(projectId: string, taskId: string): StoredSideTaskState {
  const empty: StoredSideTaskState = { turns: [], input: "", lastResult: "" };
  if (typeof window === "undefined") return empty;
  try {
    const parsed = JSON.parse(window.localStorage?.getItem(storedSideTaskKey(projectId, taskId)) ?? "null") as Partial<StoredSideTaskState> | null;
    if (!parsed) return empty;
    return {
      turns: Array.isArray(parsed.turns) ? parsed.turns.slice(-SIDE_TASK_MAX_STORED_TURNS) as ChatTurn[] : [],
      input: typeof parsed.input === "string" ? parsed.input : "",
      lastResult: typeof parsed.lastResult === "string" ? parsed.lastResult : "",
    };
  } catch {
    return empty;
  }
}

export function clearStoredSideTaskState(projectId: string, taskId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage?.removeItem(storedSideTaskKey(projectId, taskId));
}

function sideTaskTitle(turns: ChatTurn[], fallback: string): string {
  const firstQuestion = turns.find((turn) => turn.role === "user");
  const text = firstQuestion ? textFromTurn(firstQuestion).replace(/\s+/g, " ").trim() : "";
  if (!text) return fallback;
  return [...text].slice(0, 28).join("");
}

interface Props {
  taskId: string;
  initialTitle: string;
  projectId: string;
  model?: string | null;
  ready: boolean;
  onMetadataChange: (taskId: string, metadata: SidePanelMetadata) => void;
}

export default function SideTaskPanel({ taskId, initialTitle, projectId, model, ready, onMetadataChange }: Props) {
  const language = useStore((state) => state.language);
  const copy = language === "cn"
    ? {
      title: "侧边任务",
      emptyTitle: "处理一个旁路问题",
      emptyDescription: "继承当前项目上下文，但不会读取主聊天记录，也不会保存到项目。",
      preview: "浏览器预览中的侧边任务回复。",
      source: "临时侧边任务",
      starters: [
        { id: "locate", label: "定位代码", hint: "找到实现某个功能的位置", prompt: "在当前项目里定位实现以下功能的文件与函数，并说明调用关系：" },
        { id: "explain", label: "解释报错", hint: "读日志并给出可能原因", prompt: "阅读下面这段报错/日志，判断最可能的原因，并指出需要检查的文件：\n" },
        { id: "check", label: "核对事实", hint: "只读检索，不改动项目", prompt: "帮我核对一个说法是否与项目现状一致，并给出证据出处：" },
      ],
    }
    : {
      title: "Side task",
      emptyTitle: "Handle a question on the side",
      emptyDescription: "Uses project context without reading the main chat or saving into the project.",
      preview: "Side task response in browser preview.",
      source: "Temporary side task",
      starters: [
        { id: "locate", label: "Locate code", hint: "Find where something is implemented", prompt: "Locate the files and functions that implement the following in this project, and explain how they connect: " },
        { id: "explain", label: "Explain an error", hint: "Read the log, name likely causes", prompt: "Read this error/log, judge the most likely cause, and point to the files worth checking:\n" },
        { id: "check", label: "Check a claim", hint: "Read-only lookup, no edits", prompt: "Check whether the following claim matches the current project, and cite the evidence: " },
      ],
    };
  const initialStoredStateRef = useRef<StoredSideTaskState | null>(null);
  if (initialStoredStateRef.current === null) initialStoredStateRef.current = readStoredSideTaskState(projectId, taskId);
  const initialStoredState = initialStoredStateRef.current;
  const sessionIdRef = useRef(makeId("side-task"));
  const sessionId = sessionIdRef.current;
  const [turns, setTurns] = useState<ChatTurn[]>(initialStoredState.turns);
  const [input, setInput] = useState(initialStoredState.input);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [composerHeight, setComposerHeight] = useState(0);
  const focusRequest = 1;
  const [permissionReady, setPermissionReady] = useState(!isTauri());
  const [lastResult, setLastResult] = useState(initialStoredState.lastResult);
  const needsRestoreContextRef = useRef(initialStoredState.turns.length > 0);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const patchAssistant = useCallback((targetSessionId: string, fn: (turn: ChatTurn) => ChatTurn) => {
    if (targetSessionId !== sessionId) return;
    setTurns((current) => patchLastAssistantTurn(current, fn));
  }, [sessionId]);

  const { run: runSideTask, stop: stopSideTask, runningSessionIds } = useChatStream({
    patchAssistant,
    onComplete: (targetSessionId, reply) => {
      if (targetSessionId !== sessionId) return;
      setTurns((current) => patchLastAssistantTurn(current, (turn) => ({
        ...turn,
        blocks: completedAssistantBlocks(turn, reply),
        streaming: false,
        error: undefined,
        stopped: false,
      })));
      if (reply.trim()) setLastResult(reply.trim());
    },
    onError: (targetSessionId, error, stopped) => {
      if (targetSessionId !== sessionId) return;
      setTurns((current) => patchLastAssistantTurn(current, (turn) => ({
        ...turn,
        streaming: false,
        error: visibleTurnError(error, stopped),
        stopped,
      })));
    },
  });
  const running = runningSessionIds.has(sessionId);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    chatPermissionSet(sessionId, "read-only")
      .then(() => { if (active) setPermissionReady(true); })
      .catch(() => { if (active) setPermissionReady(false); });
    return () => { active = false; };
  }, [sessionId]);

  useEffect(() => () => {
    if (!isTauri()) return;
    const finish = () => chatDelete(sessionId, projectId).catch(() => undefined);
    if (runningRef.current) {
      void stopSideTask(sessionId).catch(() => undefined).finally(finish);
    } else {
      void finish();
    }
  }, [projectId, sessionId, stopSideTask]);

  useEffect(() => {
    const value: StoredSideTaskState = {
      turns: turns.slice(-SIDE_TASK_MAX_STORED_TURNS),
      input,
      lastResult,
    };
    try {
      window.localStorage?.setItem(storedSideTaskKey(projectId, taskId), JSON.stringify(value));
    } catch {
      // Side tasks remain usable when storage is unavailable or at quota.
    }
  }, [input, lastResult, projectId, taskId, turns]);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || running || !ready || !permissionReady) return;
    const firstTurn = turnsRef.current.length === 0;
    setTurns((current) => [...current, userTurn(question, attachments), assistantTurn()]);
    setInput("");
    setAttachments([]);
    setLastResult("");
    if (!isTauri()) {
      setTurns((current) => [...current.slice(0, -1), assistantTextTurn(copy.preview)]);
      setLastResult(copy.preview);
      return;
    }
    const restoredHistory = needsRestoreContextRef.current
      ? turnsRef.current
          .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${textFromTurn(turn).trim()}`)
          .filter((line) => !line.endsWith(": "))
          .join("\n\n")
      : "";
    const prompt = firstTurn
      ? `${SIDE_TASK_INSTRUCTION}\n\nSide question:\n${question}`
      : restoredHistory
        ? `${SIDE_TASK_INSTRUCTION}\n\nRestored side-task conversation:\n${restoredHistory}\n\nNext side question:\n${question}`
        : question;
    needsRestoreContextRef.current = false;
    const outgoing = await outgoingMessage(
      prompt,
      attachments,
    );
    const request: ChatSendRequest = {
      ...outgoing,
      projectId,
      model: model ?? undefined,
      ephemeral: true,
    };
    await runSideTask(sessionId, request);
  }, [attachments, copy.preview, input, model, permissionReady, projectId, ready, runSideTask, running, sessionId]);

  const title = useMemo(() => sideTaskTitle(turns, initialTitle), [initialTitle, turns]);
  const handoff = useMemo(() => {
    if (!lastResult) return null;
    return language === "cn"
      ? `[侧边任务回流 · ${title}]\n\n${lastResult}\n\n来源：${copy.source}`
      : `[Side task handoff · ${title}]\n\n${lastResult}\n\nSource: ${copy.source}`;
  }, [copy.source, language, lastResult, title]);

  useEffect(() => {
    onMetadataChange(taskId, { title, handoff });
  }, [handoff, onMetadataChange, taskId, title]);

  return (
    <aside className="side-task-panel" aria-label={copy.title}>
      <div className={`side-task-chat${turns.length === 0 ? " is-empty" : ""}`}>
        <ChatThread
          sessionId={sessionId}
          language={language}
          turns={turns}
          composerHeight={composerHeight}
          starters={copy.starters}
          welcomeTitle={copy.emptyTitle}
          welcomeDescription={copy.emptyDescription}
          onStarter={(prompt) => setInput(prompt)}
          onEdit={() => undefined}
          onRetry={() => undefined}
          onContinue={() => undefined}
          onPermissionRespond={(promptId, allow) => {
            if (isTauri()) void chatPermissionRespond(promptId, allow);
          }}
          onQuestionRespond={(toolUseId, answer) => {
            if (!isTauri()) return Promise.resolve();
            return chatQuestionRespond(toolUseId, answer);
          }}
        />
        <ChatComposer
          input={input}
          commands={[]}
          skills={[]}
          attachments={attachments}
          busy={running}
          ready={ready && permissionReady}
          editing={false}
          focusRequest={focusRequest}
          permission={READ_ONLY_PERMISSION}
          modelName={model}
          onInputChange={setInput}
          onAttachmentsChange={setAttachments}
          onSubmit={() => void send()}
          onStop={() => void stopSideTask(sessionId)}
          onCancelEdit={() => undefined}
          onHeightChange={setComposerHeight}
        />
      </div>
    </aside>
  );
}
