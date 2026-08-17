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
      id: "card-retrieval-evaluation",
      title: "Experiment episode · Session chat-20260810-1",
      version: "v3",
      updatedAt: new Date().toISOString(),
    },
    {
      layer: "l2",
      id: "card-manual-memory",
      title: "Research decision episode · Session chat-20260809-2",
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
  const copy = SETTINGS_COPY[language].memoryExplorer;
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
    const id = item.path ?? item.id;
    setSelectedScenario(item);
    setScenarioContent(null);
    setBusy("scenario");
    setError("");
    try {
      const content = isTauri()
        ? await memoryGovernanceReadScenario(id)
        : id.includes("manual")
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
    const confirmed = window.confirm(copy.deleteConfirm);
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
            aria-label={copy.editMemoryContentAriaLabel}
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
                {isExpanded ? copy.collapseFull : copy.expandFull}
              </button>
            )}
          </>
        )}
        {"background" in item && item.background && (
          <div className="memory-entry-background"><strong>{copy.contextLabel}</strong>{item.background}</div>
        )}
        {"artifactPaths" in item && item.artifactPaths?.length ? (
          <div className="memory-entry-background"><strong>{copy.artifactsLabel}</strong>{item.artifactPaths.join(" · ")}</div>
        ) : null}
        {"sourceEventIds" in item && item.sourceEventIds?.length ? (
          <div className="memory-entry-background"><strong>{copy.sourceEventsLabel}</strong>{item.sourceEventIds.join(" · ")}</div>
        ) : null}
        {"supersedesId" in item && item.supersedesId ? (
          <div className="memory-entry-background"><strong>{copy.knowledgeUpdateLabel}</strong>{copy.supersedes} {item.supersedesId}</div>
        ) : null}
        <footer className="memory-entry-footer">
          <span title={item.id}>ID · {item.id}</span>
          {sessionId
            ? <span title={sessionId}>{copy.sourceSessionLabel} · {sessionId}</span>
            : <span>{copy.noSourceSessionRecorded}</span>}
          <div className="memory-entry-actions">
            {source === "l1" && (editingKey === key ? (
              <>
                <button className="sp-btn sp-btn-primary" type="button" disabled={Boolean(busy) || !editingContent.trim()} onClick={() => void updateMemory(source, item.id)}>{copy.saveCorrection}</button>
                <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => setEditingKey("")}>{copy.cancel}</button>
              </>
            ) : (
              <button className="sp-btn sp-btn-secondary" type="button" disabled={Boolean(busy)} onClick={() => { setEditingKey(key); setEditingContent(content); }}>{copy.edit}</button>
            ))}
            {source === "l1" && (
              <button className="sp-btn sp-btn-secondary memory-delete-btn" type="button" disabled={Boolean(busy)} onClick={() => void deleteMemory(source, item.id)}>{copy.delete}</button>
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
          ) : activeLayer === "l0" || activeLayer === "l1" ? (
            <div className="memory-entry-list">
              {(snapshot?.[activeLayer] ?? []).map((item) => renderMemoryCard(item))}
              {snapshot && snapshot[activeLayer].length === 0 && <div className="memory-empty-state">{copy.layerEmptyContent}</div>}
            </div>
          ) : activeLayer === "l2" ? (
            <div className="memory-scenario-browser">
              <nav className="memory-scenario-list" aria-label={copy.researchEpisodesAriaLabel}>
                {(snapshot?.l2 ?? []).map((item) => (
                  <button
                    className={selectedScenario?.id === item.id ? "active" : ""}
                    type="button"
                    key={item.id}
                    onClick={() => void readScenario(item)}
                  >
                    <span className="memory-scenario-file-icon">◇</span>
                    <span><strong>{item.title || copy.untitledEpisode}</strong><small>{item.version} · {displayTime(item.updatedAt, language)}</small></span>
                  </button>
                ))}
                {snapshot?.l2.length === 0 && <div className="memory-empty-state">{copy.noResearchEpisodesYet}</div>}
              </nav>
              <section className="memory-document-viewer">
                {selectedScenario ? (
                  <>
                    <header>
                      <div><span className="memory-layer-badge memory-layer-l2">{code("l2")}</span><strong>{selectedScenario.title ?? selectedScenario.id}</strong></div>
                      <span>{selectedScenario.version} · {displayTime(selectedScenario.updatedAt, language)}</span>
                    </header>
                    <pre>{busy === "scenario" ? copy.loadingEllipsis : scenarioContent || copy.episodeEmpty}</pre>
                    <footer>{copy.readOnlyConsolidatedFooter}</footer>
                  </>
                ) : <div className="memory-empty-state">{copy.selectEpisodeToInspect}</div>}
              </section>
            </div>
          ) : (
            <section className="memory-core-viewer">
              {snapshot?.l3 ? (
                <>
                  <header>
                    <div><span className="memory-layer-badge memory-layer-l3">{code("l3")}</span><strong>{copy.coreProfile}</strong></div>
                    <span>{snapshot.l3.version} · {displayTime(snapshot.l3.updatedAt, language)}</span>
                  </header>
                  <pre>{snapshot.l3.content}</pre>
                  <footer>{copy.derivedFromTracedFooter}</footer>
                </>
              ) : <div className="memory-empty-state">{copy.coreProfileNotGenerated}</div>}
            </section>
          )}
        </div>
        {snapshot && <div className="memory-library-footnote">{copy.loadedLabel} · {displayTime(snapshot.loadedAt, language)} · {copy.entriesPerLayerNote(EXPLORER_ENTRY_LIMIT)}</div>}
      {error && <div className="sp-system-prompt-error">{error}</div>}
    </div>
  );
}
