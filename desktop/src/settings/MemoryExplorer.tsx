import { useEffect, useRef, useState } from "react";

import {
  isTauri,
  memoryExplorerSnapshot,
  memoryGovernanceSearch,
} from "../api/tauri";
import { formatUserFacingError } from "../errorMessage";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import type {
  MemoryExplorerItem,
  MemoryExplorerSnapshot,
  MemoryGovernanceHit,
} from "../types";
import type { Language } from "../store";
import { SETTINGS_COPY } from "./i18n";

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
}

const KIND_CONFIG: Record<string, { labelCn: string; labelEn: string; icon?: SvgIconName }> = {
  artifact_pointer: { labelCn: "产物指针", labelEn: "Artifact Pointer", icon: "document" },
  research_decision: { labelCn: "科研决策", labelEn: "Research Decision", icon: "target" },
  user_preference: { labelCn: "用户偏好", labelEn: "User Preference", icon: "user" },
  instruction: { labelCn: "偏好指令", labelEn: "Instruction", icon: "sparkle" },
  episodic: { labelCn: "实验事件", labelEn: "Episodic", icon: "clock" },
  fact: { labelCn: "知识事实", labelEn: "Fact", icon: "library" },
  finding: { labelCn: "研究结论", labelEn: "Finding", icon: "graph" },
  constraint: { labelCn: "约束条件", labelEn: "Constraint", icon: "shieldCheck" },
  guideline: { labelCn: "规范准则", labelEn: "Guideline", icon: "document" },
  user: { labelCn: "用户", labelEn: "User", icon: "user" },
  assistant: { labelCn: "助手", labelEn: "Assistant", icon: "sparkle" },
};

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
      background: "Confirmed project preference · confidence 95%",
      artifactPaths: ["Final/Ch2/ch2_foundations.tex", "Final/Ch2/ch2_foundations.pdf"],
      sessionId: "chat-1787849182394",
      sourceEventIds: ["chat-1787849182394:186", "chat-1787849182394:188"],
      confidenceMillis: 950,
      version: "v2",
      updatedAt: new Date().toISOString(),
    },
    {
      layer: "l1",
      id: "atom-blresn-framework",
      kind: "research_decision",
      content: "Use the existing session index as the builtin Top-5 baseline for wake turbulence compensation.",
      background: "Validated across turbulence benchmark datasets over 12 experimental runs",
      artifactPaths: ["papers/article.tex", "figures/visual-editor.svg"],
      sessionId: "chat-1787823948190",
      sourceEventIds: ["chat-1787823948190:42"],
      confidenceMillis: 880,
      version: "v1",
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
  ],
  l2: [
    {
      layer: "l2",
      id: "card-retrieval-evaluation",
      kind: "project_topic",
      content: "Compare Top-5 recall against the authoritative Sessions.",
      sessionId: "chat-20260810-1",
      sourceEventIds: ["chat-20260810-1:4"],
      version: "research_memory_v2",
      status: "active",
      updatedAt: new Date().toISOString(),
    },
    {
      layer: "l2",
      id: "card-manual-memory",
      kind: "constraint",
      content: "Keep project memory isolated.",
      sessionId: "chat-20260809-2",
      sourceEventIds: ["chat-20260809-2:1"],
      version: "research_memory_v2",
      status: "active",
      updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ],
  l3: [{
    layer: "l3",
    id: "core-profile",
    kind: "user_preference",
    version: "research_memory_v2",
    updatedAt: new Date().toISOString(),
    content: "The user values reproducible evidence, clear provenance, and project isolation.",
    status: "active",
    standingInjected: true,
  }],
};

