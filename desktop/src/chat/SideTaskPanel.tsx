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
  onMetadataChange: (taskId: string, metadata: SideTaskMetadata) => void;
}

export interface SideTaskMetadata {
  title: string;
  handoff: string | null;
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
    }
    : {
      title: "Side task",
      emptyTitle: "Handle a question on the side",
      emptyDescription: "Uses project context without reading the main chat or saving into the project.",
      preview: "Side task response in browser preview.",
      source: "Temporary side task",
    };
  const sessionIdRef = useRef(makeId("side-task"));
  const sessionId = sessionIdRef.current;
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [composerHeight, setComposerHeight] = useState(0);
  const focusRequest = 1;
  const [permissionReady, setPermissionReady] = useState(!isTauri());
  const [lastResult, setLastResult] = useState("");
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
    const outgoing = await outgoingMessage(
      firstTurn ? `${SIDE_TASK_INSTRUCTION}\n\nSide question:\n${question}` : question,
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
          turns={turns}
          composerHeight={composerHeight}
          starters={[]}
          welcomeTitle={copy.emptyTitle}
          welcomeDescription={copy.emptyDescription}
          onStarter={() => undefined}
          onEdit={() => undefined}
          onRetry={() => undefined}
          onContinue={() => undefined}
          onPermissionRespond={(promptId, allow) => {
            if (isTauri()) void chatPermissionRespond(promptId, allow);
          }}
          onQuestionRespond={(toolUseId, answer) => {
            if (isTauri()) void chatQuestionRespond(toolUseId, answer);
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
