import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { fileOpen, fileReveal } from "../api/tauri";
import { SvgIcon } from "../SvgIcon";
import type { ChatTurn } from "../types";
import ChatImagePreview from "./ChatImagePreview";
import {
  formatImageMeta,
  imageWorkflowCallsFromTurns,
  layoutImageWorkflow,
} from "./imageWorkflowModel";
import type { ImageWorkflowGeneration, ImageWorkflowNode } from "./imageWorkflowModel";

interface NodeDraft {
  title?: string;
  content?: string;
}

interface SavedWorkflowState {
  acceptedId: string | null;
  drafts: Record<string, NodeDraft>;
}

const WORKFLOW_STORAGE_PREFIX = "somniq-image-workflow-v1";
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.6;
const INSPECTOR_STORAGE_KEY = `${WORKFLOW_STORAGE_PREFIX}:inspector-open`;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

function loadState(sessionId: string): SavedWorkflowState {
  try {
    const raw = window.localStorage?.getItem(`${WORKFLOW_STORAGE_PREFIX}:${sessionId}`);
    if (!raw) return { acceptedId: null, drafts: {} };
    const parsed = JSON.parse(raw) as Partial<SavedWorkflowState>;
    const drafts: Record<string, NodeDraft> = {};
    if (parsed.drafts && typeof parsed.drafts === "object" && !Array.isArray(parsed.drafts)) {
      for (const [nodeId, value] of Object.entries(parsed.drafts)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const draft = value as NodeDraft;
        drafts[nodeId] = {
          ...(typeof draft.title === "string" ? { title: draft.title } : {}),
          ...(typeof draft.content === "string" ? { content: draft.content } : {}),
        };
      }
    }
    return {
      acceptedId: typeof parsed.acceptedId === "string" ? parsed.acceptedId : null,
      drafts,
    };
  } catch {
    return { acceptedId: null, drafts: {} };
  }
}

function truncate(value: string, length: number): string {
  const characters = [...value.replace(/\s+/g, " ").trim()];
  return characters.length > length ? `${characters.slice(0, length).join("")}…` : characters.join("");
}

interface Props {
  sessionId: string;
  turns: ChatTurn[];
  language: "cn" | "en";
  onSendToChat: (prompt: string) => void;
}

