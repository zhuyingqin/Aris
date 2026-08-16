import { useEffect, useMemo, useState } from "react";
import { SvgIcon } from "../SvgIcon";
import type { ChatTurn } from "../types";
import ChatImagePreview from "./ChatImagePreview";
import { parseToolBlockObject, textFromTurn } from "./model";

export interface ImageWorkflowGeneration {
  id: string;
  path: string | null;
  status: "running" | "complete" | "failed";
}

export interface ImageWorkflowCall {
  id: string;
  promptNodeId: string;
  prompt: string;
  referencePaths: string[];
  generations: ImageWorkflowGeneration[];
}

interface NodeDraft {
  title?: string;
  content?: string;
}

interface SavedWorkflowState {
  acceptedId: string | null;
  drafts: Record<string, NodeDraft>;
}

interface LayoutCall {
  call: ImageWorkflowCall;
  promptY: number;
  generationYs: number[];
}

const IMAGE_TOOL_NAME = "ChatGptWebImage";
const WORKFLOW_STORAGE_PREFIX = "somniq-image-workflow-v1";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function imagePath(value: unknown): string | null {
  if (typeof value === "string") return nonEmptyString(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return nonEmptyString(record.path) ?? nonEmptyString(record.url) ?? nonEmptyString(record.src);
}

export function imageWorkflowCallsFromTurns(turns: ChatTurn[]): ImageWorkflowCall[] {
  const calls: ImageWorkflowCall[] = [];
  let latestUserPrompt = "";
  for (const turn of turns) {
    if (turn.role === "user") latestUserPrompt = textFromTurn(turn).trim();
    for (let blockIndex = 0; blockIndex < turn.blocks.length; blockIndex += 1) {
      const block = turn.blocks[blockIndex];
      if (block.kind !== "tool" || block.name !== IMAGE_TOOL_NAME) continue;
      const input = parseToolBlockObject(block, "input");
      const output = parseToolBlockObject(block, "output");
      const baseId = `${turn.id}-${block.id ?? blockIndex}`;
      const images = Array.isArray(output?.images) ? output.images : [];
      const paths = images.flatMap((image) => {
        const path = imagePath(image);
        return path ? [path] : [];
      });
      const references = Array.isArray(input?.files)
        ? input.files.flatMap((file) => {
          const path = imagePath(file);
          return path ? [path] : [];
        })
        : [];
      const status = block.output === undefined
        ? "running"
        : block.isError || paths.length === 0
          ? "failed"
          : "complete";
      calls.push({
        id: baseId,
        promptNodeId: `${baseId}-prompt`,
        prompt: nonEmptyString(input?.prompt) ?? latestUserPrompt,
        referencePaths: references,
        generations: paths.length > 0
          ? paths.map((path, imageIndex) => ({ id: `${baseId}-image-${imageIndex}`, path, status }))
          : [{ id: `${baseId}-output`, path: null, status }],
      });
    }
  }
  return calls;
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
  const [saved, setSaved] = useState<SavedWorkflowState>(() => loadState(sessionId));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(0.9);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [lightboxId, setLightboxId] = useState<string | null>(null);

  const layouts = useMemo(() => {
    let y = 44;
    return calls.map((call): LayoutCall => {
      const generationYs = call.generations.map((_, index) => y + index * 190);
      const layout = { call, promptY: y + Math.max(0, (call.generations.length - 1) * 95), generationYs };
      y += Math.max(190, call.generations.length * 190) + 46;
      return layout;
    });
  }, [calls]);
  const canvasHeight = Math.max(430, (layouts.at(-1)?.generationYs.at(-1) ?? 210) + 210);
  const allGenerations = calls.flatMap((call) => call.generations);
  const allNodeIds = useMemo(
    () => calls.flatMap((call) => [call.promptNodeId, ...call.generations.map((generation) => generation.id)]),
    [calls],
  );

  useEffect(() => {
    setSaved(loadState(sessionId));
    setSelectedId(null);
    setCompareIds([]);
    setLightboxId(null);
  }, [sessionId]);

  useEffect(() => {
    if (selectedId && allNodeIds.includes(selectedId)) return;
    setSelectedId(calls[0]?.promptNodeId ?? null);
  }, [allNodeIds, calls, selectedId]);

  useEffect(() => {
    window.localStorage?.setItem(`${WORKFLOW_STORAGE_PREFIX}:${sessionId}`, JSON.stringify(saved));
  }, [saved, sessionId]);

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

  useEffect(() => {
    if (!lightboxId) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLightboxId(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [lightboxId]);

  const selectedCall = calls.find((call) => (
    call.promptNodeId === selectedId || call.generations.some((generation) => generation.id === selectedId)
  )) ?? null;
  const selectedGeneration = selectedCall?.generations.find((generation) => generation.id === selectedId) ?? null;
  const selectedIsPrompt = selectedCall?.promptNodeId === selectedId;
  const selectedDraft = selectedId ? saved.drafts[selectedId] ?? {} : {};
  const lightboxGeneration = allGenerations.find((generation) => generation.id === lightboxId) ?? null;

  const copy = cn
    ? {
      title: "图片节点工作流",
      subtitle: "画布只投影 Chat 中真实发生的图片提示词、调用与输出。",
      fit: "适应画布",
      zoomIn: "放大",
      zoomOut: "缩小",
      emptyTitle: "当前对话还没有图片节点",
      emptyDescription: "在 Chat 中调用 ChatGptWebImage 后，真实提示词和生成结果会自动出现在这里。",
      prompt: "提示词",
      output: "图片输出",
      running: "生成中",
      failed: "生成失败",
      complete: "已生成",
      accepted: "已采纳",
      accept: "采纳版本",
      compare: "加入对比",
      removeCompare: "移出对比",
      enlarge: "放大查看",
      selected: "编辑节点",
      source: "来自对话记录",
      titleLabel: "节点标题",
      promptLabel: "提示词内容",
      revisionLabel: "下一版修改要求",
      revisionPlaceholder: "说明下一版需要改变什么；不会修改原始聊天记录。",
      reset: "恢复为对话内容",
      send: "送回 Chat 生成新版本",
      compareTitle: "版本对比",
      clearCompare: "清空",
      closePreview: "关闭大图",
      original: "原始对话内容",
      quick: ["保持构图，只修正文案", "增强层级和可读性", "生成一个明显不同的方案"],
    }
    : {
      title: "Image node workflow",
      subtitle: "The canvas projects only prompts, calls, and outputs that actually occurred in Chat.",
      fit: "Fit canvas",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      emptyTitle: "No image nodes in this conversation",
      emptyDescription: "After Chat calls ChatGptWebImage, its real prompt and output appear here automatically.",
      prompt: "Prompt",
      output: "Image output",
      running: "Generating",
      failed: "Failed",
      complete: "Generated",
      accepted: "Accepted",
      accept: "Accept version",
      compare: "Add to compare",
      removeCompare: "Remove from compare",
      enlarge: "Enlarge image",
      selected: "Edit node",
      source: "From Chat transcript",
      titleLabel: "Node title",
      promptLabel: "Prompt content",
      revisionLabel: "Next-version instruction",
      revisionPlaceholder: "Describe what the next version should change. The original transcript remains unchanged.",
      reset: "Restore transcript content",
      send: "Send to Chat for a new version",
      compareTitle: "Version compare",
      clearCompare: "Clear",
      closePreview: "Close large preview",
      original: "Original transcript content",
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
  };

  const toggleCompare = (generationId: string) => {
    setCompareIds((current) => current.includes(generationId)
      ? current.filter((id) => id !== generationId)
      : [...current.slice(-1), generationId]);
  };

  return (
    <section className="image-workflow-panel" aria-label={copy.title}>
      <header className="image-workflow-head">
        <span className="image-workflow-head-icon"><SvgIcon name="graph" size={16} /></span>
        <span className="image-workflow-head-copy">
          <strong>{copy.title}</strong>
          <small>{copy.subtitle}</small>
        </span>
        <span className="image-workflow-zoom" role="group" aria-label={copy.fit}>
          <button type="button" aria-label={copy.zoomOut} onClick={() => setZoom((value) => Math.max(0.65, value - 0.1))}><SvgIcon name="minus" size={13} /></button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label={copy.zoomIn} onClick={() => setZoom((value) => Math.min(1.2, value + 0.1))}><SvgIcon name="plus" size={13} /></button>
          <button type="button" aria-label={copy.fit} onClick={() => setZoom(0.9)}><SvgIcon name="fit" size={13} /></button>
        </span>
      </header>

      <div className="image-workflow-body">
        <div className="image-workflow-canvas-scroll">
          {calls.length === 0 ? (
            <div className="image-workflow-empty">
              <span><SvgIcon name="image" size={24} /></span>
              <strong>{copy.emptyTitle}</strong>
              <p>{copy.emptyDescription}</p>
            </div>
          ) : (
            <div className="image-workflow-canvas" style={{ width: 660 * zoom, height: canvasHeight * zoom }}>
              <div className="image-workflow-canvas-stage" style={{ width: 660, height: canvasHeight, transform: `scale(${zoom})` }}>
                <svg className="image-workflow-edges" width="660" height={canvasHeight} aria-hidden="true">
                  {layouts.flatMap((layout) => layout.generationYs.map((generationY, index) => (
                    <path key={`${layout.call.id}-${index}`} d={`M260 ${layout.promptY + 64} C302 ${layout.promptY + 64} 308 ${generationY + 78} 350 ${generationY + 78}`} />
                  )))}
                </svg>

                {layouts.map(({ call, promptY, generationYs }, callIndex) => {
                  const promptDraft = saved.drafts[call.promptNodeId];
                  return (
                    <div key={call.id}>
                      <button
                        type="button"
                        className={`image-flow-node image-flow-prompt${selectedId === call.promptNodeId ? " is-selected" : ""}`}
                        style={{ top: promptY, left: 40 }}
                        onClick={() => setSelectedId(call.promptNodeId)}
                      >
                        <span className="image-flow-node-kicker"><SvgIcon name="edit" size={12} /> {copy.prompt} {callIndex + 1}</span>
                        <strong>{promptDraft?.title?.trim() || `${copy.prompt} ${callIndex + 1}`}</strong>
                        <small>{truncate(promptDraft?.content ?? call.prompt, 100)}</small>
                        <span className="image-flow-node-source">{copy.source}</span>
                        <span className="image-flow-port is-output" />
                      </button>
                      {call.generations.map((generation, generationIndex) => {
                        const selected = generation.id === selectedId;
                        const accepted = generation.id === saved.acceptedId;
                        const comparing = compareIds.includes(generation.id);
                        const draft = saved.drafts[generation.id];
                        const version = allGenerations.indexOf(generation) + 1;
                        return (
                          <article
                            key={generation.id}
                            className={`image-flow-node image-flow-generation${selected ? " is-selected" : ""}${accepted ? " is-accepted" : ""}`}
                            style={{ top: generationYs[generationIndex], left: 350 }}
                            onClick={() => setSelectedId(generation.id)}
                          >
                            <span className="image-flow-port is-input" />
                            <span className="image-flow-node-kicker">
                              <SvgIcon name={generation.status === "running" ? "spinner" : generation.status === "failed" ? "error" : "image"} size={12} />
                              V{version} · {generation.status === "running" ? copy.running : generation.status === "failed" ? copy.failed : accepted ? copy.accepted : copy.complete}
                            </span>
                            <strong>{draft?.title?.trim() || `${copy.output} V${version}`}</strong>
                            {generation.path ? (
                              <ChatImagePreview
                                src={generation.path}
                                alt={`${copy.output} V${version}`}
                                title={copy.enlarge}
                                onClick={() => setLightboxId(generation.id)}
                                className="image-flow-preview"
                              />
                            ) : (
                              <span className={`image-flow-pending${generation.status === "running" ? " is-running" : ""}`}><SvgIcon name={generation.status === "running" ? "spinner" : "error"} size={20} /></span>
                            )}
                            <span className="image-flow-node-actions">
                              {generation.path && <button type="button" onClick={(event) => { event.stopPropagation(); toggleCompare(generation.id); }}>{comparing ? copy.removeCompare : copy.compare}</button>}
                              {generation.path && <button type="button" onClick={(event) => { event.stopPropagation(); setSaved((current) => ({ ...current, acceptedId: generation.id })); }}>{copy.accept}</button>}
                            </span>
                          </article>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {selectedCall && selectedId && (
          <aside className="image-workflow-inspector" aria-label={copy.selected}>
            <div className="image-workflow-inspector-head">
              <span>{copy.selected}</span>
              <strong>{copy.source}</strong>
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
                  <button type="button" key={suggestion} onClick={() => updateDraft({ content: suggestion })}>{suggestion}</button>
                ))}
              </div>
            )}
            <details className="image-workflow-original">
              <summary>{copy.original}</summary>
              <p>{selectedCall.prompt}</p>
            </details>
            <div className="image-workflow-inspector-actions">
              <button type="button" className="image-workflow-reset" onClick={resetDraft}>{copy.reset}</button>
              <button type="button" className="image-workflow-send" onClick={sendToChat}><SvgIcon name="send" size={13} />{copy.send}</button>
            </div>
          </aside>
        )}
      </div>

      {compareIds.length > 0 && (
        <section className="image-workflow-compare is-open" aria-label={copy.compareTitle}>
          <header><strong>{copy.compareTitle}</strong><button type="button" onClick={() => setCompareIds([])}>{copy.clearCompare}</button></header>
          <div>
            {compareIds.map((id) => {
              const generation = allGenerations.find((item) => item.id === id);
              if (!generation?.path) return null;
              return <ChatImagePreview key={id} src={generation.path} alt={id} onClick={() => setLightboxId(id)} className="image-workflow-compare-preview" />;
            })}
          </div>
        </section>
      )}

      {lightboxGeneration?.path && (
        <div className="image-workflow-lightbox" role="dialog" aria-modal="true" aria-label={copy.enlarge} onClick={() => setLightboxId(null)}>
          <div className="image-workflow-lightbox-card" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>{saved.drafts[lightboxGeneration.id]?.title?.trim() || copy.output}</strong>
              <button type="button" aria-label={copy.closePreview} onClick={() => setLightboxId(null)}><SvgIcon name="close" size={16} /></button>
            </header>
            <ChatImagePreview src={lightboxGeneration.path} alt={copy.enlarge} className="image-workflow-lightbox-image" />
          </div>
        </div>
      )}
    </section>
  );
}
