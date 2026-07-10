import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { chatUiTurnLoad, fileOpen, isTauri, projectChatStarters } from "../api/tauri";
import { useStore } from "../store";
import type { ChatTurn } from "../types";
import ChatComposer from "./ChatComposer";
import CommandSelection from "./CommandSelection";
import ChatSidebar from "./ChatSidebar";
import ChatThread from "./ChatThread";
import FilePathMenu from "./FilePathMenu";
import { CHAT_COPY } from "./i18n";
import { latestFileChangesFromTurns, latestTodosFromTurns, migrateTurn, textFromTurn } from "./model";
import { fileChangeSummaryFromTurns } from "./ChatMessage";
import WorkflowFlow from "./WorkflowFlow";
import { useChatSessions } from "./useChatSessions";
import { useChatComposer } from "./useChatComposer";
import { useChatRun } from "./useChatRun";
import { useChatCommands } from "./useChatCommands";
import { useChatSessionController } from "./useChatSessionController";

// Pure helpers live in `chatRunHelpers`; re-exported here for existing tests
// that import them from `./Chat`.
export {
  completedAssistantBlocks,
  contextForRetry,
  continueStoppedPrompt,
  needsBackendContextReset,
  visibleTurnError,
} from "./chatRunHelpers";

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

  const [starters, setStarters] = useState([
    "Explain this project's architecture and key modules.",
    "Check the uncommitted changes and identify risks.",
    "Run the relevant tests and fix any failures.",
  ]);
  const [loadingOmittedTurns, setLoadingOmittedTurns] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!isTauri()) return;
    projectChatStarters().then(setStarters).catch(() => undefined);
  }, [currentProject?.id]);

  const turns = currentSession?.turns ?? [];
  const { editingTurnId, focusComposer } = composer;
  const { status, currentChatBusy, activeModel } = run;
  const { pendingCommandSelection } = commands;

  const workflowTodos = useMemo(() => latestTodosFromTurns(turns), [turns]);
  const workflowFileChanges = useMemo(
    () => latestFileChangesFromTurns(turns, currentProject?.path),
    [currentProject?.path, turns],
  );
  const workflowFileChangeSummary = useMemo(
    () => fileChangeSummaryFromTurns(turns),
    [turns],
  );

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
        await run.beginRun(session, prefix, composer.input, composer.attachments, true);
        return;
      }
      await run.beginRun(session, session.turns, composer.input, composer.attachments);
    } finally {
      run.sendLocks.current.delete(sessionId);
    }
  };

  const edit = useCallback((turn: ChatTurn) => {
    const session = currentSessionRef.current;
    if (!session || run.runningSessionIdsRef.current.has(session.id)) return;
    setDraft(session.id, textFromTurn(turn));
    updateSession(session.id, (item) => ({ ...item, draftAttachments: turn.attachments ?? [] }));
    composer.setEditingTurnId(turn.id);
    focusComposer();
  }, [composer, focusComposer, run.runningSessionIdsRef, setDraft, updateSession]);

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

  return (
    <div
      className="chat-root"
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
        {composer.chatDragging && (
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

        {document.getElementById("app-chat-actions-portal") && createPortal(
          <div className="chat-head-actions" data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {status?.memoryFiles != null && status.memoryFiles > 0 && (
              <MemoryBadge count={status.memoryFiles} />
            )}
            <div className="chat-head-model-badge" style={{
              background: "var(--bg-2)",
              color: "var(--text-dim)",
              padding: "2px 6px",
              borderRadius: "4px",
              fontSize: "12px",
              fontWeight: 500
            }}>
              {status?.ready ? status.provider : (status?.message ?? copy.checking)}
            </div>
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
          </div>,
          document.getElementById("app-chat-actions-portal")!
        )}
        <ChatThread
          key={currentId}
          sessionId={currentId}
          turns={turns}
          loading={currentSessionLoading}
          composerHeight={composer.composerHeight}
          starters={starters}
          onStarter={(prompt) => {
            if (!currentSession) return;
            setDraft(currentSession.id, prompt);
            focusComposer();
          }}
          onEdit={edit}
          onRetry={run.retry}
          onContinue={run.continueStopped}
          onLoadOmittedTurn={(turnIndex) => void loadOmittedTurn(turnIndex)}
          isOmittedTurnLoading={isOmittedTurnLoading}
          onPermissionRespond={(promptId, allow) => void run.respondPermission(promptId, allow)}
          onQuestionRespond={(toolUseId, answer) => void run.respondQuestion(toolUseId, answer)}
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
          onPermissionChange={(mode) => void run.changePermission(mode)}
          modelName={status?.ready ? activeModel : null}
          modelOptions={run.modelSelectOptions}
          modelBusy={run.modelBusy}
          canSwitchModel={run.canSwitchModel}
          onModelChange={(model) => void run.changeModel(model)}
          contextUsed={run.estimatedTokens}
          contextMax={run.contextMax}
          contextStatus={run.currentContextNotice}
          onInputChange={(value) => {
            if (pendingCommandSelection) commands.setPendingCommandSelection(null);
            if (currentSession) setDraft(currentSession.id, value);
          }}
          onAttachmentsChange={composer.setAttachments}
          onSubmit={() => void send()}
          onStop={() => void run.stop(currentId)}
          onCancelEdit={() => composer.setEditingTurnId(null)}
          onHeightChange={composer.setComposerHeight}
        />
      </main>
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