const layerTone: Record<Layer, string> = {
  l0: "raw",
  l1: "atomic",
  l2: "scenario",
  l3: "core",
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

function sourceFromItem(item: MemoryExplorerItem): Layer {
  return item.layer;
}

// Keep the renderer bounded even if the backend ignores the requested limit. Totals remain untouched, so the layer tabs still report
// the full catalog size.
function limitSnapshotEntries(snapshot: MemoryExplorerSnapshot): MemoryExplorerSnapshot {
  return {
    ...snapshot,
    l0: snapshot.l0.slice(0, EXPLORER_ENTRY_LIMIT),
    l1: snapshot.l1.slice(0, EXPLORER_ENTRY_LIMIT),
    l2: snapshot.l2.slice(0, EXPLORER_ENTRY_LIMIT),
    l3: snapshot.l3.slice(0, EXPLORER_ENTRY_LIMIT),
  };
}

export default function MemoryExplorer({ language, projectId }: Props) {
  const copy = SETTINGS_COPY[language].memoryExplorer;
  const code = (layer: string) => `R${layer.slice(1)}`;
  const [snapshot, setSnapshot] = useState<MemoryExplorerSnapshot | null>(null);
  const [activeLayer, setActiveLayer] = useState<Layer>("l1");
  const autoSelectedProject = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<MemoryGovernanceHit[] | null>(null);
  const [expandedKey, setExpandedKey] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const loadSnapshot = async () => {
    setBusy("snapshot");
    setError("");
    try {
      const result = isTauri() ? await memoryExplorerSnapshot(EXPLORER_ENTRY_LIMIT) : PREVIEW_SNAPSHOT;
      const next = limitSnapshotEntries(result);
      setSnapshot(next);
      // R1 is the historical default tab, but a freshly cut-over project may
      // have no R1 rows yet while R2/R3 already contain reviewed memories.
      // Pick the first populated derived layer once per project so the library
      // never opens on an empty panel and falsely suggests that v2 has no data.
      if (autoSelectedProject.current !== projectId) {
        const firstPopulated = (["l1", "l2", "l3"] as Layer[]).find(
          (layer) => next[layer].length > 0,
        );
        if (firstPopulated) setActiveLayer(firstPopulated);
        autoSelectedProject.current = projectId;
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
    setExpandedKey("");
    autoSelectedProject.current = null;
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

  const renderMemoryCard = (item: MemoryExplorerItem | MemoryGovernanceHit, fromSearch = false) => {
    const source = "source" in item ? item.source : sourceFromItem(item);
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

    const rawBackground = "background" in item ? (item.background ?? "") : "";
    const confidenceMatch = rawBackground.match(/confidence\s*(\d+)%/i);
    const extractedConfidence = "confidenceMillis" in item && item.confidenceMillis != null
      ? Math.round(item.confidenceMillis / 10)
      : confidenceMatch
        ? Number.parseInt(confidenceMatch[1], 10)
        : null;

    const meaningfulBackground = rawBackground
      .replace(/[·•-]?\s*derived\s*[·•-]?\s*confidence\s*\d+%/gi, "")
      .replace(/[·•-]?\s*confidence\s*\d+%/gi, "")
      .replace(/^[·•\s-]+|[·•\s-]+$/g, "")
      .trim();

    const kindOrRole = kind ?? role;
    const kindMeta = kindOrRole ? KIND_CONFIG[kindOrRole] : null;
    const kindDisplayLabel = kindMeta
      ? (language === "cn" ? kindMeta.labelCn : kindMeta.labelEn)
      : kindOrRole;

    const artifactPaths = "artifactPaths" in item ? item.artifactPaths : undefined;
    const sourceEventIds = "sourceEventIds" in item ? item.sourceEventIds : undefined;
    const supersedesId = "supersedesId" in item ? item.supersedesId : undefined;
    const status = "status" in item ? item.status : null;
    const subjectKey = "subjectKey" in item ? item.subjectKey : null;
    const standingInjected = "standingInjected" in item ? item.standingInjected : null;
    const lifecycle = status === "pending_user_confirmation"
      ? (language === "cn" ? "待确认" : "Awaiting confirmation")
      : status === "superseded"
      ? (language === "cn" ? "历史" : "Historical")
      : status === "conflict"
        ? (language === "cn" ? "冲突" : "Conflict")
        : status && status !== "authoritative"
          ? (language === "cn" ? "当前" : "Current")
          : null;

    return (
      <article className={`memory-entry-card memory-entry-${source}`} key={key}>
        <header className="memory-entry-head">
          <div className="memory-entry-badges">
            <span className={`memory-layer-badge memory-layer-${source}`}>{code(source)}</span>
            {kindOrRole && (
              <span className="memory-kind-badge">
                {kindMeta?.icon && <SvgIcon name={kindMeta.icon} size={11} />}
                <span>{kindDisplayLabel}</span>
              </span>
            )}
            {version && <span className="memory-version-badge">{version}</span>}
            {lifecycle && (
              <span className={`memory-version-badge memory-status-${status}`}>{lifecycle}</span>
            )}
            {standingInjected !== null && (
              <span className="memory-version-badge">
                {standingInjected
                  ? language === "cn" ? "长期注入" : "Standing injection"
                  : language === "cn" ? "仅按需召回" : "Recall only"}
              </span>
            )}
            {extractedConfidence !== null && (
              <span
                className={`memory-confidence-badge ${extractedConfidence >= 80 ? "high" : extractedConfidence >= 60 ? "med" : "low"}`}
                title={language === "cn" ? `置信度: ${extractedConfidence}%` : `Confidence: ${extractedConfidence}%`}
              >
                <span className="memory-confidence-dot" />
                <span>{extractedConfidence}% {language === "cn" ? "置信度" : "confidence"}</span>
              </span>
            )}
          </div>
          <span className="memory-entry-time">
            {score !== null ? `${Math.round(score / 10)}%` : displayTime(timestamp, language)}
          </span>
        </header>

        <div className={`memory-entry-content${shouldCollapse && !isExpanded ? " is-collapsed" : ""}`}>
          {content}
        </div>
        {shouldCollapse && (
          <button
            className="memory-entry-expand"
            type="button"
            aria-expanded={isExpanded}
            onClick={() => setExpandedKey(isExpanded ? "" : key)}
          >
            {isExpanded ? copy.collapseFull : copy.expandFull}
          </button>
        )}

        {artifactPaths && artifactPaths.length > 0 && (
          <div className="memory-entry-artifacts">
            <span className="memory-artifacts-label">
              <SvgIcon name="document" size={12} />
              <span>{copy.artifactsLabel}</span>
            </span>
            <div className="memory-artifacts-chips">
              {artifactPaths.map((path) => {
                const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
                const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
                const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
                return (
                  <span className="memory-artifact-chip" key={path} title={path}>
                    {dir && <span className="memory-artifact-dir">{dir}</span>}
                    <strong className="memory-artifact-filename">{filename}</strong>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {meaningfulBackground ? (
          <div className="memory-entry-context">
            <span className="memory-context-label">
              <SvgIcon name="info" size={12} />
              <span>{copy.contextLabel}</span>
            </span>
            <span className="memory-context-text">{meaningfulBackground}</span>
          </div>
        ) : null}

        {supersedesId ? (
          <div className="memory-entry-supersedes">
            <SvgIcon name="refresh" size={12} />
            <span>{copy.knowledgeUpdateLabel} · {copy.supersedes} <code>{supersedesId}</code></span>
          </div>
        ) : null}

        <footer className="memory-entry-footer">
          <div className="memory-entry-provenance">
            {sessionId ? (
              <span className="memory-meta-pill" title={`${copy.sourceSessionLabel}: ${sessionId}`}>
                <SvgIcon name="desktop" size={11} />
                <span className="memory-meta-val">{sessionId}</span>
              </span>
            ) : (
              <span className="memory-meta-pill muted">{copy.noSourceSessionRecorded}</span>
            )}
            <span className="memory-meta-pill memory-meta-id" title={`ID: ${item.id}`}>
              <span className="memory-meta-key">ID</span>
              <span className="memory-meta-val">{item.id.replace(/^atom-/, "")}</span>
            </span>
            {sourceEventIds && sourceEventIds.length > 0 && (
              <span className="memory-meta-pill" title={sourceEventIds.join("\n")}>
                <SvgIcon name="clock" size={11} />
                <span className="memory-meta-val">
                  {sourceEventIds.length === 1
                    ? sourceEventIds[0]
                    : `${sourceEventIds.length} ${copy.sourceEventsLabel}`}
                </span>
              </span>
            )}
            {subjectKey && (
              <span className="memory-meta-pill" title={language === "cn" ? "稳定主题键" : "Stable subject key"}>
                <span className="memory-meta-key">Subject</span>
                <span className="memory-meta-val">{subjectKey}</span>
              </span>
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
          <div className="sp-section-title">{copy.title}</div>
          <div className="sp-section-sub">
            {copy.subtitle}
          </div>
        </div>
        <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => void loadSnapshot()}>
          {busy === "snapshot" ? copy.loadingEllipsis : copy.refreshLibrary}
        </button>
      </div>

      <div className="memory-pipeline" aria-label={copy.memoryLayersAriaLabel}>
          {(Object.keys(layerTone) as Layer[]).map((layer) => (
            <div className="memory-pipeline-segment" key={layer}>
              <button
                className={`memory-layer-tab memory-layer-tab-${layer}${activeLayer === layer && searchHits === null ? " active" : ""}`}
                type="button"
                role="tab"
                aria-selected={activeLayer === layer && searchHits === null}
                onClick={() => { setActiveLayer(layer); setSearchHits(null); }}
              >
                <span className="memory-layer-code">{code(layer)}</span>
                <span className="memory-layer-name">{copy.layerNames[layer]}</span>
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
              placeholder={copy.searchPlaceholder}
            />
            {searchHits !== null && (
              <button type="button" className="memory-search-clear" onClick={() => { setQuery(""); setSearchHits(null); }}>{copy.clear}</button>
            )}
          </div>
          <button className="sp-btn sp-btn-primary" type="button" disabled={Boolean(busy) || !query.trim()} onClick={() => void runSearch()}>{copy.search}</button>
        </div>

        {snapshot?.partialErrors.length ? (
          <div className="memory-partial-errors">
            <strong>{copy.somePartialUnavailable}</strong>
            {snapshot.partialErrors.map((item) => <span key={item}>{item}</span>)}
          </div>
        ) : null}

        <div className="memory-library-body">
          {searchHits !== null ? (
            <div className="memory-search-panel">
              <div className="memory-library-panel-title">
                <strong>{copy.searchResults}</strong>
                <span>{copy.resultsCount(searchHits.length)}</span>
              </div>
              <div className="memory-entry-list">
                {searchHits.map((hit) => renderMemoryCard(hit, true))}
                {searchHits.length === 0 && <div className="memory-empty-state">{copy.noMatchingMemories}</div>}
              </div>
            </div>
          ) : (
            <div className="memory-entry-list">
              {(snapshot?.[activeLayer] ?? []).map((item) => renderMemoryCard(item))}
              {snapshot && snapshot[activeLayer].length === 0 && <div className="memory-empty-state">{copy.layerEmptyContent}</div>}
            </div>
          )}
        </div>
        {snapshot && <div className="memory-library-footnote">{copy.loadedLabel} · {displayTime(snapshot.loadedAt, language)} · {copy.entriesPerLayerNote(EXPLORER_ENTRY_LIMIT)}</div>}
      {error && <div className="sp-system-prompt-error">{error}</div>}
    </div>
  );
}
