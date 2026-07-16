import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { chatUiTurnLoad, fileOpen, isTauri } from "../api/tauri";
import { useStore, type Language } from "../store";
import type { ChatTurn } from "../types";
import ChatComposer from "./ChatComposer";
import CommandSelection from "./CommandSelection";
import ChatSidebar from "./ChatSidebar";
import ChatThread, { type ChatStarter } from "./ChatThread";
import FilePathMenu from "./FilePathMenu";
import { CHAT_COPY } from "./i18n";
import { latestFileChangesFromTurns, latestTodosFromTurns, makeId, migrateTurn, textFromTurn } from "./model";
import { fileChangeSummaryFromTurns } from "./ChatMessage";
import WorkflowFlow from "./WorkflowFlow";
import ScheduledTasks from "../scheduled/ScheduledTasks";
import { useChatSessions } from "./useChatSessions";
import { useChatComposer } from "./useChatComposer";
import { useChatRun } from "./useChatRun";
import { useChatCommands } from "./useChatCommands";
import { useChatSessionController } from "./useChatSessionController";
import ProjectBriefCard, { useProjectBrief } from "./ProjectBriefCard";
import ChatNavigationTabs, { type ChatNavigationTab } from "./ChatNavigationTabs";
import SideTaskPanel, { type SideTaskMetadata } from "./SideTaskPanel";

// Pure helpers live in `chatRunHelpers`; re-exported here for existing tests
// that import them from `./Chat`.
export {
  completedAssistantBlocks,
  contextForRetry,
  continueStoppedPrompt,
  needsBackendContextReset,
  visibleTurnError,
} from "./chatRunHelpers";

const CHAT_STARTERS: Record<Language, ChatStarter[]> = {
  cn: [
    {
      id: "literature",
      label: "文献检索",
      hint: "搜索近年论文，梳理研究脉络",
      prompt: "请围绕当前项目主题检索近5年的高相关论文，筛选权威来源并梳理研究脉络、代表性方法与尚未解决的问题。",
    },
    {
      id: "research",
      label: "资料搜集",
      hint: "汇总资料、数据与可靠来源",
      prompt: "请搜集与当前项目相关的权威资料、数据集和公开来源，按主题整理，并标注每条资料可以支持的研究判断。",
    },
    {
      id: "review",
      label: "论文审查",
      hint: "检查逻辑、方法与表达",
      prompt: "请审查当前论文，重点检查研究问题、方法设计、证据链、逻辑结构和语言表达，并给出可执行的修改建议。",
    },
    {
      id: "writing",
      label: "论文写作",
      hint: "搭建结构并完善关键段落",
      prompt: "请根据当前项目材料梳理论文结构，补全章节大纲，明确每一节的核心论点和下一步需要写作的段落。",
    },
  ],
  en: [
    {
      id: "literature",
      label: "Literature search",
      hint: "Find recent papers and map the field",
      prompt: "Search for highly relevant papers from the last five years on this project's topic, prioritize authoritative sources, and map methods, themes, and open problems.",
    },
    {
      id: "research",
      label: "Research materials",
      hint: "Collect sources, data, and evidence",
      prompt: "Collect authoritative sources, datasets, and public materials related to this project, organize them by theme, and explain what each source can support.",
    },
    {
      id: "review",
      label: "Paper review",
      hint: "Check logic, methods, and clarity",
      prompt: "Review the current paper for its research question, method design, evidence chain, structure, and writing quality, then give actionable revision suggestions.",
    },
    {
      id: "writing",
      label: "Paper writing",
      hint: "Build the outline and key sections",
      prompt: "Use the current project materials to build a paper outline, define the core claim of each section, and identify the next paragraphs to write.",
    },
  ],
};

interface SideTaskTab {
  id: string;
  projectId: string;
  title: string;
  handoff: string | null;
}

function MemoryBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="mem-badge" title={`${count} active memory item${count !== 1 ? "s" : ""} loaded`}>
      <span className="mem-badge-icon">◆</span>
      <span className="mem-badge-count">{count}</span>
    </div>
  );
}

