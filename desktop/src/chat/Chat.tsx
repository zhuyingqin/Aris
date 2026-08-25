import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  chatReviewClear,
  chatTasksGet,
  chatUiTurnLoad,
  computePeersList,
  isTauri,
  onComputePeerEvent,
  remoteAgentSessionOpen,
  remoteAgentSessionCreate,
  remoteAgentSessions,
  remoteAgentWorkspace,
} from "../api/tauri";
import {
  useStore,
  type Language,
  type PendingChatHandoff,
  type SidePanelEvidenceTarget,
} from "../store";
import { SvgIcon } from "../SvgIcon";
import type {
  ChatTurn,
  ChatTodoItem,
  ComputePeer,
  RemoteAgentSessions,
  RemoteAgentTranscript,
  RemoteAgentWorkspace,
} from "../types";
import ChatComposer from "./ChatComposer";
import CommandSelection from "./CommandSelection";
import ChatSidebar from "./ChatSidebar";
import ChatThread, { type ChatStarter } from "./ChatThread";
import FilePathMenu from "./FilePathMenu";
import { CHAT_COPY } from "./i18n";
import {
  fileChangePathMatches,
  latestFileChangesFromTurns,
  latestTodosFromTurns,
  makeId,
  makeSession,
  migrateTurn,
  textFromTurn,
} from "./model";
import { fileChangeSummaryFromTurns } from "./toolSummaries";
import WorkflowFlow from "./WorkflowFlow";
import ScheduledTasks from "../scheduled/ScheduledTasks";
import { useChatSessions } from "./useChatSessions";
import { useChatComposer } from "./useChatComposer";
import { useChatRun } from "./useChatRun";
import { useChatCommands } from "./useChatCommands";
import { useChatSessionController } from "./useChatSessionController";
import ProjectBriefCard, { useBackgroundProcesses, useProjectBrief } from "./ProjectBriefCard";
import ChatNavigationTabs, { type ChatNavigationTab } from "./ChatNavigationTabs";
import SideTaskPanel from "./SideTaskPanel";
import SideFileViewer from "./SideFileViewer";
import { sideFileTitle, type SidePanelMetadata } from "./sidePanelFiles";
import { useOpenChatFile } from "./openChatFile";
import IndependentReviewPanel from "./IndependentReviewPanel";
import ImageWorkflowPanel from "./ImageWorkflowPanel";
import { useIndependentReview } from "./useIndependentReview";
import { useScopedSelectAll } from "./useScopedSelectAll";
import type { ChatSession } from "./types";
import {
  IMAGE_ASSIST_ACTIVITY_EVENT,
  imageAssistActivitySnapshot,
  publishImageAssistActivity,
  type ImageAssistActivity,
} from "../remote/imageAssistActivity";

const INDEPENDENT_REVIEW_TAB_ID = "independent-review";
const IMAGE_WORKFLOW_TAB_ID = "image-workflow";
const CHAT_UI_EARLIER_TURN_BATCH_SIZE = 12;
const encodeRemoteTargetPart = (value: string) => encodeURIComponent(value);
const remoteAgentNewTargetValue = (nodeId: string, projectId: string) =>
  `remote-new|${encodeRemoteTargetPart(nodeId)}|${encodeRemoteTargetPart(projectId)}`;
const remoteAgentHistoryTargetValue = (nodeId: string, projectId: string) =>
  `remote-history|${encodeRemoteTargetPart(nodeId)}|${encodeRemoteTargetPart(projectId)}`;
const remoteAgentSessionTargetValue = (nodeId: string, projectId: string, sessionId: string) =>
  `remote-session|${encodeRemoteTargetPart(nodeId)}|${encodeRemoteTargetPart(projectId)}|${encodeRemoteTargetPart(sessionId)}`;
const remoteAgentHistoryKey = (nodeId: string, projectId: string) =>
  `${nodeId}\u0000${projectId}`;

function turnsFromRemoteTranscript(transcript: RemoteAgentTranscript): ChatTurn[] {
  return transcript.messages.map((message, index) => ({
    id: `remote-history-${transcript.sessionId}-${index}`,
    role: message.role,
    blocks: message.blocks.map((block) => {
      if (block.kind === "text") return { kind: "text" as const, text: block.text };
      if (block.kind === "thinking") {
        return { kind: "thinking" as const, thinking: block.thinking };
      }
      return {
        kind: "tool" as const,
        id: block.id ?? undefined,
        name: block.name,
        input: block.input,
        output: block.output ?? undefined,
        isError: block.isError ?? undefined,
        progress: block.progress ?? undefined,
      };
    }),
  }));
}

const CHAT_STARTERS: Record<Language, ChatStarter[]> = {
  cn: [
    {
      id: "literature",
      label: "文献检索",
      hint: "搜索近年论文，梳理研究脉络",
      badge: "深度检索",
      prompt: "请围绕当前项目主题检索近5年的高相关论文，筛选权威来源并梳理研究脉络、代表性方法与尚未解决的问题。",
    },
    {
      id: "research",
      label: "资料搜集",
      hint: "汇总资料、数据与可靠来源",
      badge: "证据链",
      prompt: "请搜集与当前项目相关的权威资料、数据集和公开来源，按主题整理，并标注每条资料可以支持的研究判断。",
    },
    {
      id: "review",
      label: "论文审查",
      hint: "检查逻辑、方法与表达",
      badge: "审稿视角",
      prompt: "请审查当前论文，重点检查研究问题、方法设计、证据链、逻辑结构和语言表达，并给出可执行的修改建议。",
    },
    {
      id: "writing",
      label: "论文写作",
      hint: "搭建结构并完善关键段落",
      badge: "LaTeX 排版",
      prompt: "请根据当前项目材料梳理论文结构，补全章节大纲，明确每一节的核心论点和下一步需要写作的段落。",
    },
  ],
  en: [
    {
      id: "literature",
      label: "Literature search",
      hint: "Find recent papers and map the field",
      badge: "Deep Search",
      prompt: "Search for highly relevant papers from the last five years on this project's topic, prioritize authoritative sources, and map methods, themes, and open problems.",
    },
    {
      id: "research",
      label: "Research materials",
      hint: "Collect sources, data, and evidence",
      badge: "Evidence",
      prompt: "Collect authoritative sources, datasets, and public materials related to this project, organize them by theme, and explain what each source can support.",
    },
    {
      id: "review",
      label: "Paper review",
      hint: "Check logic, methods, and clarity",
      badge: "Reviewer",
      prompt: "Review the current paper for its research question, method design, evidence chain, structure, and writing quality, then give actionable revision suggestions.",
    },
    {
      id: "writing",
      label: "Paper writing",
      hint: "Build the outline and key sections",
      badge: "LaTeX Sync",
      prompt: "Use the current project materials to build a paper outline, define the core claim of each section, and identify the next paragraphs to write.",
    },
  ],
};