export default function ImageWorkflowPanel({ sessionId, turns, language, onSendToChat }: Props) {
  const cn = language === "cn";
  const calls = useMemo(() => imageWorkflowCallsFromTurns(turns), [turns]);
  const layout = useMemo(() => layoutImageWorkflow(calls), [calls]);
  const [saved, setSaved] = useState<SavedWorkflowState>(() => loadState(sessionId));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<"fit" | "manual">("fit");
  const [fitToken, setFitToken] = useState(0);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(
    () => window.localStorage?.getItem(INSPECTOR_STORAGE_KEY) !== "0",
  );
  const [handoffSent, setHandoffSent] = useState(false);
  const [panning, setPanning] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLElement>());
  const zoomRef = useRef(zoom);
  const knownGenerationIds = useRef<string[] | null>(null);
  const lightboxOpener = useRef<HTMLElement | null>(null);
  const focusRequest = useRef<string | null>(null);

  const allGenerations = useMemo(() => calls.flatMap((call) => call.generations), [calls]);
  const previewableGenerations = useMemo(
    () => allGenerations.filter((generation): generation is ImageWorkflowGeneration & { path: string } => Boolean(generation.path)),
    [allGenerations],
  );
  const allNodeIds = useMemo(() => layout.nodes.map((node) => node.id), [layout]);
  const nodesById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node] as const)),
    [layout],
  );

  const registerNode = useCallback((nodeId: string, element: HTMLElement | null) => {
    if (element) nodeRefs.current.set(nodeId, element);
    else nodeRefs.current.delete(nodeId);
  }, []);

  const revealNode = useCallback((nodeId: string) => {
    nodeRefs.current.get(nodeId)?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, []);

  const applyZoom = useCallback((next: number, anchor?: { x: number; y: number }) => {
    const container = scrollRef.current;
    const current = zoomRef.current;
    const clamped = clampZoom(next);
    setZoomMode("manual");
    if (clamped === current) return;
    zoomRef.current = clamped;
    setZoom(clamped);
    if (!container) return;
    const anchorX = anchor?.x ?? container.clientWidth / 2;
    const anchorY = anchor?.y ?? container.clientHeight / 2;
    const contentX = (container.scrollLeft + anchorX) / current;
    const contentY = (container.scrollTop + anchorY) / current;
    // The stage is scaled, so keep the point under the cursor pinned in place.
    requestAnimationFrame(() => {
      container.scrollLeft = contentX * clamped - anchorX;
      container.scrollTop = contentY * clamped - anchorY;
    });
  }, []);

  // Re-entering fit mode has to re-measure even when the mode is unchanged,
  // so the token — not the mode — is what restarts the effect.
  const requestFit = useCallback(() => {
    setZoomMode("fit");
    setFitToken((token) => token + 1);
  }, []);

  useEffect(() => {
    setSaved(loadState(sessionId));
    setSelectedId(null);
    setCompareIds([]);
    setLightboxId(null);
    requestFit();
    knownGenerationIds.current = null;
  }, [requestFit, sessionId]);

  // "Fit" is a mode, not a one-shot: the canvas keeps fitting while the side
  // panel is dragged wider or narrower until the user zooms manually. Only the
  // width is fitted — the graph grows downwards without bound, so fitting the
  // height too would shrink the nodes past readability after a few calls.
  useEffect(() => {
    const container = scrollRef.current;
    if (zoomMode !== "fit" || !container || calls.length === 0) return;
    let frame = 0;
    let attempts = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      const width = container.clientWidth - 12;
      if (width <= 0) {
        // The pane can still be laying out on first paint. Retry briefly rather
        // than leaving the canvas stranded at 100% zoom.
        if (attempts < 30) {
          attempts += 1;
          frame = requestAnimationFrame(measure);
        }
        return;
      }
      attempts = 0;
      const next = clampZoom(Math.min(width / layout.width, 1));
      zoomRef.current = next;
      setZoom(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [calls.length, fitToken, layout.width, zoomMode]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      applyZoom(zoomRef.current * (event.deltaY < 0 ? 1.12 : 1 / 1.12), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  useEffect(() => {
    window.localStorage?.setItem(`${WORKFLOW_STORAGE_PREFIX}:${sessionId}`, JSON.stringify(saved));
  }, [saved, sessionId]);

  useEffect(() => {
    window.localStorage?.setItem(INSPECTOR_STORAGE_KEY, inspectorOpen ? "1" : "0");
  }, [inspectorOpen]);

  useEffect(() => {
    const validIds = new Set(allNodeIds);
    setSaved((current) => {
      const drafts = Object.fromEntries(Object.entries(current.drafts).filter(([nodeId]) => validIds.has(nodeId)));
      const acceptedId = current.acceptedId && validIds.has(current.acceptedId) ? current.acceptedId : null;
      if (acceptedId === current.acceptedId && Object.keys(drafts).length === Object.keys(current.drafts).length) return current;
      return { acceptedId, drafts };
    });
    setCompareIds((current) => current.filter((nodeId) => validIds.has(nodeId)));
    setLightboxId((current) => current && validIds.has(current) ? current : null);
  }, [allNodeIds]);

  // Follow the run: a freshly produced version selects itself and scrolls into
  // view instead of appearing somewhere off-canvas.
  useEffect(() => {
    const currentIds = allGenerations.map((generation) => generation.id);
    const previousIds = knownGenerationIds.current;
    knownGenerationIds.current = currentIds;
    if (previousIds === null) {
      const initial = currentIds.at(-1) ?? calls[0]?.promptNodeId ?? null;
      setSelectedId(initial);
      return;
    }
    const known = new Set(previousIds);
    const arrived = currentIds.filter((id) => !known.has(id)).at(-1);
    if (arrived) setSelectedId(arrived);
  }, [allGenerations, calls]);

  useEffect(() => {
    if (selectedId && allNodeIds.includes(selectedId)) return;
    setSelectedId(allNodeIds.at(-1) ?? null);
  }, [allNodeIds, selectedId]);

  // Keyboard traversal must carry DOM focus with it, otherwise the roving
  // tabindex strands focus on the node the user just left.
  useEffect(() => {
    if (!selectedId) return;
    revealNode(selectedId);
    if (focusRequest.current !== selectedId) return;
    focusRequest.current = null;
    nodeRefs.current.get(selectedId)?.focus?.();
  }, [revealNode, selectedId]);

  useEffect(() => {
    if (!handoffSent) return;
    const timer = window.setTimeout(() => setHandoffSent(false), 2400);
    return () => window.clearTimeout(timer);
  }, [handoffSent]);

  const selectedCall = calls.find((call) => (
    call.promptNodeId === selectedId || call.generations.some((generation) => generation.id === selectedId)
  )) ?? null;
  const selectedGeneration = selectedCall?.generations.find((generation) => generation.id === selectedId) ?? null;
  const selectedGenerationPath = selectedGeneration?.path ?? null;
  const selectedIsPrompt = selectedCall?.promptNodeId === selectedId;
  const selectedDraft = selectedId ? saved.drafts[selectedId] ?? {} : {};
  const lightboxIndex = previewableGenerations.findIndex((generation) => generation.id === lightboxId);
  const lightboxGeneration = lightboxIndex >= 0 ? previewableGenerations[lightboxIndex] : null;

  const copy = cn
    ? {
      title: "图片节点工作流",
      subtitle: "画布只投影 Chat 中真实发生的图片提示词、调用与输出。",
      fit: "适应宽度",
      zoomIn: "放大",
      zoomOut: "缩小",
      canvasHint: "拖拽空白处平移 · Ctrl+滚轮缩放 · 方向键切换节点",
      emptyTitle: "当前对话还没有图片节点",
      emptyDescription: "在 Chat 中调用 ChatGptWebImage 后，真实提示词和生成结果会自动出现在这里。",
      emptyAction: "在输入框起草第一次生成",
      emptyTemplate: "请调用 ChatGptWebImage 生成图片。\n\n提示词：",
      prompt: "提示词",
      output: "图片输出",
      running: "生成中",
      failed: "生成失败",
      complete: "已生成",
      accepted: "已采纳",
      accept: "采纳版本",
      unaccept: "取消采纳",
      compare: "加入对比",
      removeCompare: "移出对比",
      enlarge: "放大查看",
      selected: "编辑节点",
      source: "来自对话记录",
      derived: "基于上一版",
      titleLabel: "节点标题",
      promptLabel: "提示词内容",
      revisionLabel: "下一版修改要求",
      revisionPlaceholder: "说明下一版需要改变什么；不会修改原始聊天记录。",
      reset: "恢复为对话内容",
      send: "填入 Chat 输入框",
      sent: "已填入，按 Enter 发送",
      compareTitle: "版本对比",
      clearCompare: "清空",
      swapCompare: "交换 A / B",
      removeSlot: "移出对比",
      closePreview: "关闭大图",
      previous: "上一张",
      next: "下一张",
      copyPath: "复制路径",
      copied: "已复制",
      openFile: "用系统程序打开",
      revealFile: "在文件夹中显示",
      original: "原始对话内容",
      hideInspector: "收起编辑面板",
      showInspector: "展开编辑面板",
      quick: ["保持构图，只修正文案", "增强层级和可读性", "生成一个明显不同的方案"],
    }
    : {
      title: "Image node workflow",
      subtitle: "The canvas projects only prompts, calls, and outputs that actually occurred in Chat.",
      fit: "Fit width",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      canvasHint: "Drag empty space to pan · Ctrl+wheel to zoom · Arrow keys move between nodes",
      emptyTitle: "No image nodes in this conversation",
      emptyDescription: "After Chat calls ChatGptWebImage, its real prompt and output appear here automatically.",
      emptyAction: "Draft the first generation",
      emptyTemplate: "Use ChatGptWebImage to generate an image.\n\nPrompt: ",
      prompt: "Prompt",
      output: "Image output",
      running: "Generating",
      failed: "Failed",
      complete: "Generated",
      accepted: "Accepted",
      accept: "Accept version",
      unaccept: "Unaccept",
      compare: "Add to compare",
      removeCompare: "Remove from compare",
      enlarge: "Enlarge image",
      selected: "Edit node",
      source: "From Chat transcript",
      derived: "Derived from an earlier version",
      titleLabel: "Node title",
      promptLabel: "Prompt content",
      revisionLabel: "Next-version instruction",
      revisionPlaceholder: "Describe what the next version should change. The original transcript remains unchanged.",
      reset: "Restore transcript content",
      send: "Send to Chat composer",
      sent: "Added to composer — press Enter",
      compareTitle: "Version compare",
      clearCompare: "Clear",
      swapCompare: "Swap A / B",
      removeSlot: "Remove from compare",
      closePreview: "Close large preview",
      previous: "Previous image",
      next: "Next image",
      copyPath: "Copy path",
      copied: "Copied",
      openFile: "Open with system viewer",
      revealFile: "Show in folder",
      original: "Original transcript content",
      hideInspector: "Collapse editor",
      showInspector: "Expand editor",
      quick: ["Keep composition; fix copy only", "Improve hierarchy and legibility", "Create a clearly different direction"],
    };

  const updateDraft = (patch: Partial<NodeDraft>) => {
    if (!selectedId) return;
    setSaved((current) => ({
      ...current,
      drafts: {
        ...current.drafts,
        [selectedId]: { ...current.drafts[selectedId], ...patch },
      },
    }));
  };

  const resetDraft = () => {
    if (!selectedId) return;
    setSaved((current) => {
      const drafts = { ...current.drafts };
      delete drafts[selectedId];
      return { ...current, drafts };
    });
  };

  const sendToChat = () => {
    if (!selectedCall) return;
    const sourcePath = selectedGeneration?.path ?? selectedCall.referencePaths.at(-1) ?? null;
    const instruction = selectedIsPrompt
      ? selectedDraft.content?.trim() || selectedCall.prompt
      : selectedDraft.content?.trim() || copy.quick[0];
    const chatPrompt = sourcePath
      ? cn
        ? `请基于图片 ${sourcePath} 创建一个新版本，并调用 ChatGptWebImage 完成生成。\n\n修改要求：${instruction}\n\n保留未被明确要求修改的内容。`
        : `Create a new version from ${sourcePath} and use ChatGptWebImage to generate it.\n\nRevision: ${instruction}\n\nPreserve everything not explicitly requested to change.`
      : cn
        ? `请调用 ChatGptWebImage 生成图片。\n\n提示词：${instruction}`
        : `Use ChatGptWebImage to generate an image.\n\nPrompt: ${instruction}`;
    onSendToChat(chatPrompt);
    setHandoffSent(true);
  };

  const toggleCompare = (generationId: string) => {
    setCompareIds((current) => current.includes(generationId)
      ? current.filter((id) => id !== generationId)
      : [...current.slice(-1), generationId]);
  };

  const toggleAccepted = (generationId: string) => {
    setSaved((current) => ({
      ...current,
      acceptedId: current.acceptedId === generationId ? null : generationId,
    }));
  };

  const openLightbox = (generationId: string) => {
    lightboxOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLightboxId(generationId);
  };

  const closeLightbox = useCallback(() => {
    setLightboxId(null);
    lightboxOpener.current?.focus?.();
    lightboxOpener.current = null;
  }, []);

  const stepLightbox = useCallback((delta: number) => {
    setLightboxId((current) => {
      const index = previewableGenerations.findIndex((generation) => generation.id === current);
      if (index < 0 || previewableGenerations.length === 0) return current;
      const nextIndex = (index + delta + previewableGenerations.length) % previewableGenerations.length;
      return previewableGenerations[nextIndex].id;
    });
  }, [previewableGenerations]);

  useEffect(() => {
    if (!lightboxId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeLightbox();
      else if (event.key === "ArrowLeft") stepLightbox(-1);
      else if (event.key === "ArrowRight") stepLightbox(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeLightbox, lightboxId, stepLightbox]);

  // Arrow keys walk the graph: up/down move along a column, left/right cross
  // between a prompt and the versions it produced.
  const moveSelection = (key: string) => {
    const current = selectedId ? nodesById.get(selectedId) : null;
    if (!current) return;
    let target: ImageWorkflowNode | null = null;
    if (key === "ArrowUp" || key === "ArrowDown") {
      const column = layout.nodes.filter((node) => node.kind === current.kind);
      const index = column.findIndex((node) => node.id === current.id);
      target = column[index + (key === "ArrowDown" ? 1 : -1)] ?? null;
    } else if ((key === "ArrowRight") === (current.kind === "prompt")) {
      target = layout.nodes.find((node) => node.callId === current.callId && node.kind !== current.kind) ?? null;
    }
    if (!target) return;
    focusRequest.current = target.id;
    setSelectedId(target.id);
  };

  const onCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    moveSelection(event.key);
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    if (!container) return;
    const target = event.target as HTMLElement;
    const onBackground = !target.closest(".image-flow-node");
    if (!(event.button === 1 || (event.button === 0 && onBackground))) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = container.scrollLeft;
    const startTop = container.scrollTop;
    container.setPointerCapture?.(pointerId);
    setPanning(true);
    const onMove = (moveEvent: PointerEvent) => {
      container.scrollLeft = startLeft - (moveEvent.clientX - startX);
      container.scrollTop = startTop - (moveEvent.clientY - startY);
    };
    const onUp = () => {
      container.releasePointerCapture?.(pointerId);
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerup", onUp);
      container.removeEventListener("pointercancel", onUp);
      setPanning(false);
    };
    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerup", onUp);
    container.addEventListener("pointercancel", onUp);
  };

  const nodeProps = (node: ImageWorkflowNode) => ({
    ref: (element: HTMLElement | null) => registerNode(node.id, element),
    style: { top: node.y, left: node.x, width: node.width, minHeight: node.height },
    tabIndex: selectedId === node.id ? 0 : -1,
  });

  return (
    <section className="image-workflow-panel" aria-label={copy.title}>
      <header className="image-workflow-head">
        <span className="image-workflow-head-icon"><SvgIcon name="graph" size={16} /></span>
        <span className="image-workflow-head-copy">
          <strong>{copy.title}</strong>
          <small>{calls.length > 0 ? copy.canvasHint : copy.subtitle}</small>
        </span>
        <span className="image-workflow-zoom" role="group" aria-label={copy.fit}>
          <button type="button" aria-label={copy.zoomOut} onClick={() => applyZoom(zoom - 0.1)}><SvgIcon name="minus" size={13} /></button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label={copy.zoomIn} onClick={() => applyZoom(zoom + 0.1)}><SvgIcon name="plus" size={13} /></button>
          <button
            type="button"
            aria-label={copy.fit}
            aria-pressed={zoomMode === "fit"}
            className={zoomMode === "fit" ? "is-active" : undefined}
            onClick={requestFit}
          >
            <SvgIcon name="fit" size={13} />
          </button>
        </span>
        {selectedCall && (
          <button
            type="button"
            className="image-workflow-inspector-toggle"
            aria-label={inspectorOpen ? copy.hideInspector : copy.showInspector}
            aria-expanded={inspectorOpen}
            aria-controls={`image-workflow-inspector-${sessionId}`}
            onClick={() => setInspectorOpen((open) => !open)}
          >
            <SvgIcon name={inspectorOpen ? "chevronRight" : "edit"} size={13} />
          </button>
        )}
      </header>

      <div className="image-workflow-body">
        <div
          ref={scrollRef}
          className={`image-workflow-canvas-scroll${panning ? " is-panning" : ""}`}
          onPointerDown={startPan}
          onKeyDown={onCanvasKeyDown}
        >
          {calls.length === 0 ? (
            <div className="image-workflow-empty">
              <span><SvgIcon name="image" size={24} /></span>
              <strong>{copy.emptyTitle}</strong>
              <p>{copy.emptyDescription}</p>
              <button
                type="button"
                className="image-workflow-send"
                onClick={() => {
                  onSendToChat(copy.emptyTemplate);
                  setHandoffSent(true);
                }}
              >
                <SvgIcon name="send" size={13} />{handoffSent ? copy.sent : copy.emptyAction}
              </button>
            </div>
          ) : (
            <div className="image-workflow-canvas" style={{ width: layout.width * zoom, height: layout.height * zoom }}>
              <div className="image-workflow-canvas-stage" style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
                <svg className="image-workflow-edges" width={layout.width} height={layout.height} aria-hidden="true">
                  {layout.edges.map((edge) => (
                    <path key={edge.id} className={edge.kind === "lineage" ? "is-branch" : undefined} d={edge.d} />
                  ))}
                </svg>

                {calls.map((call, callIndex) => {
                  const promptNode = nodesById.get(call.promptNodeId);
                  if (!promptNode) return null;
                  const promptDraft = saved.drafts[call.promptNodeId];
                  return (
                    <div key={call.id}>
                      <button
                        type="button"
                        className={`image-flow-node image-flow-prompt${selectedId === call.promptNodeId ? " is-selected" : ""}`}
                        onClick={() => setSelectedId(call.promptNodeId)}
                        {...nodeProps(promptNode)}
                      >
                        <span className="image-flow-node-kicker"><SvgIcon name="edit" size={12} /> {copy.prompt} {callIndex + 1}</span>
                        <strong>{promptDraft?.title?.trim() || `${copy.prompt} ${callIndex + 1}`}</strong>
                        <small>{truncate(promptDraft?.content ?? call.prompt, 100)}</small>
                        <span className="image-flow-node-source">
                          {call.sourceIds.length > 0 ? copy.derived : copy.source}
                          {call.aspectRatio ? ` · ${call.aspectRatio}` : ""}
                        </span>
                        <span className="image-flow-port is-output" />
                      </button>
                      {call.generations.map((generation) => {
                        const node = nodesById.get(generation.id);
                        if (!node) return null;
                        const selected = generation.id === selectedId;
                        const accepted = generation.id === saved.acceptedId;
                        const compareSlot = compareIds.indexOf(generation.id);
                        const draft = saved.drafts[generation.id];
                        const version = allGenerations.indexOf(generation) + 1;
                        const meta = formatImageMeta(generation);
                        return (
                          <div
                            key={generation.id}
                            role="button"
                            aria-pressed={selected}
                            className={`image-flow-node image-flow-generation${selected ? " is-selected" : ""}${accepted ? " is-accepted" : ""}`}
                            onClick={() => setSelectedId(generation.id)}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              event.preventDefault();
                              if (selected && generation.path) openLightbox(generation.id);
                              else setSelectedId(generation.id);
                            }}
                            {...nodeProps(node)}
                          >
                            <span className="image-flow-port is-input" />
                            <span className="image-flow-node-kicker">
                              <SvgIcon name={generation.status === "running" ? "spinner" : generation.status === "failed" ? "error" : "image"} size={12} />
                              V{version} · {generation.status === "running" ? copy.running : generation.status === "failed" ? copy.failed : accepted ? copy.accepted : copy.complete}
                              {compareSlot >= 0 && <span className="image-flow-compare-slot">{compareSlot === 0 ? "A" : "B"}</span>}
                            </span>
                            <strong>{draft?.title?.trim() || `${copy.output} V${version}`}</strong>
                            {generation.path ? (
                              <ChatImagePreview
                                src={generation.path}
                                alt={`${copy.output} V${version}`}
                                title={copy.enlarge}
                                onClick={() => openLightbox(generation.id)}
                                className="image-flow-preview"
                              />
                            ) : (
                              <span className={`image-flow-pending${generation.status === "running" ? " is-running" : ""}`}><SvgIcon name={generation.status === "running" ? "spinner" : "error"} size={20} /></span>
                            )}
                            {meta && <span className="image-flow-node-meta">{meta}</span>}
                            <span className="image-flow-node-actions">
                              {generation.path && (
                                <button type="button" onClick={(event) => { event.stopPropagation(); toggleCompare(generation.id); }}>
                                  {compareSlot >= 0 ? copy.removeCompare : copy.compare}
                                </button>
                              )}
                              {generation.path && (
                                <button type="button" onClick={(event) => { event.stopPropagation(); toggleAccepted(generation.id); }}>
                                  {accepted ? copy.unaccept : copy.accept}
                                </button>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {selectedCall && selectedId && inspectorOpen && (
          <aside
            id={`image-workflow-inspector-${sessionId}`}
            className="image-workflow-inspector"
            aria-label={copy.selected}
          >
            <div className="image-workflow-inspector-head">
              <span>{copy.selected}</span>
              <strong>{selectedCall.sourceIds.length > 0 && selectedIsPrompt ? copy.derived : copy.source}</strong>
            </div>
            <label htmlFor={`image-node-title-${sessionId}`}>{copy.titleLabel}</label>
            <input
              id={`image-node-title-${sessionId}`}
              value={selectedDraft.title ?? ""}
              placeholder={selectedIsPrompt ? copy.prompt : copy.output}
              onChange={(event) => updateDraft({ title: event.currentTarget.value })}
            />
            <label htmlFor={`image-node-content-${sessionId}`}>{selectedIsPrompt ? copy.promptLabel : copy.revisionLabel}</label>
            <textarea
              id={`image-node-content-${sessionId}`}
              value={selectedDraft.content ?? (selectedIsPrompt ? selectedCall.prompt : "")}
              placeholder={selectedIsPrompt ? selectedCall.prompt : copy.revisionPlaceholder}
              onChange={(event) => updateDraft({ content: event.currentTarget.value })}
            />
            {!selectedIsPrompt && (
              <div className="image-workflow-quick">
                {copy.quick.map((suggestion) => (
                  <button
                    type="button"
                    key={suggestion}
                    onClick={() => {
                      const existing = selectedDraft.content?.trim();
                      updateDraft({ content: existing ? `${existing}\n${suggestion}` : suggestion });
                    }}
                  >
                    <SvgIcon name="plus" size={11} />{suggestion}
                  </button>
                ))}
              </div>
            )}
            {selectedGenerationPath && (
              <div className="image-workflow-file-actions">
                <button type="button" onClick={() => void navigator.clipboard?.writeText(selectedGenerationPath)}>
                  <SvgIcon name="copy" size={12} />{copy.copyPath}
                </button>
                <button type="button" onClick={() => void fileReveal(selectedGenerationPath).catch(() => undefined)}>
                  <SvgIcon name="folder" size={12} />{copy.revealFile}
                </button>
              </div>
            )}
            <details className="image-workflow-original">
              <summary>{copy.original}</summary>
              <p>{selectedCall.prompt}</p>
            </details>
            <div className="image-workflow-inspector-actions">
              <button type="button" className="image-workflow-reset" onClick={resetDraft}>{copy.reset}</button>
              <button
                type="button"
                className={`image-workflow-send${handoffSent ? " is-sent" : ""}`}
                onClick={sendToChat}
              >
                <SvgIcon name={handoffSent ? "check" : "send"} size={13} />{handoffSent ? copy.sent : copy.send}
              </button>
            </div>
          </aside>
        )}
      </div>

      {compareIds.length > 0 && (
        <section className="image-workflow-compare is-open" aria-label={copy.compareTitle}>
          <header>
            <strong>{copy.compareTitle}</strong>
            <span className="image-workflow-compare-tools">
              {compareIds.length === 2 && (
                <button type="button" onClick={() => setCompareIds((current) => [...current].reverse())}>{copy.swapCompare}</button>
              )}
              <button type="button" onClick={() => setCompareIds([])}>{copy.clearCompare}</button>
            </span>
          </header>
          <div>
            {compareIds.map((id, slot) => {
              const generation = allGenerations.find((item) => item.id === id);
              if (!generation?.path) return null;
              const version = allGenerations.indexOf(generation) + 1;
              return (
                <figure key={id} className="image-workflow-compare-item">
                  <figcaption>
                    <span>{slot === 0 ? "A" : "B"} · V{version}</span>
                    <button type="button" aria-label={`${copy.removeSlot}: V${version}`} onClick={() => toggleCompare(id)}>
                      <SvgIcon name="close" size={11} />
                    </button>
                  </figcaption>
                  <ChatImagePreview
                    src={generation.path}
                    alt={`${copy.output} V${version}`}
                    onClick={() => openLightbox(id)}
                    className="image-workflow-compare-preview"
                  />
                </figure>
              );
            })}
          </div>
        </section>
      )}

      {lightboxGeneration && (
        <div className="image-workflow-lightbox" role="dialog" aria-modal="true" aria-label={copy.enlarge} onClick={closeLightbox}>
          <div className="image-workflow-lightbox-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>{saved.drafts[lightboxGeneration.id]?.title?.trim() || `${copy.output} V${allGenerations.findIndex((item) => item.id === lightboxGeneration.id) + 1}`}</strong>
              <span className="image-workflow-lightbox-count">{lightboxIndex + 1} / {previewableGenerations.length}</span>
              <button type="button" aria-label={copy.closePreview} onClick={closeLightbox}><SvgIcon name="close" size={16} /></button>
            </header>
            <div className="image-workflow-lightbox-stage">
              {previewableGenerations.length > 1 && (
                <button type="button" className="image-workflow-lightbox-step" aria-label={copy.previous} onClick={() => stepLightbox(-1)}>
                  <SvgIcon name="chevronLeft" size={18} />
                </button>
              )}
              <ChatImagePreview src={lightboxGeneration.path} alt={copy.enlarge} className="image-workflow-lightbox-image" />
              {previewableGenerations.length > 1 && (
                <button type="button" className="image-workflow-lightbox-step is-next" aria-label={copy.next} onClick={() => stepLightbox(1)}>
                  <SvgIcon name="chevronRight" size={18} />
                </button>
              )}
            </div>
            <footer>
              <code title={lightboxGeneration.path}>{lightboxGeneration.path}</code>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(lightboxGeneration.path)}>
                <SvgIcon name="copy" size={12} />{copy.copyPath}
              </button>
              <button type="button" onClick={() => void fileOpen(lightboxGeneration.path).catch(() => undefined)}>
                <SvgIcon name="externalLink" size={12} />{copy.openFile}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
