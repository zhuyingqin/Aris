import { useEffect, useState } from "react";

import {
  isTauri,
  memoryExplorerSnapshot,
  memoryGovernanceDelete,
  memoryGovernanceReadScenario,
  memoryGovernanceSearch,
  memoryGovernanceUpdate,
} from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import type {
  MemoryExplorerItem,
  MemoryExplorerSnapshot,
  MemoryGovernanceHit,
} from "../types";
import type { Language } from "../store";

type Layer = "l0" | "l1" | "l2" | "l3";

// R0 sessions can contain long model outputs. Keep the settings view a quick
// inspection surface; search remains available for anything outside this
// recent window.
const EXPLORER_ENTRY_LIMIT = 12;
const COLLAPSED_CONTENT_LINES = 4;
const COLLAPSIBLE_CONTENT_LENGTH = 280;

interface Props {
  language: Language;
  projectId: string;
  onChanged?: () => void;
}

const PREVIEW_SNAPSHOT: MemoryExplorerSnapshot = {
  projectId: "preview-project",
  loadedAt: new Date().toISOString(),
  l0Total: 2,
  l1Total: 2,
  l2Total: 2,
  l3Total: 1,
  partialErrors: [],
  l0: [
    {
      layer: "l0",
      id: "preview-message-2",
      role: "assistant",
      content: "The experiment should compare retrieval quality with the existing session index. The compact preview deliberately includes a longer authoritative response so the settings page can demonstrate how lengthy conversations stay readable. It preserves the full source text for inspection, while keeping the initial scan focused on the first few lines instead of allowing a single response to dominate the entire library.",
      timestamp: new Date().toISOString(),
      version: "v1",
    },
    {
      layer: "l0",
      id: "preview-message-1",
      role: "user",
      content: "Remember that this project prioritizes reproducible research evidence.",
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      version: "v1",
    },
  ],
  l1: [
    {
      layer: "l1",
      id: "preview-l1",
      kind: "instruction",
      content: "Preview memory result",
      background: "Confirmed project preference",
      version: "v2",
      updatedAt: new Date().toISOString(),
    },
    {
      layer: "l1",
      id: "preview-l1-2",
      kind: "episodic",
      content: "Use the existing session index as the builtin Top-5 baseline.",
      version: "v1",
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
  ],
  l2: [
    {
      layer: "l2",
      id: "research/retrieval-evaluation.md",
      path: "research/retrieval-evaluation.md",
      version: "v3",
      updatedAt: new Date().toISOString(),
    },
    {
      layer: "l2",
      id: "somniq/manual-memory.md",
      path: "somniq/manual-memory.md",
      version: "v1",
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ],
  l3: {
    layer: "l3",
    id: "core-profile",
    kind: "profile",
    version: "v4",
    updatedAt: new Date().toISOString(),
    content: "# Project memory\n\nThe user values reproducible evidence, clear provenance, and project isolation.",
  },
};

const layerInfo: Record<Layer, { cn: string; en: string; tone: string }> = {
  l0: { cn: "权威对话", en: "Authoritative sessions", tone: "raw" },
  l1: { cn: "研究原子", en: "Research atoms", tone: "atomic" },
  l2: { cn: "研究情景", en: "Research episodes", tone: "scenario" },
  l3: { cn: "研究画像", en: "Research constitution", tone: "core" },
};

function displayTime(value: string | null | undefined, language: Language) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "cn" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function sourceFromItem(item: MemoryExplorerItem): "l0" | "l1" | null {
  return item.layer === "l0" || item.layer === "l1" ? item.layer : null;
}

// Keep the renderer bounded even if the backend ignores the requested limit. Totals remain untouched, so the layer tabs still report
// the full catalog size.
function limitSnapshotEntries(snapshot: MemoryExplorerSnapshot): MemoryExplorerSnapshot {
  return {
    ...snapshot,
    l0: snapshot.l0.slice(0, EXPLORER_ENTRY_LIMIT),
    l1: snapshot.l1.slice(0, EXPLORER_ENTRY_LIMIT),
    l2: snapshot.l2.slice(0, EXPLORER_ENTRY_LIMIT),
  };
}

export default function MemoryExplorer({ language, projectId, onChanged }: Props) {
  const cn = language === "cn";
  // The research hierarchy is R0-R3; the internal keys stay `l*` so the layer
  // palette and the API shape line up.
  const code = (layer: string) => `R${layer.slice(1)}`;
  const [snapshot, setSnapshot] = useState<MemoryExplorerSnapshot | null>(null);
  const [activeLayer, setActiveLayer] = useState<Layer>("l1");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<MemoryGovernanceHit[] | null>(null);
  const [selectedScenario, setSelectedScenario] = useState<MemoryExplorerItem | null>(null);
  const [scenarioContent, setScenarioContent] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState("");
  const [editingContent, setEditingContent] = useState("");
  const [expandedKey, setExpandedKey] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const readScenario = async (item: MemoryExplorerItem) => {
    const path = item.path ?? item.id;
    setSelectedScenario(item);
    setScenarioContent(null);
    setBusy("scenario");
    setError("");
    try {
      const content = isTauri()
        ? await memoryGovernanceReadScenario(path)
        : path.includes("manual")
          ? "# Confirmed memory\n\n- Keep project memory isolated."
          : "# Retrieval evaluation\n\nCompare Top-5 recall against the authoritative Sessions.";
      setScenarioContent(content ?? "");
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const loadSnapshot = async () => {
    setBusy("snapshot");
    setError("");
    try {
      const result = isTauri() ? await memoryExplorerSnapshot(EXPLORER_ENTRY_LIMIT) : PREVIEW_SNAPSHOT;
      const next = limitSnapshotEntries(result);
      setSnapshot(next);
      const nextScenario = selectedScenario
        ? next.l2.find((item) => item.id === selectedScenario.id) ?? next.l2[0]
        : next.l2[0];
      if (nextScenario) await readScenario(nextScenario);
      else {
        setSelectedScenario(null);
        setScenarioContent(null);
      }
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    setSnapshot(null);
    setSearchHits(null);
    setSelectedScenario(null);
    setScenarioContent(null);
    setExpandedKey("");
    void loadSnapshot();
    // The project boundary intentionally resets all explorer state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const runSearch = async () => {
    if (!query.trim()) {
      setSearchHits(null);
      return;
    }
    setBusy("search");
    setError("");
    try {
      const hits = isTauri()
        ? await memoryGovernanceSearch(query.trim(), 20)
        : [
            { source: "l1", id: "preview-l1", content: "Preview memory result", scoreMillis: 930 },
            { source: "l0", id: "preview-message-1", content: "Remember that this project prioritizes reproducible research evidence.", role: "user", scoreMillis: 810 },
          ] satisfies MemoryGovernanceHit[];
      setSearchHits(hits);
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const updateMemory = async (source: "l0" | "l1", id: string) => {
    setBusy(`update:${source}:${id}`);
    setError("");
    try {
      if (isTauri()) await memoryGovernanceUpdate(source, id, editingContent.trim());
      setSnapshot((current) => current ? {
        ...current,
        l1: current.l1.map((item) => item.id === id ? { ...item, content: editingContent.trim() } : item),
      } : current);
      setSearchHits((current) => current?.map((item) => item.source === source && item.id === id
        ? { ...item, content: editingContent.trim() }
        : item) ?? null);
      setEditingKey("");
      onChanged?.();
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const deleteMemory = async (source: "l0" | "l1", id: string) => {
    const confirmed = window.confirm(cn
      ? "删除这条派生记忆？SomniQ 权威 Session 不会被删除。"
      : "Delete this derived memory? The authoritative SomniQ Session remains intact.");
    if (!confirmed) return;
    setBusy(`delete:${source}:${id}`);
    setError("");
    try {
      if (isTauri()) await memoryGovernanceDelete(source, id);
      setSnapshot((current) => current ? {
        ...current,
        l0: current.l0.filter((item) => !(source === "l0" && item.id === id)),
        l1: current.l1.filter((item) => !(source === "l1" && item.id === id)),
        l0Total: Math.max(0, current.l0Total - Number(source === "l0")),
        l1Total: Math.max(0, current.l1Total - Number(source === "l1")),
      } : current);
      setSearchHits((current) => current?.filter((item) => !(item.source === source && item.id === id)) ?? null);
      onChanged?.();
    } catch (reason) {
      setError(formatUserFacingError(reason, language));
    } finally {
      setBusy("");
    }
  };

  const renderMemoryCard = (item: MemoryExplorerItem | MemoryGovernanceHit, fromSearch = false) => {
    const source = "source" in item ? item.source : sourceFromItem(item);
    if (!source) return null;
    const key = `${source}:${item.id}`;
    const content = item.content ?? "";
    const role = item.role;
    const version = "version" in item ? item.version : null;
    const kind = "kind" in item ? item.kind : null;
    const timestamp = "timestamp" in item
      ? item.timestamp ?? item.updatedAt ?? item.createdAt
      : null;
    const sessionId = item.sessionId;
    const score = fromSearch && "scoreMillis" in item ? item.scoreMillis : null;
    const isExpanded = expandedKey === key;
    const shouldCollapse = content.length > COLLAPSIBLE_CONTENT_LENGTH
      || content.split(/\r?\n/).length > COLLAPSED_CONTENT_LINES;
    return (
      <article className={`memory-entry-card memory-entry-${source}`} key={key}>
        <header className="memory-entry-head">
          <div className="memory-entry-badges">
            <span className={`memory-layer-badge memory-layer-${source}`}>{code(source)}</span>
            {(kind || role) && <span className="memory-kind-badge">{kind ?? role}</span>}
            {version && <span className="memory-version-badge">{version}</span>}
          </div>
          <span className="memory-entry-time">
            {score !== null ? `${Math.round(score / 10)}%` : displayTime(timestamp, language)}
          </span>
        </header>
        {editingKey === key ? (
          <textarea
            className="memory-entry-editor"
            aria-label={cn ? "编辑记忆内容" : "Edit memory content"}
            value={editingContent}
            onChange={(event) => setEditingContent(event.target.value)}
          />
        ) : (
          <>
            <div className={`memory-entry-content${shouldCollapse && !isExpanded ? " is-collapsed" : ""}`}>{content}</div>
            {shouldCollapse && (
              <button
                className="memory-entry-expand"
                type="button"
                aria-expanded={isExpanded}
                onClick={() => setExpandedKey(isExpanded ? "" : key)}
              >
                {isExpanded
                  ? (cn ? "收起全文" : "Collapse")
                  : (cn ? "展开全文" : "Show full entry")}
              </button>
            )}
          </>
        )}
        {"background" in item && item.background && (
          <div className="memory-entry-background"><strong>{cn ? "背景" : "Context"}</strong>{item.background}</div>
        )}
        {"artifactPaths" in item && item.artifactPaths?.length ? (
          <div className="memory-entry-background"><strong>{cn ? "关联产物" : "Artifacts"}</strong>{item.artifactPaths.join(" · ")}</div>
        ) : null}
        {"sourceEventIds" in item && item.sourceEventIds?.length ? (
          <div className="memory-entry-background"><strong>{cn ? "来源事件" : "Source events"}</strong>{item.sourceEventIds.join(" · ")}</div>
        ) : null}
        {"supersedesId" in item && item.supersedesId ? (
          <div className="memory-entry-background"><strong>{cn ? "知识更新" : "Knowledge update"}</strong>{cn ? "替代" : "Supersedes"} {item.supersedesId}</div>
        ) : null}
        <footer className="memory-entry-footer">
          <span title={item.id}>ID · {item.id}</span>
          {sessionId
            ? <span title={sessionId}>{cn ? "来源 Session" : "Source session"} · {sessionId}</span>
            : <span>{cn ? "腾讯接口未提供来源映射" : "No lineage returned by Core API"}</span>}
          <div className="memory-entry-actions">
            {source === "l1" && (editingKey === key ? (
              <>
                <button className="sp-btn sp-btn-primary" type="button" disabled={Boolean(busy) || !editingContent.trim()} onClick={() => void updateMemory(source, item.id)}>{cn ? "保存修正" : "Save correction"}</button>
                <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => setEditingKey("")}>{cn ? "取消" : "Cancel"}</button>
              </>
            ) : (
              <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => { setEditingKey(key); setEditingContent(content); }}>{cn ? "修正" : "Edit"}</button>
            ))}
            {source === "l1" && (
              <button className="sp-btn sp-btn-secondary memory-delete-btn" type="button" disabled={Boolean(busy)} onClick={() => void deleteMemory(source, item.id)}>{cn ? "删除" : "Delete"}</button>
            )}
          </div>
        </footer>
      </article>
    );
  };

  const totals: Record<Layer, number> = {
    l0: snapshot?.l0Total ?? 0,
    l1: snapshot?.l1Total ?? 0,
    l2: snapshot?.l2Total ?? 0,
    l3: snapshot?.l3Total ?? 0,
  };

  return (
    <div className="sp-update-section memory-library-section">
      <div className="sp-section-head memory-library-head">
        <div className="sp-section-head-text">
          <div className="sp-section-title">{cn ? "科研记忆库" : "Research memory library"}</div>
          <div className="sp-section-sub">
            {cn
              ? "浏览当前项目的 R0 权威对话、R1 研究原子、R2 研究情景和 R3 研究画像，并下钻到来源。"
              : "Inspect the project's R0 authoritative sessions, R1 atoms, R2 episodes, and R3 constitution with provenance."}
          </div>
        </div>
        <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void loadSnapshot()}>
          {busy === "snapshot" ? (cn ? "载入中…" : "Loading…") : (cn ? "刷新记忆库" : "Refresh library")}
        </button>
      </div>

      <div className="memory-pipeline" aria-label={cn ? "记忆层级" : "Memory layers"}>
          {(Object.keys(layerInfo) as Layer[]).map((layer) => (
            <div className="memory-pipeline-segment" key={layer}>
              <button
                className={`memory-layer-tab memory-layer-tab-${layer}${activeLayer === layer && searchHits === null ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={activeLayer === layer && searchHits === null}
                onClick={() => { setActiveLayer(layer); setSearchHits(null); }}
              >
                <span className="memory-layer-code">{code(layer)}</span>
                <span className="memory-layer-name">{cn ? layerInfo[layer].cn : layerInfo[layer].en}</span>
                <strong>{snapshot ? totals[layer] : "—"}</strong>
              </button>
            </div>
          ))}
        </div>

        <div className="memory-library-toolbar">
          <div className="memory-library-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }}
              placeholder={cn ? "搜索事实、结论或对话" : "Search facts, conclusions, or conversations"}
            />
            {searchHits !== null && (
              <button type="button" className="memory-search-clear" onClick={() => { setQuery(""); setSearchHits(null); }}>{cn ? "清除" : "Clear"}</button>
            )}
          </div>
          <button className="sp-btn sp-btn-primary" type="button" disabled={Boolean(busy) || !query.trim()} onClick={() => void runSearch()}>{cn ? "搜索" : "Search"}</button>
        </div>

        {snapshot?.partialErrors.length ? (
          <div className="memory-partial-errors">
            <strong>{cn ? "部分层级暂不可用" : "Some layers are unavailable"}</strong>
            {snapshot.partialErrors.map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}

        <div className="memory-library-body">
          {searchHits !== null ? (
            <div className="memory-search-panel">
              <div className="memory-library-panel-title">
                <strong>{cn ? "搜索结果" : "Search results"}</strong>
                <span>{searchHits.length} {cn ? "条" : "results"}</span>
              </div>
              <div className="memory-entry-list">
                {searchHits.map((hit) => renderMemoryCard(hit, true))}
                {searchHits.length === 0 && <div className="memory-empty-state">{cn ? "没有找到匹配记忆。" : "No matching memories found."}</div>}
              </div>
            </div>
          ) : activeLayer === "l0" || activeLayer === "l1" ? (
            <div className="memory-entry-list">
              {(snapshot?.[activeLayer] ?? []).map((item) => renderMemoryCard(item))}
              {snapshot && snapshot[activeLayer].length === 0 && <div className="memory-empty-state">{cn ? "这一层还没有内容。" : "This layer does not have any content yet."}</div>}
            </div>
          ) : activeLayer === "l2" ? (
            <div className="memory-scenario-browser">
              <nav className="memory-scenario-list" aria-label={cn ? "场景文件" : "Scenario files"}>
                {(snapshot?.l2 ?? []).map((item) => (
                  <button
                    className={selectedScenario?.id === item.id ? "active" : ""}
                    type="button"
                    key={item.id}
                    onClick={() => void readScenario(item)}
                  >
                    <span className="memory-scenario-file-icon">▤</span>
                    <span><strong>{item.path ?? item.id}</strong><small>{item.version} · {displayTime(item.updatedAt, language)}</small></span>
                  </button>
                ))}
                {snapshot?.l2.length === 0 && <div className="memory-empty-state">{cn ? "还没有场景文件。" : "No scenario files yet."}</div>}
              </nav>
              <section className="memory-document-viewer">
                {selectedScenario ? (
                  <>
                    <header>
                      <div><span className="memory-layer-badge memory-layer-l2">{code("l2")}</span><strong>{selectedScenario.path ?? selectedScenario.id}</strong></div>
                      <span>{selectedScenario.version} · {displayTime(selectedScenario.updatedAt, language)}</span>
                    </header>
                    <pre>{busy === "scenario" ? (cn ? "读取中…" : "Loading…") : scenarioContent || (cn ? "文件为空。" : "This file is empty.")}</pre>
                    <footer>{cn ? "只读 · 手工记忆请通过审批流程修改" : "Read only · edit manual memories through the approval workflow"}</footer>
                  </>
                ) : <div className="memory-empty-state">{cn ? "选择一个场景文件查看内容。" : "Select a scenario file to inspect its content."}</div>}
              </section>
            </div>
          ) : (
            <section className="memory-core-viewer">
              {snapshot?.l3 ? (
                <>
                  <header>
                    <div><span className="memory-layer-badge memory-layer-l3">{code("l3")}</span><strong>{cn ? "核心画像" : "Core profile"}</strong></div>
                    <span>{snapshot.l3.version} · {displayTime(snapshot.l3.updatedAt, language)}</span>
                  </header>
                  <pre>{snapshot.l3.content}</pre>
                  <footer>{cn
                    ? "由已追踪来源的 R1 原子派生；Project Goal、Workflow 和证据库仍是独立权威。"
                    : "Derived from traced R1 atoms; Project Goal, Workflow, and evidence remain separate authorities."}</footer>
                </>
              ) : <div className="memory-empty-state">{cn ? "核心画像尚未生成。完成更多对话后会在后台更新。" : "The core profile has not been generated yet. It updates after more conversations."}</div>}
            </section>
          )}
        </div>
        {snapshot && <div className="memory-library-footnote">{cn ? "最近加载" : "Loaded"} · {displayTime(snapshot.loadedAt, language)} · {cn ? `每层仅显示最近 ${EXPLORER_ENTRY_LIMIT} 条；可搜索更早内容` : `showing the newest ${EXPLORER_ENTRY_LIMIT} entries per layer; search for older content`}</div>}
      {error && <div className="sp-system-prompt-error">{error}</div>}
    </div>
  );
}