/**
 * The right pane is a small workspace, not only a side-task chat: a tab is
 * either an ephemeral read-only chat ("task") or a reading surface for a file
 * ("file"). Both report the same metadata back, so the tab strip and the
 * "send to main task" action stay type-agnostic.
 */
type SidePanelTab =
  | { kind: "task"; id: string; projectId: string; title: string; handoff: string | null }
  | {
      kind: "file";
      id: string;
      projectId: string;
      path: string;
      title: string;
      handoff: string | null;
      evidence?: SidePanelEvidenceTarget;
    };

const SIDE_PANEL_WIDTH_KEY = "somniq-side-panel-width";
const SIDE_PANEL_MIN_WIDTH = 320;

function storedSidePanelWidth(): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage?.getItem(SIDE_PANEL_WIDTH_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= SIDE_PANEL_MIN_WIDTH ? parsed : null;
}

function MemoryBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="mem-badge" title={`${count} active memory item${count !== 1 ? "s" : ""} loaded`}>
      <span className="mem-badge-icon"><SvgIcon name="memory" size={10} /></span>
      <span className="mem-badge-count">{count}</span>
    </div>
  );
}

function mergeWorkflowHandoffDraft(session: ChatSession, handoff: PendingChatHandoff) {
  if (!handoff.draft) return session.draft;
  const previousSnapshot = session.workflowContextSnapshot ?? "";
  // Migrate the old handoff behavior, which put the whole generated snapshot
  // into the composer. A real user draft is always left untouched.
  if (!session.draft.trim() || session.draft === previousSnapshot) return handoff.draft;
  return session.draft;
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
  const pendingSidePanelFilePath = useStore((state) => state.pendingSidePanelFilePath);
  const setPendingSidePanelFilePath = useStore((state) => state.setPendingSidePanelFilePath);
  const pendingSidePanelEvidence = useStore((state) => state.pendingSidePanelEvidence);
  const setPendingSidePanelEvidence = useStore((state) => state.setPendingSidePanelEvidence);
  const pendingChatHandoff = useStore((state) => state.pendingChatHandoff);
  const setPendingChatHandoff = useStore((state) => state.setPendingChatHandoff);
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
    sessionsHydrated,
    setCurrentId,
    materializeCurrentSession,
    createSession,
    createSessionInProject,
    updateSession,
    patchTurns,
    hydrateOmittedTurn,
    prependEarlierTurns,
    newSession,
    setDraft,
    renameSession,
    togglePinned,
    removeSession,
    upsertSession,
    restoreSession,
    isRemoteSessionStreaming,
  } = useChatSessions(currentProject?.id);

  useEffect(() => {
    if (!pendingChatHandoff || !currentProject || !sessionsHydrated) return;
    if (pendingChatHandoff.projectId !== currentProject.id) return;

    const existing = allSessions.find((session) => (
      session.projectId === currentProject.id
      && (
        session.workflowContextKey === pendingChatHandoff.conversationKey
        || Boolean(pendingChatHandoff.sessionId && session.id === pendingChatHandoff.sessionId)
      )
    ));
    const activate = pendingChatHandoff.activate !== false;
    const workflowRunId = pendingChatHandoff.workflowRunId
      ?? pendingChatHandoff.conversationKey.replace(/^review-workflow:/, "");
    if (existing) {
      if (activate) setCurrentId(existing.id);
      updateSession(existing.id, (session) => ({
        ...session,
        title: pendingChatHandoff.title,
        // Remove the legacy synthetic stage cards and then replay the real
        // append-only runtime transcript from the workflow session event log.
        turns: session.turns.filter((turn) => !(session.workflowProjectionTurnIds ?? []).includes(turn.id)),
        turnsLoaded: false,
        turnsPartial: false,
        turnCount: 0,
        workflowContextKey: pendingChatHandoff.conversationKey,
        workflowRunId,
        ownerKind: "review_workflow",
        workflowContextSnapshot: undefined,
        workflowProjectionTurnIds: undefined,
        draft: activate ? mergeWorkflowHandoffDraft(session, pendingChatHandoff) : session.draft,
        updatedAt: Date.now(),
      }));
    } else {
      const fresh = makeSession(currentProject.id);
      if (pendingChatHandoff.sessionId) fresh.id = pendingChatHandoff.sessionId;
      upsertSession({
        ...fresh,
        title: pendingChatHandoff.title,
        workflowContextKey: pendingChatHandoff.conversationKey,
        workflowRunId,
        ownerKind: "review_workflow",
        turns: [],
        turnsLoaded: false,
        turnsPartial: false,
        turnCount: 0,
        draft: activate ? pendingChatHandoff.draft ?? "" : "",
        updatedAt: Date.now(),
      }, activate);
    }
    setPendingChatHandoff(null);
  }, [
    allSessions,
    currentProject,
    pendingChatHandoff,
    sessionsHydrated,
    setCurrentId,
    setPendingChatHandoff,
    upsertSession,
    updateSession,
  ]);

  // Shared "latest value" refs so the controllers can read current state from
  // async callbacks without re-subscribing.
  const currentSessionRef = useRef(currentSession);
  currentSessionRef.current = currentSession;
  const allSessionsRef = useRef(allSessions);
  allSessionsRef.current = allSessions;
  const chatMainRef = useRef<HTMLElement | null>(null);
  useScopedSelectAll(chatMainRef);

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
    applyContextTokens: run.applyContextTokens,
  });
  const sessionCtl = useChatSessionController({ removeSession, restoreSession });
  const projectBrief = useProjectBrief(currentProject?.id);
  const background = useBackgroundProcesses();
  const [imageAssistActivity, setImageAssistActivity] = useState<ImageAssistActivity | null>(
    () => imageAssistActivitySnapshot(),
  );
  const independentReview = useIndependentReview(currentId);
  const [sideTaskTabs, setSideTaskTabs] = useState<SidePanelTab[]>([]);
  const [activeSideTaskId, setActiveSideTaskId] = useState<string | null>(IMAGE_WORKFLOW_TAB_ID);
  const [sideTaskPaneOpen, setSideTaskPaneOpen] = useState(false);
  const [sidePanelWidth, setSidePanelWidth] = useState<number | null>(storedSidePanelWidth);
  const [agentPeers, setAgentPeers] = useState<ComputePeer[]>([]);
  const [agentWorkspaces, setAgentWorkspaces] = useState<Record<string, RemoteAgentWorkspace>>({});
  const [agentSessionLists, setAgentSessionLists] = useState<Record<string, RemoteAgentSessions>>({});
  const [agentTargetBusy, setAgentTargetBusy] = useState(false);
  const [sidebarWorkspaceNodeId, setSidebarWorkspaceNodeId] = useState<string | null>(
    currentSession?.remoteAgent?.nodeId ?? null,
  );
  const sideTaskSequenceRef = useRef(0);
  const previousProjectIdRef = useRef(currentProject?.id);
  const agentTargetLoadingRef = useRef(false);
  const agentPeerRefreshRunningRef = useRef(false);
  const lastRemoteWorkspaceProbeRef = useRef<string | null>(null);
  const lastLocalSessionIdRef = useRef<string | null>(
    currentSession && !currentSession.remoteAgent ? currentSession.id : null,
  );

  useEffect(() => {
    const onActivity = (event: Event) => {
      const activity = (event as CustomEvent<ImageAssistActivity | null>).detail;
      setImageAssistActivity(activity);
      if (activity) projectBrief.setHidden(false);
    };
    window.addEventListener(IMAGE_ASSIST_ACTIVITY_EVENT, onActivity);
    return () => window.removeEventListener(IMAGE_ASSIST_ACTIVITY_EVENT, onActivity);
  }, [projectBrief.setHidden]);

  const refreshAgentPeers = useCallback(async () => {
    if (!isTauri() || agentPeerRefreshRunningRef.current) return;
    agentPeerRefreshRunningRef.current = true;
    try {
      const next = await computePeersList();
      setAgentPeers(next);
      setAgentWorkspaces((current) => {
        const connected = new Set(next.filter((peer) => peer.connected).map((peer) => peer.nodeId));
        return Object.fromEntries(Object.entries(current).filter(([nodeId]) => connected.has(nodeId)));
      });
      setAgentSessionLists((current) => {
        const connected = new Set(next.filter((peer) => peer.connected).map((peer) => peer.nodeId));
        return Object.fromEntries(
          Object.entries(current).filter(([, value]) => connected.has(value.nodeId)),
        );
      });
    } finally {
      agentPeerRefreshRunningRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onComputePeerEvent(() => {
      if (!disposed) void refreshAgentPeers().catch(() => undefined);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshAgentPeers]);

  const loadAgentTargets = useCallback(async () => {
    if (!isTauri() || agentTargetLoadingRef.current) return [] as string[];
    agentTargetLoadingRef.current = true;
    setAgentTargetBusy(true);
    try {
      const peers = await computePeersList();
      setAgentPeers(peers);
      const candidates = peers.filter((peer) => peer.connected && peer.agentChatAuthorized);
      const loaded = await Promise.allSettled(candidates.map((peer) => remoteAgentWorkspace(peer.nodeId)));
      const next: Record<string, RemoteAgentWorkspace> = {};
      loaded.forEach((result) => {
        if (result.status === "fulfilled") next[result.value.nodeId] = result.value;
      });
      setAgentWorkspaces(next);
      return Object.keys(next);
    } catch {
      return [] as string[];
    } finally {
      agentTargetLoadingRef.current = false;
      setAgentTargetBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!sidebarWorkspaceNodeId) {
      lastRemoteWorkspaceProbeRef.current = null;
      return;
    }
    const peer = agentPeers.find((candidate) => candidate.nodeId === sidebarWorkspaceNodeId);
    if (!peer?.connected || !peer.agentChatAuthorized) {
      if (lastRemoteWorkspaceProbeRef.current === sidebarWorkspaceNodeId) {
        lastRemoteWorkspaceProbeRef.current = null;
      }
      return;
    }
    if (lastRemoteWorkspaceProbeRef.current === sidebarWorkspaceNodeId) return;
    lastRemoteWorkspaceProbeRef.current = sidebarWorkspaceNodeId;
    void loadAgentTargets().then((loadedNodeIds) => {
      if (
        !loadedNodeIds.includes(sidebarWorkspaceNodeId)
        && lastRemoteWorkspaceProbeRef.current === sidebarWorkspaceNodeId
      ) {
        // A channel can be established a moment before the remote Agent is
        // ready. Clear the guard so the next user-triggered or peer-event
        // refresh can perform another application-level probe.
        lastRemoteWorkspaceProbeRef.current = null;
      }
    });
  }, [agentPeers, loadAgentTargets, sidebarWorkspaceNodeId]);

  useEffect(() => {
    if (currentSession?.remoteAgent) {
      setSidebarWorkspaceNodeId(currentSession.remoteAgent.nodeId);
      return;
    }
    if (currentSession) lastLocalSessionIdRef.current = currentSession.id;
    setSidebarWorkspaceNodeId(null);
  }, [currentId, currentSession?.remoteAgent?.nodeId]);

  const currentAgentTargetValue = currentSession?.remoteAgent
    ? remoteAgentSessionTargetValue(
        currentSession.remoteAgent.nodeId,
        currentSession.remoteAgent.projectId,
        currentSession.remoteAgent.sessionId,
      )
    : "local";

  const changeAgentTarget = useCallback(async (value: string) => {
    if (value === currentAgentTargetValue) return;
    if (value === "local") {
      createSession();
      return;
    }
    const [kind, encodedNodeId, encodedProjectId, encodedSessionId] = value.split("|");
    if (!encodedNodeId || !encodedProjectId) return;
    const nodeId = decodeURIComponent(encodedNodeId);
    const projectId = decodeURIComponent(encodedProjectId);
    const workspace = agentWorkspaces[nodeId];
    const project = workspace?.projects.find((item) => item.projectId === projectId);
    if (!workspace || !project) return;
    setAgentTargetBusy(true);
    try {
      if (kind === "remote-history") {
        const history = await remoteAgentSessions(nodeId, projectId, project.title);
        setAgentSessionLists((current) => ({
          ...current,
          [remoteAgentHistoryKey(nodeId, projectId)]: history,
        }));
        return;
      }
      if (kind === "remote-session" && encodedSessionId) {
        const remoteSessionId = decodeURIComponent(encodedSessionId);
        const transcript = await remoteAgentSessionOpen(
          nodeId,
          projectId,
          project.title,
          remoteSessionId,
        );
        const localProjectId = currentProject?.id ?? "default";
        const existing = allSessionsRef.current.find((session) => (
          session.projectId === localProjectId
          && session.remoteAgent?.nodeId === nodeId
          && session.remoteAgent.projectId === projectId
          && session.remoteAgent.sessionId === remoteSessionId
        ));
        const local = existing ?? makeSession(localProjectId);
        const turns = turnsFromRemoteTranscript(transcript);
        upsertSession({
          ...local,
          projectId: localProjectId,
          title: transcript.title || local.title,
          model: transcript.model ?? null,
          remoteAgent: {
            nodeId: transcript.nodeId,
            nodeName: transcript.nodeName,
            projectId: transcript.projectId,
            projectName: transcript.projectName,
            sessionId: transcript.sessionId,
          },
          turns,
          turnsLoaded: true,
          turnsPartial: transcript.hasMore,
          turnCount: turns.length,
          loadedTurnStartIndex: 0,
          questionCountBeforeLoadedTurns: 0,
          partialBaseTurnIds: undefined,
          updatedAt: Date.now(),
        });
        return;
      }
      if (kind === "remote-new") {
        const remote = await remoteAgentSessionCreate(nodeId, projectId, project.title);
        const local = createSession();
        updateSession(local.id, (session) => ({
          ...session,
          title: remote.title || session.title,
          model: remote.model ?? null,
          remoteAgent: {
            nodeId: remote.nodeId,
            nodeName: remote.nodeName,
            projectId: remote.projectId,
            projectName: remote.projectName,
            sessionId: remote.sessionId,
          },
          updatedAt: Date.now(),
        }));
      }
    } catch (error) {
      setError(String(error));
    } finally {
      setAgentTargetBusy(false);
    }
  }, [
    agentWorkspaces,
    allSessionsRef,
    createSession,
    currentAgentTargetValue,
    currentProject?.id,
    setError,
    updateSession,
    upsertSession,
  ]);

  const selectSidebarWorkspace = useCallback(async (nodeId: string | null) => {
    setSidebarWorkspaceNodeId(nodeId);
    if (nodeId) {
      await loadAgentTargets();
      return;
    }
    const remembered = lastLocalSessionIdRef.current
      ? allSessionsRef.current.find((session) => (
          session.id === lastLocalSessionIdRef.current && !session.remoteAgent
        ))
      : null;
    const local = remembered ?? allSessionsRef.current
      .filter((session) => !session.remoteAgent)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!local) {
      setCurrentId(newSession());
      return;
    }
    if (local.projectId !== currentProject?.id) {
      try {
        await switchProject(local.projectId);
      } catch {
        return;
      }
    }
    setCurrentId(local.id);
  }, [
    allSessionsRef,
    currentProject?.id,
    loadAgentTargets,
    newSession,
    setCurrentId,
    switchProject,
  ]);

  const selectRemoteProject = useCallback((nodeId: string, projectId: string) => (
    changeAgentTarget(remoteAgentHistoryTargetValue(nodeId, projectId))
  ), [changeAgentTarget]);

  const createRemoteChat = useCallback((nodeId: string, projectId: string) => (
    changeAgentTarget(remoteAgentNewTargetValue(nodeId, projectId))
  ), [changeAgentTarget]);

  const openRemoteChat = useCallback((nodeId: string, projectId: string, sessionId: string) => (
    changeAgentTarget(remoteAgentSessionTargetValue(nodeId, projectId, sessionId))
  ), [changeAgentTarget]);

  const addSideTask = useCallback(() => {
    if (!currentProject) return;
    sideTaskSequenceRef.current += 1;
    const sideTaskNumber = sideTaskSequenceRef.current;
    const sideTask: SidePanelTab = {
      kind: "task",
      id: makeId("side-task-tab"),
      projectId: currentProject.id,
      title: language === "cn" ? `侧边任务 ${sideTaskNumber}` : `Side task ${sideTaskNumber}`,
      handoff: null,
    };
    setSideTaskTabs((current) => [...current, sideTask]);
    setActiveSideTaskId(sideTask.id);
    setSideTaskPaneOpen(true);
  }, [currentProject, language]);

  /** Open (or re-focus) a file as a reading tab in the side panel. */
  const openSideFile = useCallback((path: string) => {
    if (!currentProject) return;
    const existing = sideTaskTabs.find((tab) => tab.kind === "file" && tab.path === path);
    if (existing) {
      setActiveSideTaskId(existing.id);
      setSideTaskPaneOpen(true);
      return;
    }
    const fileTab: SidePanelTab = {
      kind: "file",
      id: makeId("side-file-tab"),
      projectId: currentProject.id,
      path,
      title: sideFileTitle(path),
      handoff: null,
    };
    setSideTaskTabs((current) => [...current, fileTab]);
    setActiveSideTaskId(fileTab.id);
    setSideTaskPaneOpen(true);
  }, [currentProject, sideTaskTabs]);

  /** Open a cited PDF at its source page and refresh its evidence overlay. */
  const openSideEvidence = useCallback((evidence: SidePanelEvidenceTarget) => {
    if (!currentProject) return;
    const existing = sideTaskTabs.find(
      (tab) => tab.kind === "file" && tab.path === evidence.path,
    );
    if (existing) {
      setSideTaskTabs((current) => current.map((tab) =>
        tab.id === existing.id && tab.kind === "file"
          ? { ...tab, evidence }
          : tab
      ));
      setActiveSideTaskId(existing.id);
      setSideTaskPaneOpen(true);
      return;
    }
    const fileTab: SidePanelTab = {
      kind: "file",
      id: makeId("side-file-tab"),
      projectId: currentProject.id,
      path: evidence.path,
      title: sideFileTitle(evidence.path),
      handoff: null,
      evidence,
    };
    setSideTaskTabs((current) => [...current, fileTab]);
    setActiveSideTaskId(fileTab.id);
    setSideTaskPaneOpen(true);
  }, [currentProject, sideTaskTabs]);

  const pickSideFile = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        defaultPath: currentProject?.path ?? undefined,
      });
      if (typeof selected === "string") openSideFile(selected);
    } catch (pickError) {
      setError(String(pickError));
    }
  }, [currentProject?.path, openSideFile, setError]);

  const closeSideTask = useCallback((taskId: string) => {
    setSideTaskTabs((current) => {
      const closingIndex = current.findIndex((task) => task.id === taskId);
      const next = current.filter((task) => task.id !== taskId);
      if (activeSideTaskId === taskId) {
        const replacement = next[Math.min(Math.max(closingIndex, 0), next.length - 1)];
        const replacementId = replacement?.id ?? (independentReview ? INDEPENDENT_REVIEW_TAB_ID : IMAGE_WORKFLOW_TAB_ID);
        setActiveSideTaskId(replacementId);
      }
      return next;
    });
  }, [activeSideTaskId, independentReview]);

  const updateSideTaskMetadata = useCallback((taskId: string, metadata: SidePanelMetadata) => {
    setSideTaskTabs((current) => {
      const target = current.find((task) => task.id === taskId);
      if (!target || (target.title === metadata.title && target.handoff === metadata.handoff)) return current;
      return current.map((task) => task.id === taskId ? { ...task, ...metadata } : task);
    });
  }, []);

  // Drag the divider between the main chat and the side panel. The width lands
  // on `.chat-root` as a CSS variable and is remembered across sessions.
  const startSidePanelResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      const available = window.innerWidth;
      const next = Math.round(available - moveEvent.clientX);
      setSidePanelWidth(Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(next, Math.max(SIDE_PANEL_MIN_WIDTH, available - 420))));
    };
    const onUp = () => {
      handle.releasePointerCapture?.(pointerId);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("somniq-resizing-col");
    };
    document.body.classList.add("somniq-resizing-col");
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }, []);

  useEffect(() => {
    if (sidePanelWidth === null) return;
    window.localStorage?.setItem(SIDE_PANEL_WIDTH_KEY, String(sidePanelWidth));
  }, [sidePanelWidth]);

  // File links rendered deep inside the thread (tool cards, markdown links) ask
  // for the side panel through the store rather than prop-drilling a callback.
  useEffect(() => {
    if (!pendingSidePanelFilePath) return;
    openSideFile(pendingSidePanelFilePath);
    setPendingSidePanelFilePath(null);
  }, [openSideFile, pendingSidePanelFilePath, setPendingSidePanelFilePath]);

  useEffect(() => {
    if (!pendingSidePanelEvidence) return;
    openSideEvidence(pendingSidePanelEvidence);
    setPendingSidePanelEvidence(null);
  }, [openSideEvidence, pendingSidePanelEvidence, setPendingSidePanelEvidence]);

  useEffect(() => {
    if (previousProjectIdRef.current === currentProject?.id) return;
    previousProjectIdRef.current = currentProject?.id;
    sideTaskSequenceRef.current = 0;
    setSideTaskTabs([]);
    setActiveSideTaskId(IMAGE_WORKFLOW_TAB_ID);
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
      if (independentReview) {
        setActiveSideTaskId(INDEPENDENT_REVIEW_TAB_ID);
        setSideTaskPaneOpen(true);
        return;
      }
      const latestSideTask = sideTaskTabs[sideTaskTabs.length - 1];
      if (latestSideTask) {
        setActiveSideTaskId((current) => current ?? latestSideTask.id);
        setSideTaskPaneOpen(true);
      } else {
        setActiveSideTaskId(IMAGE_WORKFLOW_TAB_ID);
        setSideTaskPaneOpen(true);
      }
    };
    window.addEventListener("keydown", toggleSideTask);
    return () => window.removeEventListener("keydown", toggleSideTask);
  }, [independentReview, sideTaskPaneOpen, sideTaskTabs]);

  const starters = CHAT_STARTERS[language];
  const welcomeCopy = language === "cn"
    ? {
      title: <>梦中<span className="chat-welcome-highlight chat-welcome-highlight-cyan">求索</span>，醒时<span className="chat-welcome-highlight chat-welcome-highlight-purple">有获</span></>,
      description: "SomniQ 在后台持续推理、检索、分析与生成，把问题推进成答案。",
    }
    : {
      title: <>Seek in <span className="chat-welcome-highlight chat-welcome-highlight-cyan">Dreams</span>, harvest on <span className="chat-welcome-highlight chat-welcome-highlight-purple">waking</span></>,
      description: "SomniQ keeps reasoning, searching, analyzing, and generating in the background—turning questions into progress.",
    };
  const [loadingOmittedTurns, setLoadingOmittedTurns] = useState<Set<string>>(() => new Set());
  const loadingOmittedTurnKeysRef = useRef<Set<string>>(new Set());
  const [loadingEarlierSessions, setLoadingEarlierSessions] = useState<Set<string>>(() => new Set());
  const loadingEarlierSessionsRef = useRef<Set<string>>(new Set());

  const turns = currentSession?.turns ?? [];
  const [persistedTodos, setPersistedTodos] = useState<Record<string, ChatTodoItem[]>>({});
  const workflowSession = Boolean(
    currentSession?.ownerKind === "review_workflow"
    || currentSession?.workflowContextKey?.startsWith("review-workflow:"),
  );
  const { editingTurnId, focusComposer, setEditingTurnId } = composer;
  const { status, activeModel } = run;
  // Remote phone turns are rendered from the encrypted bridge rather than the
  // local stream hook. Read only the bridge's live buffer here: persisted turn
  // flags cannot prove that a transport is still active after a crash.
  const currentChatBusy = run.currentChatBusy || isRemoteSessionStreaming(currentId);
  const { pendingCommandSelection, setPendingCommandSelection } = commands;

  const turnTodos = useMemo(() => latestTodosFromTurns(turns), [turns]);
  useEffect(() => {
    if (!isTauri() || !currentSession || currentSession.remoteAgent) return;
    let active = true;
    void chatTasksGet(currentSession.id)
      .then((todos) => {
        if (active) {
          setPersistedTodos((current) => ({ ...current, [currentSession.id]: todos }));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [currentSession?.id, currentSession?.remoteAgent]);
  const workflowTodos = turnTodos.length > 0
    ? turnTodos
    : persistedTodos[currentId] ?? [];
  const workflowFileChanges = useMemo(
    () => latestFileChangesFromTurns(turns, currentProject?.path),
    [currentProject?.path, turns],
  );
  // A file already open as a side-panel reading tab (a compiled PDF, most
  // commonly) doesn't otherwise notice the agent regenerated it mid-turn —
  // the tab keeps rendering whatever it first loaded. Bump a per-tab
  // remount generation once the turn that touched it finishes, rather than
  // on every intermediate change, so a compile/fix/recompile loop within one
  // turn doesn't remount the viewer repeatedly.
  const [sideFileReloadGenerations, setSideFileReloadGenerations] = useState<Record<string, number>>({});
  const wasChatBusyRef = useRef(currentChatBusy);
  useEffect(() => {
    const wasBusy = wasChatBusyRef.current;
    wasChatBusyRef.current = currentChatBusy;
    if (!wasBusy || currentChatBusy || workflowFileChanges.length === 0) return;
    setSideFileReloadGenerations((current) => {
      let changed = false;
      const next = { ...current };
      for (const tab of sideTaskTabs) {
        if (tab.kind !== "file") continue;
        const touched = workflowFileChanges.some((change) => fileChangePathMatches(change.path, tab.path, currentProject?.path));
        if (!touched) continue;
        next[tab.id] = (next[tab.id] ?? 0) + 1;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [currentChatBusy, currentProject?.path, sideTaskTabs, workflowFileChanges]);

  const workflowFileChangeSummary = useMemo(
    () => fileChangeSummaryFromTurns(turns),
    [turns],
  );

  const navigationCopy = language === "cn"
    ? {
      label: "侧栏导航",
      add: "新增侧栏标签",
      addTask: "新建侧边任务",
      addTaskHint: "继承项目上下文的只读旁路对话",
      addFile: "打开文件…",
      addFileHint: "在侧栏阅读 PDF、Markdown、代码等",
      close: "关闭侧栏标签",
      hide: "隐藏侧栏",
      toggle: "显示或隐藏侧栏",
      handoff: "发送到主任务",
      resize: "调整侧栏宽度",
    }
    : {
      label: "Side panel navigation",
      add: "Add side panel tab",
      addTask: "New side task",
      addTaskHint: "Read-only detour that inherits project context",
      addFile: "Open file…",
      addFileHint: "Read PDFs, markdown, and code beside the chat",
      close: "Close side panel tab",
      hide: "Hide side panel",
      toggle: "Show or hide side panel",
      handoff: "Send to main task",
      resize: "Resize side panel",
    };
  const navigationTabs = useMemo<ChatNavigationTab[]>(() => ([
    {
      id: IMAGE_WORKFLOW_TAB_ID,
      label: language === "cn" ? "图片工作流" : "Image workflow",
      icon: <SvgIcon name="graph" size={13} />,
      closable: false,
    },
    ...(independentReview ? [{
      id: INDEPENDENT_REVIEW_TAB_ID,
      label: language === "cn" ? "独立 Reviewer" : "Independent Reviewer",
      icon: <SvgIcon name="target" size={13} />,
      closable: false,
    }] : []),
    ...sideTaskTabs.map((sideTask) => ({
      id: sideTask.id,
      label: sideTask.title,
      icon: <SvgIcon name={sideTask.kind === "file" ? "document" : "sparkle"} size={13} />,
      title: sideTask.kind === "file" ? sideTask.path : sideTask.title,
      closable: true,
      closeLabel: `${navigationCopy.close}: ${sideTask.title}`,
    })),
  ]), [independentReview, language, navigationCopy.close, sideTaskTabs]);
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

  const openIndependentReview = useCallback(() => {
    setActiveSideTaskId(INDEPENDENT_REVIEW_TAB_ID);
    setSideTaskPaneOpen(true);
  }, []);

  const send = async () => {
    if (!currentSession || run.sendLocks.current.has(currentSession.id) || currentChatBusy || (!composer.input.trim() && composer.attachments.length === 0)) return;
    if (currentSession.remoteAgent && composer.attachments.length > 0) {
      setError(language === "cn"
        ? "远程 Agent 对话暂不支持附件；请先移除附件再发送。"
        : "Remote Agent chat does not support attachments yet. Remove them before sending.");
      return;
    }
    const sessionId = currentSession.id;
    const sendLock = run.acquireSendLock(sessionId);
    if (sendLock == null) return;
    try {
      if (!status?.ready && !currentSession.remoteAgent && (!composer.input.trim().startsWith("/") || composer.attachments.length > 0)) return;
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
      run.releaseSendLock(sessionId, sendLock);
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
    if (session.remoteAgent) {
      setError(language === "cn"
        ? "远程 Agent 的历史轮次不能在本机重写；可以继续发送一条更正消息。"
        : "Remote Agent history cannot be rewritten locally; send a correction as a new message.");
      return;
    }
    setDraft(session.id, textFromTurn(turn));
    updateSession(session.id, (item) => ({ ...item, draftAttachments: turn.attachments ?? [] }));
    setEditingTurnId(turn.id);
    focusComposer();
  }, [focusComposer, language, run.runningSessionIdsRef, setDraft, setEditingTurnId, setError, updateSession]);

  const startFromPrompt = useCallback((prompt: string) => {
    const session = currentSessionRef.current;
    if (!session) return;
    setDraft(session.id, prompt);
    focusComposer();
  }, [currentSessionRef, focusComposer, setDraft]);

  const openWorkflowFile = useOpenChatFile();

  const loadOmittedTurn = useCallback(async (turnIndex: number) => {
    const session = currentSessionRef.current;
    if (!session || !isTauri()) return;
    const key = `${session.id}:${turnIndex}`;
    if (loadingOmittedTurnKeysRef.current.has(key)) return;
    loadingOmittedTurnKeysRef.current.add(key);
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
      loadingOmittedTurnKeysRef.current.delete(key);
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

  const loadEarlierTurns = useCallback(async () => {
    const session = currentSessionRef.current;
    if (!session || !isTauri() || loadingEarlierSessionsRef.current.has(session.id)) return;
    const total = session.turnCount ?? session.turns.length;
    const loadedTurnStartIndex = session.loadedTurnStartIndex
      ?? Math.max(0, total - session.turns.length);
    if (!session.turnsPartial || loadedTurnStartIndex === 0) return;
    const startIndex = Math.max(0, loadedTurnStartIndex - CHAT_UI_EARLIER_TURN_BATCH_SIZE);
    loadingEarlierSessionsRef.current.add(session.id);
    setLoadingEarlierSessions((current) => new Set(current).add(session.id));
    try {
      const rawTurns = await Promise.all(
        Array.from(
          { length: loadedTurnStartIndex - startIndex },
          (_, offset) => chatUiTurnLoad<Partial<ChatTurn> & Record<string, unknown>>(
            session.id,
            startIndex + offset,
          ),
        ),
      );
      prependEarlierTurns(session.id, startIndex, rawTurns.map(migrateTurn));
    } catch (error) {
      setError(`Failed to load earlier messages: ${String(error)}`);
    } finally {
      loadingEarlierSessionsRef.current.delete(session.id);
      setLoadingEarlierSessions((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  }, [prependEarlierTurns, setError]);

  const updateComposerInput = useCallback((value: string) => {
    if (pendingCommandSelection) setPendingCommandSelection(null);
    const session = currentSessionRef.current;
    if (session) setDraft(session.id, value);
  }, [currentSessionRef, pendingCommandSelection, setDraft, setPendingCommandSelection]);

  const stopComposer = useCallback(() => {
    run.cancelSendLock(currentId);
    void run.stop(currentId);
  }, [currentId, run.cancelSendLock, run.stop]);

  const cancelEdit = useCallback(() => setEditingTurnId(null), [setEditingTurnId]);

  // A running background process is worth showing even before the first brief
  // exists — that is exactly when an unnoticed dev server is easiest to lose.
  const projectBriefAvailable = projectBrief.brief !== null
    || projectBrief.repository !== null
    || background.processes.length > 0
    || imageAssistActivity !== null;
  const projectBriefVisible = tab === "chat"
    && !sideTaskPaneOpen
    && !projectBrief.hidden
    && projectBriefAvailable;

  return (
    <div
      className={`chat-root${projectBriefVisible ? " chat-project-brief-open" : ""}${sideTaskPaneOpen && tab === "chat" ? " side-task-open" : ""}`}
      style={{
        "--chat-sidebar-w": `${sessionCtl.chatSidebarWidth}px`,
        ...(sidePanelWidth === null ? {} : { "--side-panel-w": `${sidePanelWidth}px` }),
      } as CSSProperties}
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
        sessionsHydrated={sessionsHydrated}
        onClose={() => sessionCtl.setSidebarOpen(false)}
        onNew={async (projectId) => {
          setSidebarWorkspaceNodeId(null);
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
          setSidebarWorkspaceNodeId(null);
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
        remotePeers={agentPeers}
        remoteWorkspaces={agentWorkspaces}
        remoteSessionLists={agentSessionLists}
        selectedWorkspaceNodeId={sidebarWorkspaceNodeId}
        currentRemoteAgent={currentSession?.remoteAgent}
        remoteBusy={agentTargetBusy}
        onLoadRemoteTargets={() => { void loadAgentTargets(); }}
        onWorkspaceSelect={(nodeId) => { void selectSidebarWorkspace(nodeId); }}
        onRemoteProjectSelect={selectRemoteProject}
        onNewRemote={createRemoteChat}
        onOpenRemote={openRemoteChat}
      />
      <div
        className="chat-sidebar-resize-handle"
        onPointerDown={sessionCtl.onChatSidebarResizeStart}
        onPointerMove={sessionCtl.onChatSidebarResizeMove}
        onPointerUp={sessionCtl.onChatSidebarResizeEnd}
        onPointerCancel={sessionCtl.onChatSidebarResizeEnd}
      />
      <main
        ref={chatMainRef}
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
            <span className="chat-drop-full-icon"><SvgIcon name="attachment" size={32} /></span>
            <span>拖放文件以附加</span>
          </div>
        )}

        {tab === "chat" && document.getElementById("app-chat-actions-portal") && createPortal(
          <div className="chat-head-actions" data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {status?.memoryFiles != null && status.memoryFiles > 0 && (
              <MemoryBadge count={status.memoryFiles} />
            )}
            <div className="chat-head-actions-group">
              <button
                className="chat-export-btn"
                onClick={() => void commands.exportCurrentChat()}
                disabled={currentChatBusy || commands.exporting || commands.debugExporting || turns.length === 0}
                title={copy.exportChat}
                aria-label={copy.exportChat}
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
                className="chat-export-btn chat-debug-btn"
                onClick={() => void commands.exportDebugZip()}
                disabled={commands.exporting || commands.debugExporting || turns.length === 0}
                title={copy.exportDebugZip ?? "Export debug zip"}
                aria-label={copy.exportDebugZip ?? "Export debug zip"}
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
            </div>
            {!status?.ready && <button onClick={() => setTab("settings")}>{copy.settings}</button>}
            <div className="chat-head-actions-group">
              {projectBriefAvailable && !sideTaskPaneOpen && (
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
                  {background.processes.length > 0 && (
                    <span
                      className="chat-project-brief-badge"
                      title={language === "cn"
                        ? `${background.processes.length} 个后台进程正在运行`
                        : `${background.processes.length} background processes running`}
                    >
                      {background.processes.length}
                    </span>
                  )}
                </button>
              )}
              <button
                type="button"
                className={`chat-side-task-toggle${sideTaskPaneOpen ? " active" : ""}`}
                onClick={() => {
                  if (sideTaskPaneOpen) setSideTaskPaneOpen(false);
                  else {
                    setActiveSideTaskId((current) => current ?? IMAGE_WORKFLOW_TAB_ID);
                    setSideTaskPaneOpen(true);
                  }
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
            </div>
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
          language={language}
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
          hasEarlierTurns={Boolean(
            currentSession?.turnsPartial
            && (currentSession.loadedTurnStartIndex
              ?? Math.max(0, (currentSession.turnCount ?? turns.length) - turns.length)) > 0
          )}
          loadingEarlierTurns={loadingEarlierSessions.has(currentId)}
          onLoadEarlierTurns={loadEarlierTurns}
          onPermissionRespond={run.respondPermission}
          onQuestionRespond={run.respondQuestion}
          onOpenIndependentReview={openIndependentReview}
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
          permission={currentSession?.remoteAgent || workflowSession ? null : run.permission}
          permissionBusy={run.permissionBusy}
          onPermissionChange={run.changePermission}
          modelName={status?.ready ? activeModel : null}
          modelOptions={workflowSession ? [] : run.modelSelectOptions}
          modelBusy={run.modelBusy}
          canSwitchModel={!workflowSession && run.canSwitchModel}
          onModelChange={run.changeModel}
          reasoningSupported={!workflowSession && !currentSession?.remoteAgent && run.reasoning.supported}
          reasoningApplied={run.reasoning.applied}
          reasoningMessage={run.reasoning.message}
          reasoningEffort={run.reasoning.effort}
          reasoningBusy={run.reasoningBusy}
          onReasoningEffortChange={run.changeReasoningEffort}
          contextUsed={currentSession?.remoteAgent || workflowSession ? undefined : run.estimatedTokens}
          contextMax={currentSession?.remoteAgent || workflowSession ? null : run.contextMax}
          contextStatus={currentSession?.remoteAgent || workflowSession ? null : run.currentContextNotice}
          onContextStatusDismiss={run.dismissContextNotice}
          onInputChange={updateComposerInput}
          onAttachmentsChange={composer.setAttachments}
          attachmentsEnabled={!currentSession?.remoteAgent && !workflowSession}
          onSubmit={submitComposer}
          onStop={stopComposer}
          onCancelEdit={cancelEdit}
          onHeightChange={composer.setComposerHeight}
        />
          </>
        )}
      </main>
      {navigationTabs.length > 0 && (
        <aside
          id="side-task-panel"
          className="side-task-slot"
          aria-label={navigationCopy.label}
          hidden={!sideTaskPaneOpen || tab !== "chat"}
        >
          <div
            className="side-panel-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={navigationCopy.resize}
            onPointerDown={startSidePanelResize}
            onDoubleClick={() => setSidePanelWidth(null)}
          />
          <ChatNavigationTabs
            tabs={navigationTabs}
            activeTabId={activeSideTaskId ?? navigationTabs[0]?.id ?? ""}
            label={navigationCopy.label}
            addLabel={navigationCopy.add}
            addOptions={[
              { id: "task", label: navigationCopy.addTask, hint: navigationCopy.addTaskHint, icon: <SvgIcon name="sparkle" size={13} />, onSelect: addSideTask },
              { id: "file", label: navigationCopy.addFile, hint: navigationCopy.addFileHint, icon: <SvgIcon name="document" size={13} />, onSelect: () => void pickSideFile() },
            ]}
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
            <section
              id={`chat-workspace-${IMAGE_WORKFLOW_TAB_ID}`}
              className="chat-workspace-view"
              role="tabpanel"
              aria-label={language === "cn" ? "图片节点工作流" : "Image node workflow"}
              hidden={activeSideTaskId !== IMAGE_WORKFLOW_TAB_ID}
            >
              {sideTaskPaneOpen && activeSideTaskId === IMAGE_WORKFLOW_TAB_ID && (
                <ImageWorkflowPanel
                  key={currentId}
                  sessionId={currentId}
                  turns={turns}
                  language={language}
                  onSendToChat={sendHandoffToMain}
                />
              )}
            </section>
            {independentReview && (
              <section
                id="chat-workspace-independent-review"
                className="chat-workspace-view"
                role="tabpanel"
                aria-label={language === "cn" ? "独立 Reviewer" : "Independent Reviewer"}
                hidden={activeSideTaskId !== INDEPENDENT_REVIEW_TAB_ID}
              >
                <IndependentReviewPanel
                  state={independentReview}
                  language={language}
                  onClear={() => {
                    if (currentId) void chatReviewClear(currentId).catch(() => undefined);
                  }}
                />
              </section>
            )}
            {sideTaskTabs.map((sideTask) => (
              <section
                key={sideTask.id}
                id={`chat-workspace-${sideTask.id}`}
                className="chat-workspace-view"
                role="tabpanel"
                aria-label={sideTask.title}
                hidden={activeSideTaskId !== sideTask.id}
              >
                {sideTask.kind === "file" ? (
                  <SideFileViewer
                    key={`${sideTask.id}::${sideFileReloadGenerations[sideTask.id] ?? 0}`}
                    tabId={sideTask.id}
                    path={sideTask.path}
                    evidence={sideTask.evidence}
                    onOpenInWorkspace={openWorkflowFile}
                    onMetadataChange={updateSideTaskMetadata}
                  />
                ) : (
                  <SideTaskPanel
                    taskId={sideTask.id}
                    initialTitle={sideTask.title}
                    projectId={sideTask.projectId}
                    model={activeModel}
                    ready={Boolean(status?.ready)}
                    onMetadataChange={updateSideTaskMetadata}
                  />
                )}
              </section>
            ))}
          </div>
        </aside>
      )}
      {projectBriefVisible && (
        <aside
          id="project-brief-popover"
          className="chat-project-brief-sidebar"
          aria-label={language === "cn" ? "项目摘要" : "Project summary"}
        >
          <ProjectBriefCard
            brief={projectBrief.brief}
            repository={projectBrief.repository}
            language={language}
            onHide={() => projectBrief.setHidden(true)}
            reviewEnabled={projectBrief.reviewEnabled}
            reviewSaving={projectBrief.reviewSaving}
            reviewError={projectBrief.reviewError}
            onReviewEnabledChange={(enabled) => void projectBrief.setReviewEnabled(enabled)}
            backgroundProcesses={background.processes}
            stoppingBackgroundPids={background.stopping}
            onStopBackgroundProcess={(pid) => void background.stop(pid)}
            onOpenBackgroundLog={openSideFile}
            imageAssistActivity={imageAssistActivity}
            onDismissImageAssistActivity={() => publishImageAssistActivity(null)}
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
          onOpenInWorkspace={openWorkflowFile}
          onOpenInSidePanel={openSideFile}
          onClose={() => composer.setFileMenu(null)}
          onAttach={(path, content) => void composer.attachFileFromMenu(path, content)}
        />
      )}
    </div>
  );
}