/**
 * Chat is the thin composition root. Product state is owned by four controller
 * hooks — session data (`useChatSessions` + `useChatSessionController`), turn
 * execution (`useChatRun`), slash commands (`useChatCommands`), and composer
 * state (`useChatComposer`) — leaving this component to wire them together and
 * render. Adding a capability should land in the relevant controller, not here.
 */
export default function Chat() {
  const language = useStore((state) => state.language);
  const tab = useStore((state) => state.tab);
  const copy = CHAT_COPY[language];
  const setTab = useStore((state) => state.setTab);
  const setError = useStore((state) => state.setError);
  const projects = useStore((state) => state.projects);
  const currentProject = useStore((state) => state.currentProject);
  const projectBusy = useStore((state) => state.projectBusy);
  const switchProject = useStore((state) => state.switchProject);
  const reorderProjects = useStore((state) => state.reorderProjects);

  const {
    allSessions,
    currentId,
    currentSession,
    currentSessionLoading,
    setCurrentId,
    materializeCurrentSession,
    createSession,
    createSessionInProject,
    updateSession,
    patchTurns,
    hydrateOmittedTurn,
    newSession,
    setDraft,
    renameSession,
    togglePinned,
    removeSession,
    restoreSession,
  } = useChatSessions(currentProject?.id);

  // Shared "latest value" refs so the controllers can read current state from
  // async callbacks without re-subscribing.
  const currentSessionRef = useRef(currentSession);
  currentSessionRef.current = currentSession;
  const allSessionsRef = useRef(allSessions);
  allSessionsRef.current = allSessions;

  const composer = useChatComposer({ currentSession, currentSessionRef, updateSession, setDraft });
  const run = useChatRun({
    currentId,
    currentSession,
    currentSessionRef,
    allSessionsRef,
    patchTurns,
    updateSession,
    setEditingTurnId: composer.setEditingTurnId,
  });
  const commands = useChatCommands({
    currentId,
    currentSessionRef,
    runningSessionIdsRef: run.runningSessionIdsRef,
    currentChatBusy: run.currentChatBusy,
    patchTurns,
    updateSession,
    createSession,
    setEditingTurnId: composer.setEditingTurnId,
    focusComposer: composer.focusComposer,
    beginRun: run.beginRun,
    refreshStatus: run.refreshStatus,
    setContextOverrides: run.setContextOverrides,
  });
  const sessionCtl = useChatSessionController({ removeSession, restoreSession });
  const projectBrief = useProjectBrief(currentProject?.id);
  const [sideTaskTabs, setSideTaskTabs] = useState<SideTaskTab[]>([]);
  const [activeSideTaskId, setActiveSideTaskId] = useState<string | null>(null);
  const [sideTaskPaneOpen, setSideTaskPaneOpen] = useState(false);
  const sideTaskSequenceRef = useRef(0);
  const previousProjectIdRef = useRef(currentProject?.id);

  const addSideTask = useCallback(() => {
    if (!currentProject) return;
    sideTaskSequenceRef.current += 1;
    const sideTaskNumber = sideTaskSequenceRef.current;
    const sideTask: SideTaskTab = {
      id: makeId("side-task-tab"),
      projectId: currentProject.id,
      title: language === "cn" ? `侧边任务 ${sideTaskNumber}` : `Side task ${sideTaskNumber}`,
      handoff: null,
    };
    setSideTaskTabs((current) => [...current, sideTask]);
    setActiveSideTaskId(sideTask.id);
    setSideTaskPaneOpen(true);
  }, [currentProject, language]);

  const closeSideTask = useCallback((taskId: string) => {
    setSideTaskTabs((current) => {
      const closingIndex = current.findIndex((task) => task.id === taskId);
      const next = current.filter((task) => task.id !== taskId);
      if (activeSideTaskId === taskId) {
        const replacement = next[Math.min(Math.max(closingIndex, 0), next.length - 1)];
        setActiveSideTaskId(replacement?.id ?? null);
        if (!replacement) setSideTaskPaneOpen(false);
      }
      return next;
    });
  }, [activeSideTaskId]);

  const updateSideTaskMetadata = useCallback((taskId: string, metadata: SideTaskMetadata) => {
    setSideTaskTabs((current) => {
      const target = current.find((task) => task.id === taskId);
      if (!target || (target.title === metadata.title && target.handoff === metadata.handoff)) return current;
      return current.map((task) => task.id === taskId ? { ...task, ...metadata } : task);
    });
  }, []);

  useEffect(() => {
    if (previousProjectIdRef.current === currentProject?.id) return;
    previousProjectIdRef.current = currentProject?.id;
    sideTaskSequenceRef.current = 0;
    setSideTaskTabs([]);
    setActiveSideTaskId(null);
    setSideTaskPaneOpen(false);
  }, [currentProject?.id]);

  useEffect(() => {
    if (!sessionCtl.sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") sessionCtl.setSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [sessionCtl.sidebarOpen, sessionCtl.setSidebarOpen]);

  useEffect(() => {
    document.body.classList.toggle("somniq-chat-sidebar-open", sessionCtl.sidebarOpen);
    return () => document.body.classList.remove("somniq-chat-sidebar-open");
  }, [sessionCtl.sidebarOpen]);

  useEffect(() => {
    const toggleSideTask = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      if (sideTaskPaneOpen) {
        setSideTaskPaneOpen(false);
        return;
      }
      const latestSideTask = sideTaskTabs[sideTaskTabs.length - 1];
      if (latestSideTask) {
        setActiveSideTaskId((current) => current ?? latestSideTask.id);
        setSideTaskPaneOpen(true);
      } else addSideTask();
    };
    window.addEventListener("keydown", toggleSideTask);
    return () => window.removeEventListener("keydown", toggleSideTask);
  }, [addSideTask, sideTaskPaneOpen, sideTaskTabs]);

  const starters = CHAT_STARTERS[language];
  const welcomeCopy = language === "cn"
    ? {
      title: <>梦里<span className="chat-welcome-highlight">求索</span>，醒时<span className="chat-welcome-highlight">有获</span></>,
      description: "SomniQ 在后台持续推理、检索、分析与生成，把问题推进成答案。",
    }
    : {
      title: "Keep Research Questions Moving",
      description: "SomniQ keeps reasoning, searching, analyzing, and generating in the background—turning questions into progress.",
    };
  const [loadingOmittedTurns, setLoadingOmittedTurns] = useState<Set<string>>(() => new Set());

  const turns = currentSession?.turns ?? [];
  const { editingTurnId, focusComposer, setEditingTurnId } = composer;
  const { status, activeModel } = run;
  // Remote phone turns are rendered from the encrypted bridge rather than the
  // local stream hook. Treat their visible streaming state as busy too, so the
  // desktop composer exposes the same Stop control for either origin.
  const currentChatBusy = run.currentChatBusy
    || turns.some((turn) => turn.role === "assistant" && turn.streaming);
  const { pendingCommandSelection, setPendingCommandSelection } = commands;

  const workflowTodos = useMemo(() => latestTodosFromTurns(turns), [turns]);
  const workflowFileChanges = useMemo(
    () => latestFileChangesFromTurns(turns, currentProject?.path),
    [currentProject?.path, turns],
  );
  const workflowFileChangeSummary = useMemo(
    () => fileChangeSummaryFromTurns(turns),
    [turns],
  );

  const navigationCopy = language === "cn"
    ? {
      label: "侧边任务导航",
      add: "新增侧边任务标签",
      close: "关闭侧边任务标签",
      hide: "隐藏侧边任务栏",
      toggle: "显示或隐藏侧边任务栏",
      handoff: "发送到主任务",
    }
    : {
      label: "Side task navigation",
      add: "Add side task tab",
      close: "Close side task tab",
      hide: "Hide side task panel",
      toggle: "Show or hide side task panel",
      handoff: "Send to main task",
    };
  const navigationTabs = useMemo<ChatNavigationTab[]>(() => (
    sideTaskTabs.map((sideTask) => ({
      id: sideTask.id,
      label: sideTask.title,
      closable: true,
      closeLabel: `${navigationCopy.close}: ${sideTask.title}`,
    }))
  ), [navigationCopy.close, sideTaskTabs]);
  const activeSideTask = sideTaskTabs.find((sideTask) => sideTask.id === activeSideTaskId);

  const sendHandoffToMain = useCallback((content: string) => {
    const session = currentSessionRef.current;
    if (!session) return;
    const nextDraft = session.draft.trim()
      ? `${session.draft.trim()}\n\n${content}`
      : content;
    setDraft(session.id, nextDraft);
    focusComposer();
  }, [focusComposer, setDraft]);

  const send = async () => {
    if (!currentSession || run.sendLocks.current.has(currentSession.id) || currentChatBusy || (!composer.input.trim() && composer.attachments.length === 0)) return;
    const sessionId = currentSession.id;
    run.sendLocks.current.add(sessionId);
    try {
      if (!status?.ready && (!composer.input.trim().startsWith("/") || composer.attachments.length > 0)) return;
      const session = materializeCurrentSession();
      if (!session) return;
      if (await commands.runSlashCommand(session, composer.input, composer.attachments)) return;
      if (editingTurnId) {
        const index = session.turns.findIndex((turn) => turn.id === editingTurnId);
        const prefix = index >= 0 ? session.turns.slice(0, index) : session.turns;
        const editedUser = index >= 0 && session.turns[index]?.role === "user"
          ? session.turns[index]
          : undefined;
        await run.beginRun(
          session,
          prefix,
          composer.input,
          composer.attachments,
          true,
          undefined,
          editedUser,
        );
        return;
      }
      await run.beginRun(session, session.turns, composer.input, composer.attachments);
    } finally {
      run.sendLocks.current.delete(sessionId);
    }
  };

  // Keep the composer's submit prop stable while its latest implementation
  // continues to read the current stream/session state.
  const sendRef = useRef(send);
  sendRef.current = send;
  const submitComposer = useCallback(() => {
    void sendRef.current();
  }, []);

  const edit = useCallback((turn: ChatTurn) => {
    const session = currentSessionRef.current;
    if (!session || run.runningSessionIdsRef.current.has(session.id)) return;
    setDraft(session.id, textFromTurn(turn));
    updateSession(session.id, (item) => ({ ...item, draftAttachments: turn.attachments ?? [] }));
    setEditingTurnId(turn.id);
    focusComposer();
  }, [focusComposer, run.runningSessionIdsRef, setDraft, setEditingTurnId, updateSession]);

  const startFromPrompt = useCallback((prompt: string) => {
    const session = currentSessionRef.current;
    if (!session) return;
    setDraft(session.id, prompt);
    focusComposer();
  }, [currentSessionRef, focusComposer, setDraft]);

  const openWorkflowFile = useCallback((path: string) => {
    if (!isTauri()) return;
    void fileOpen(path).catch((error) => setError(String(error)));
  }, [setError]);

  const loadOmittedTurn = useCallback(async (turnIndex: number) => {
    const session = currentSessionRef.current;
    if (!session || !isTauri()) return;
    const key = `${session.id}:${turnIndex}`;
    setLoadingOmittedTurns((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
    try {
      const raw = await chatUiTurnLoad<Partial<ChatTurn> & Record<string, unknown>>(session.id, turnIndex);
      hydrateOmittedTurn(session.id, turnIndex, migrateTurn(raw));
    } catch (error) {
      setError(`Failed to load saved turn: ${String(error)}`);
    } finally {
      setLoadingOmittedTurns((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [hydrateOmittedTurn, setError]);

  const isOmittedTurnLoading = useCallback((turnIndex: number) => (
    loadingOmittedTurns.has(`${currentId}:${turnIndex}`)
  ), [currentId, loadingOmittedTurns]);

  const updateComposerInput = useCallback((value: string) => {
    if (pendingCommandSelection) setPendingCommandSelection(null);
    const session = currentSessionRef.current;
    if (session) setDraft(session.id, value);
  }, [currentSessionRef, pendingCommandSelection, setDraft, setPendingCommandSelection]);

  const stopComposer = useCallback(() => {
    void run.stop(currentId);
  }, [currentId, run.stop]);

  const cancelEdit = useCallback(() => setEditingTurnId(null), [setEditingTurnId]);

  const projectBriefVisible = tab === "chat"
    && !sideTaskPaneOpen
    && !projectBrief.hidden
    && projectBrief.brief !== null;

  return (
    <div
      className={`chat-root${projectBriefVisible ? " chat-project-brief-open" : ""}${sideTaskPaneOpen && tab === "chat" ? " side-task-open" : ""}`}
      style={{ "--chat-sidebar-w": `${sessionCtl.chatSidebarWidth}px` } as CSSProperties}
    >
      {sessionCtl.sidebarOpen && (
        <button
          className="chat-sidebar-backdrop"
          type="button"
          aria-label={copy.closeSidebar}
          onClick={() => sessionCtl.setSidebarOpen(false)}
        />
      )}
      <ChatSidebar
        sessions={allSessions}
        projects={projects}
        currentId={currentId}
        open={sessionCtl.sidebarOpen}
        busy={projectBusy}
        onClose={() => sessionCtl.setSidebarOpen(false)}
        onNew={async (projectId) => {
          composer.setEditingTurnId(null);
          if (tab === "scheduled") setTab("chat");
          if (!projectId || projectId === currentProject?.id) {
            setCurrentId(newSession());
          } else {
            try {
              await switchProject(projectId);
              const fresh = createSessionInProject(projectId);
              setCurrentId(fresh.id);
            } catch {
              return;
            }
          }
          sessionCtl.setSidebarOpen(false);
        }}
        onOpen={async (id) => {
          const target = allSessions.find((session) => session.id === id);
          if (target && target.projectId !== currentProject?.id) {
            try {
              await switchProject(target.projectId);
            } catch {
              return;
            }
          }
          composer.setEditingTurnId(null);
          if (tab === "scheduled") setTab("chat");
          setCurrentId(id);
          sessionCtl.setSidebarOpen(false);
        }}
        onRename={renameSession}
        onTogglePinned={togglePinned}
        onDelete={sessionCtl.deleteSession}
        onReorderProjects={reorderProjects}
      />
      <div
        className="chat-sidebar-resize-handle"
        onPointerDown={sessionCtl.onChatSidebarResizeStart}
        onPointerMove={sessionCtl.onChatSidebarResizeMove}
        onPointerUp={sessionCtl.onChatSidebarResizeEnd}
        onPointerCancel={sessionCtl.onChatSidebarResizeEnd}
      />
      <main
        className={`chat${turns.length === 0 ? " chat-empty" : ""}`}
        onContextMenu={composer.handleChatContextMenu}
        onDragEnter={(e) => { e.preventDefault(); composer.setChatDragging(true); }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) composer.setChatDragging(false); }}
        onDrop={(e) => { e.preventDefault(); composer.setChatDragging(false); void composer.addFilesToChat(Array.from(e.dataTransfer.files)); }}
      >
        <button
          className={`chat-sidebar-open${sessionCtl.sidebarOpen ? " is-open" : ""}`}
          type="button"
          aria-label={copy.openSidebar}
          aria-controls="chat-session-sidebar"
          aria-expanded={sessionCtl.sidebarOpen}
          onClick={() => sessionCtl.setSidebarOpen(true)}
        >
          <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="2.25" y="3" width="11.5" height="10" rx="2" />
            <path d="M6.25 3v10" />
          </svg>
        </button>
        {tab === "chat" && composer.chatDragging && (
          <div
            className="chat-drop-full"
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              if (!(e.currentTarget.parentElement?.contains(e.relatedTarget as Node) ?? false)) {
                composer.setChatDragging(false);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              composer.setChatDragging(false);
              void composer.addFilesToChat(Array.from(e.dataTransfer.files));
            }}
          >
            <span className="chat-drop-full-icon">📎</span>
            <span>拖放文件以附加</span>
          </div>
        )}

        {tab === "chat" && document.getElementById("app-chat-actions-portal") && createPortal(
          <div className="chat-head-actions" data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {status?.memoryFiles != null && status.memoryFiles > 0 && (
              <MemoryBadge count={status.memoryFiles} />
            )}
            <button
              className="chat-export-btn"
              onClick={() => void commands.exportCurrentChat()}
              disabled={currentChatBusy || commands.exporting || commands.debugExporting || turns.length === 0}
              title={copy.exportChat}
              aria-label={copy.exportChat}
              style={{ background: "transparent", border: "none", color: "var(--text-dim)", padding: "4px", cursor: "pointer", display: "flex", alignItems: "center" }}
            >
              {commands.exporting ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="spinner">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="31.4 31.4" strokeLinecap="round" opacity="0.5"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 15V3M12 15L8 11M12 15L16 11M21 21H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <button
              className="chat-export-btn"
              onClick={() => void commands.exportDebugZip()}
              disabled={commands.exporting || commands.debugExporting || turns.length === 0}
              title={copy.exportDebugZip ?? "Export debug zip"}
              aria-label={copy.exportDebugZip ?? "Export debug zip"}
              style={{ background: "transparent", border: "none", color: "var(--text-dim)", padding: "4px", cursor: "pointer", display: "flex", alignItems: "center" }}
            >
              {commands.debugExporting ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="spinner">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="31.4 31.4" strokeLinecap="round" opacity="0.5"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4 7H20M6 7L7 20H17L18 7M9 7V4H15V7M9 11H15M9 15H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            {!status?.ready && <button onClick={() => setTab("settings")}>{copy.settings}</button>}
            {projectBrief.brief && !sideTaskPaneOpen && (
              <button
                type="button"
                className={`chat-project-brief-toggle${projectBrief.hidden ? "" : " active"}`}
                onClick={() => projectBrief.setHidden(!projectBrief.hidden)}
                title={projectBrief.hidden
                  ? (language === "cn" ? "显示项目摘要" : "Show project summary")
                  : (language === "cn" ? "收起项目摘要" : "Collapse project summary")}
                aria-label={projectBrief.hidden
                  ? (language === "cn" ? "显示项目摘要" : "Show project summary")
                  : (language === "cn" ? "收起项目摘要" : "Collapse project summary")}
                aria-pressed={!projectBrief.hidden}
                aria-controls="project-brief-popover"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className={`chat-side-task-toggle${sideTaskPaneOpen ? " active" : ""}`}
              onClick={() => {
                if (sideTaskPaneOpen) setSideTaskPaneOpen(false);
                else if (sideTaskTabs.length > 0) setSideTaskPaneOpen(true);
                else addSideTask();
              }}
              title={`${navigationCopy.toggle} (Ctrl+Alt+B)`}
              aria-label={navigationCopy.toggle}
              aria-pressed={sideTaskPaneOpen}
              aria-controls="side-task-panel"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
                <path d="M14.5 4v16" />
              </svg>
            </button>
          </div>,
          document.getElementById("app-chat-actions-portal")!
        )}
        {tab === "scheduled" ? (
          <ScheduledTasks />
        ) : (
          <>
        <ChatThread
          key={currentId}
          sessionId={currentId}
          turns={turns}
          loading={currentSessionLoading}
          composerHeight={composer.composerHeight}
          starters={starters}
          welcomeTitle={welcomeCopy.title}
          welcomeDescription={welcomeCopy.description}
          onStarter={startFromPrompt}
          onEdit={edit}
          onRetry={run.retry}
          onContinue={run.continueStopped}
          onLoadOmittedTurn={loadOmittedTurn}
          isOmittedTurnLoading={isOmittedTurnLoading}
          onPermissionRespond={run.respondPermission}
          onQuestionRespond={run.respondQuestion}
        />
        {(workflowTodos.length > 0 || workflowFileChanges.length > 0 || workflowFileChangeSummary) && !pendingCommandSelection && (
          <WorkflowFlow
            todos={workflowTodos}
            fileChanges={workflowFileChanges}
            fileChangeSummary={workflowFileChangeSummary}
            bottomOffset={composer.composerHeight + 14}
            active={currentChatBusy}
            onOpenFile={openWorkflowFile}
          />
        )}
        {pendingCommandSelection && pendingCommandSelection.sessionId === currentId && (
          <CommandSelection
            selection={pendingCommandSelection.selection}
            bottomOffset={composer.composerHeight + 12}
            onSelect={(value) => void commands.selectCommandOption(value)}
            onCancel={() => {
              commands.setPendingCommandSelection(null);
              focusComposer();
            }}
          />
        )}
        <ChatComposer
          input={composer.input}
          commands={commands.desktopCommands}
          skills={commands.skills}
          attachments={composer.attachments}
          busy={currentChatBusy}
          ready={Boolean(status?.ready)}
          editing={Boolean(editingTurnId)}
          focusRequest={composer.focusRequest}
          permission={run.permission}
          permissionBusy={run.permissionBusy}
          onPermissionChange={run.changePermission}
          modelName={status?.ready ? activeModel : null}
          modelOptions={run.modelSelectOptions}
          modelBusy={run.modelBusy}
          canSwitchModel={run.canSwitchModel}
          onModelChange={run.changeModel}
          reasoningSupported={run.reasoning.supported}
          reasoningEffort={run.reasoning.effort}
          reasoningBusy={run.reasoningBusy}
          onReasoningEffortChange={run.changeReasoningEffort}
          contextUsed={run.estimatedTokens}
          contextMax={run.contextMax}
          contextStatus={run.currentContextNotice}
          onInputChange={updateComposerInput}
          onAttachmentsChange={composer.setAttachments}
          onSubmit={submitComposer}
          onStop={stopComposer}
          onCancelEdit={cancelEdit}
          onHeightChange={composer.setComposerHeight}
        />
          </>
        )}
      </main>
      {sideTaskTabs.length > 0 && (
        <aside
          id="side-task-panel"
          className="side-task-slot"
          aria-label={navigationCopy.label}
          hidden={!sideTaskPaneOpen || tab !== "chat"}
        >
          <ChatNavigationTabs
            tabs={navigationTabs}
            activeTabId={activeSideTaskId ?? sideTaskTabs[0]?.id ?? ""}
            label={navigationCopy.label}
            addLabel={navigationCopy.add}
            hideLabel={navigationCopy.hide}
            action={activeSideTask?.handoff
              ? { label: navigationCopy.handoff, onClick: () => sendHandoffToMain(activeSideTask.handoff!) }
              : undefined}
            onSelect={setActiveSideTaskId}
            onClose={closeSideTask}
            onAdd={addSideTask}
            onHide={() => setSideTaskPaneOpen(false)}
          />
          <div className="side-task-workspaces">
            {sideTaskTabs.map((sideTask) => (
              <section
                key={sideTask.id}
                id={`chat-workspace-${sideTask.id}`}
                className="chat-workspace-view"
                role="tabpanel"
                aria-label={sideTask.title}
                hidden={activeSideTaskId !== sideTask.id}
              >
                <SideTaskPanel
                  taskId={sideTask.id}
                  initialTitle={sideTask.title}
                  projectId={sideTask.projectId}
                  model={activeModel}
                  ready={Boolean(status?.ready)}
                  onMetadataChange={updateSideTaskMetadata}
                />
              </section>
            ))}
          </div>
        </aside>
      )}
      {projectBriefVisible && projectBrief.brief && (
        <aside
          id="project-brief-popover"
          className="chat-project-brief-sidebar"
          aria-label={language === "cn" ? "项目摘要" : "Project summary"}
        >
          <ProjectBriefCard
            brief={projectBrief.brief}
            language={language}
            onHide={() => projectBrief.setHidden(true)}
          />
        </aside>
      )}
      {sessionCtl.deleted && (
        <div className="chat-undo">
          {copy.deleted(sessionCtl.deleted.title)}
          <button onClick={sessionCtl.undoDelete}>{copy.undo}</button>
        </div>
      )}
      {composer.fileMenu && (
        <FilePathMenu
          x={composer.fileMenu.x}
          y={composer.fileMenu.y}
          path={composer.fileMenu.path}
          projectRoot={currentProject?.path}
          onClose={() => composer.setFileMenu(null)}
          onAttach={(path, content) => void composer.attachFileFromMenu(path, content)}
        />
      )}
    </div>
  );
}
