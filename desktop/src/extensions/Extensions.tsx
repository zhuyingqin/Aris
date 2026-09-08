import { useEffect, useMemo, useState } from "react";
import {
  isTauri,
  mcpConfigGet,
  mcpConfigSet,
  mcpConfigTest,
  skillView,
  skillsList,
} from "../api/tauri";
import { useStore } from "../store";
import { SvgIcon, type SvgIconName } from "../SvgIcon";
import OracleWebSettings from "../settings/OracleWebSettings";
import { EXTENSIONS_COPY } from "./i18n";
import type {
  McpConfigView,
  ManagedMcpServerSummary,
  McpServerSummary,
  McpPresetSummary,
  McpStdioServerInput,
  McpTestResult,
  SkillMeta,
} from "../types";

// ── Plugins (MCP) helpers ──────────────────────────────────────────────────────

type ExtTab = "plugins" | "skills";
type ExtensionsCopy = (typeof EXTENSIONS_COPY)[keyof typeof EXTENSIONS_COPY];

function sourceLabel(source: string, copy: ExtensionsCopy) {
  if (source === "project") return copy.sourceLabels.project;
  if (source === "user") return copy.sourceLabels.user;
  if (source === "local") return copy.sourceLabels.local;
  if (source === "global") return copy.sourceLabels.global;
  if (source === "managed") return copy.sourceLabels.managed;
  return source;
}

function envText(env: Record<string, string>) {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n");
}

function parseEnv(text: string) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return index < 0 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1)];
      })
      .filter(([key]) => Boolean(key)),
  );
}

type DisplayMcpServer = McpServerSummary | ManagedMcpServerSummary;

function serverKey(server: Pick<DisplayMcpServer, "source" | "name">) {
  return `${server.source}:${server.name}`;
}

function isManagedServer(server: DisplayMcpServer): server is ManagedMcpServerSummary {
  return "status" in server;
}

function skillSourceLabel(skill: SkillMeta, copy: ExtensionsCopy) {
  return skill.path.startsWith("<bundled") ? copy.skillSourceBundled : copy.skillSourceLocal;
}

const NEW_KEY = "__new__";

const emptyDraft = (): McpStdioServerInput => ({
  name: "",
  command: "",
  args: [],
  env: {},
  requestTimeoutSecs: undefined,
});

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  icon: SvgIconName;
}

function mcpCatalog(copy: ExtensionsCopy): CatalogItem[] {
  return [
    {
      id: "codex",
      name: "Codex",
      description: copy.catalog.codexDescription,
      icon: "graph",
    },
    {
      id: "claude",
      name: "Claude Code",
      description: copy.catalog.claudeDescription,
      icon: "sparkle",
    },
    {
      id: "playwright",
      name: "Playwright",
      description: copy.catalog.playwrightDescription,
      icon: "externalLink",
    },
  ];
}

export default function Extensions() {
  const setError = useStore((state) => state.setError);
  const currentProject = useStore((state) => state.currentProject);
  const language = useStore((state) => state.language);
  const copy = EXTENSIONS_COPY[language];

  const [extTab, setExtTab] = useState<ExtTab>("plugins");

  // MCP state
  const [view, setView] = useState<McpConfigView | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpStdioServerInput | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  // Skills state
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [skillContent, setSkillContent] = useState("");

  const isNew = selectedKey === NEW_KEY;

  // ── Load MCP + Skills on project change ──────────────────────────────────────
  useEffect(() => {
    if (!isTauri()) return;
    setView(null);
    setSelectedKey(null);
    setDraft(null);
    setEditorOpen(false);
    setTestResult(null);
    setSelectedSkill(null);
    setSkillContent("");
    mcpConfigGet()
      .then((next) => {
        setView(next);
        setTestResult(next.verification?.result ?? null);
      })
      .catch((error) => setError(String(error)));
    skillsList().then(setSkills).catch((error) => setError(String(error)));
  }, [currentProject?.id, setError]);

  // ── Skill content lazy-load ──────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedSkill) {
      setSkillContent("");
      return;
    }
    let cancelled = false;
    setSkillContent(copy.loadingSkillContent);
    skillView(selectedSkill)
      .then((value) => !cancelled && setSkillContent(value))
      .catch((error) => !cancelled && setSkillContent(`Error: ${error}`));
    return () => {
      cancelled = true;
    };
  }, [selectedSkill]);

  const servers = useMemo<DisplayMcpServer[]>(
    () => view ? [...view.mergedServers, ...view.managedServers] : [],
    [view],
  );
  const configuredNames = useMemo(
    () => new Set(servers.map((server) => server.name)),
    [servers],
  );

  const selected = useMemo(
    () => (isNew ? null : servers.find((server) => serverKey(server) === selectedKey) ?? null),
    [selectedKey, servers, isNew],
  );
  const selectedGlobalServer =
    selected?.source === "global" && selected.transport === "stdio"
      ? view?.servers.find((server) => server.name === selected.name) ?? null
      : null;
  const selectedManaged = selected && isManagedServer(selected) ? selected : null;
  const selectedTest = selected
    ? testResult?.servers.find((server) => server.name === selected.name) ?? null
    : null;

  const openServer = (server: DisplayMcpServer) => {
    setSelectedKey(serverKey(server));
    const globalServer =
      server.source === "global" && server.transport === "stdio"
        ? view?.servers.find((candidate) => candidate.name === server.name) ?? null
        : null;
    setDraft(
      globalServer
        ? { ...globalServer, args: [...globalServer.args], env: { ...globalServer.env } }
        : null,
    );
    setEditorOpen(true);
  };

  const startAdd = () => {
    setSelectedKey(NEW_KEY);
    setDraft(emptyDraft());
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setSelectedKey(null);
    setDraft(null);
  };

  const addCatalog = async (item: CatalogItem, preset?: McpPresetSummary) => {
    if (!view || configuredNames.has(item.id) || !preset?.available || !preset.server) return;
    setSaving(true);
    try {
      const next = await mcpConfigSet([...view.servers, preset.server]);
      setView(next);
      setTestResult(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!view || !draft) return;
    setSaving(true);
    try {
      const nextServers = isNew
        ? [...view.servers, draft]
        : view.servers.map((server) =>
            server.name === selectedGlobalServer?.name ? draft : server,
          );
      const next = await mcpConfigSet(nextServers);
      setView(next);
      setSelectedKey(`global:${draft.name}`);
      setDraft(next.servers.find((server) => server.name === draft.name) ?? draft);
      setTestResult(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteServer = async () => {
    if (!view || !selectedGlobalServer) return;
    setSaving(true);
    try {
      const next = await mcpConfigSet(
        view.servers.filter((server) => server.name !== selectedGlobalServer.name),
      );
      setView(next);
      closeEditor();
      setTestResult(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const testTools = async () => {
    setTesting(true);
    try {
      setTestResult(await mcpConfigTest());
    } catch (error) {
      setError(String(error));
    } finally {
      setTesting(false);
    }
  };

  const showForm = isNew || (selectedGlobalServer !== null && draft !== null);

  const shownConnected = servers;
  const shownCatalog = useMemo(() => mcpCatalog(copy), [copy]);
  const presetById = useMemo(
    () => new Map((view?.presets ?? []).map((preset) => [preset.id, preset])),
    [view?.presets],
  );
  const shownSkills = skills;
  const selectedSkillMeta = useMemo(
    () => (selectedSkill ? skills.find((skill) => skill.name === selectedSkill) ?? null : null),
    [selectedSkill, skills],
  );
  const draftDirty = useMemo(() => {
    if (!draft) return false;
    if (isNew) {
      return Boolean(
        draft.name.trim()
        || draft.command.trim()
        || draft.args.length
        || Object.keys(draft.env).length,
      );
    }
    if (!selectedGlobalServer) return false;
    return draft.name !== selectedGlobalServer.name
      || draft.command !== selectedGlobalServer.command
      || draft.requestTimeoutSecs !== selectedGlobalServer.requestTimeoutSecs
      || draft.args.join("\n") !== selectedGlobalServer.args.join("\n")
      || envText(draft.env) !== envText(selectedGlobalServer.env);
  }, [draft, isNew, selectedGlobalServer]);

  if (!isTauri()) {
    return (
      <div className="board">
        <div className="empty">
          {copy.desktopOnlyPrefix}
          <code>npm run tauri dev</code>
          {copy.desktopOnlySuffix}
        </div>
      </div>
    );
  }

  return (
    <div className="ext-page">
      <header className="ext-head">
        <div className="ext-head-inner">
          <div className="ext-headline">
            <h1>{copy.title}</h1>
            <p>{copy.subtitle}</p>
          </div>
          <div className="ext-head-controls">
            <div className="ext-tabs" role="tablist" aria-label={copy.tabsAriaLabel}>
              <button
                type="button"
                role="tab"
                aria-selected={extTab === "plugins"}
                className={`ext-tab${extTab === "plugins" ? " active" : ""}`}
                onClick={() => setExtTab("plugins")}
              >
                {copy.pluginsTab}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={extTab === "skills"}
                className={`ext-tab${extTab === "skills" ? " active" : ""}`}
                onClick={() => setExtTab("skills")}
              >
                {copy.skillsTab}
              </button>
            </div>
            {extTab === "plugins" && view && (
              <div className="ext-head-actions">
                <button type="button" className="ext-secondary-btn" disabled={testing} onClick={() => void testTools()}>
                  <SvgIcon name={testing ? "spinner" : "refresh"} size={14} />
                  {testing ? copy.checkingTools : copy.testAll}
                </button>
                <button type="button" className="ext-primary-btn" onClick={startAdd}>
                  <SvgIcon name="plus" size={14} /> {copy.addCustomMcp}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="ext-scroll">
        {extTab === "plugins" ? (
          !view ? (
            <div className="ext-empty">{copy.loadingMcp}</div>
          ) : (
            <>
              <section className="ext-section">
                <div className="ext-section-head">
                  <div>
                    <h2>{copy.configuredHeading}</h2>
                    <p className="ext-section-sub">{copy.configuredSubtitle}</p>
                  </div>
                  <span className="ext-section-count">{servers.length}</span>
                </div>
                <div className="ext-config-path" title={view.configPath}>
                  <SvgIcon name="code" size={13} />
                  <span>{copy.globalConfigPath}</span>
                  <code>{view.configPath}</code>
                </div>
                {shownConnected.length === 0 ? (
                  <div className="ext-empty">{copy.noConnectedPlugins}</div>
                ) : (
                  <div className="ext-server-list">
                    {shownConnected.map((server) => {
                      const result = testResult?.servers.find((candidate) => candidate.name === server.name);
                      const managedReady = isManagedServer(server) && server.status === "ready";
                      const state = result ? (result.ok ? "verified" : "failed") : managedReady ? "ready" : "configured";
                      const stateLabel = result
                        ? (result.ok ? copy.verified : copy.failed)
                        : isManagedServer(server)
                          ? (managedReady ? copy.ready : copy.needsSetup)
                          : copy.notTested;
                      return (
                        <button
                          type="button"
                          className="ext-server-row"
                          key={serverKey(server)}
                          onClick={() => openServer(server)}
                        >
                          <span className={`ext-server-state ${state}`} aria-hidden="true" />
                          <span className="ext-server-main">
                            <strong>{server.name}</strong>
                            <span>{sourceLabel(server.source, copy)} · {server.transport.toUpperCase()}</span>
                          </span>
                          <span className={`ext-status-badge ${state}`}>{stateLabel}</span>
                          <SvgIcon name="chevronRight" size={14} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              {shownCatalog.length > 0 && (
                <section className="ext-section">
                  <div className="ext-section-head">
                    <h2>{copy.recommended}</h2>
                  </div>
                  <div className="ext-catalog">
                    {shownCatalog.map((item) => {
                      const added = configuredNames.has(item.id);
                      const preset = presetById.get(item.id);
                      return (
                        <div className="ext-card" key={item.id}>
                          <span className="ext-card-icon" aria-hidden="true">
                            <SvgIcon name={item.icon} size={19} />
                          </span>
                          <div className="ext-card-copy">
                            <strong>{item.name}</strong>
                            <span>{item.description}</span>
                            <span className={`ext-preset-availability ${preset?.available ? "available" : "unavailable"}`} title={preset?.message}>
                              {preset?.available ? copy.available : copy.unavailable}
                              {preset?.message ? ` · ${preset.message}` : ""}
                            </span>
                            {preset?.installPath && (
                              <div className="ext-preset-path" title={preset.installPath}>
                                <span>{copy.bundledInstallPath}</span>
                                <code>{preset.installPath}</code>
                              </div>
                            )}
                          </div>
                          <button
                            type="button"
                            className={`ext-add-btn${added ? " added" : ""}`}
                            disabled={added || saving || !preset?.available}
                            onClick={() => void addCatalog(item, preset)}
                          >
                            {added ? copy.added : preset?.available ? copy.add : copy.unavailable}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}
            </>
          )
        ) : (
          <section className="ext-section ext-skills-section">
            <div className="ext-section-head">
              <div>
                <h2>{copy.skillsHeading}</h2>
                <p className="ext-section-sub">{copy.skillsSubtitle}</p>
              </div>
              <span className="ext-section-count">{skills.length}</span>
            </div>
            {shownSkills.length === 0 ? (
              <div className="ext-empty">{copy.noSkillsFound}</div>
            ) : (
              <div className="ext-skills-layout">
                <div className="ext-catalog ext-skills-list" role="list">
                  {shownSkills.map((skill) => (
                    <button
                      type="button"
                      className={`ext-card ext-card-btn ext-skill-card${
                        selectedSkill === skill.name ? " active" : ""
                      }`}
                      key={skill.name}
                      onClick={() => setSelectedSkill(skill.name)}
                      aria-pressed={selectedSkill === skill.name}
                    >
                      <span className="ext-card-icon ext-card-icon-skill" aria-hidden="true">
                        <SvgIcon name="code" size={18} />
                      </span>
                      <div className="ext-card-copy">
                        <strong>/{skill.name}</strong>
                        {skill.description && <span>{skill.description}</span>}
                        {skill.argument_hint && (
                          <span className="ext-card-muted">
                            {copy.argumentHintPrefix(skill.argument_hint)}
                          </span>
                        )}
                      </div>
                      <span className="ext-card-stack">
                        <span className="ext-card-tag">{skillSourceLabel(skill, copy)}</span>
                        <span className="ext-card-action">{copy.view}</span>
                      </span>
                    </button>
                  ))}
                </div>

                {selectedSkillMeta ? (
                  <aside className="ext-skill-detail" aria-label={copy.skillDetailsAria}>
                    <div className="ext-skill-detail-head">
                      <div>
                        <span className="ext-drawer-eyebrow">SKILL.md</span>
                        <h3>/{selectedSkillMeta.name}</h3>
                      </div>
                      <span className="ext-card-tag">{skillSourceLabel(selectedSkillMeta, copy)}</span>
                    </div>

                    {selectedSkillMeta.description && (
                      <p className="ext-skill-description">{selectedSkillMeta.description}</p>
                    )}

                    <dl className="ext-skill-meta">
                      <div>
                        <dt>{copy.pathLabel}</dt>
                        <dd>{selectedSkillMeta.path}</dd>
                      </div>
                      {selectedSkillMeta.argument_hint && (
                        <div>
                          <dt>{copy.argumentsMetaLabel}</dt>
                          <dd>{selectedSkillMeta.argument_hint}</dd>
                        </div>
                      )}
                      {selectedSkillMeta.allowed_tools && (
                        <div>
                          <dt>{copy.toolsMetaLabel}</dt>
                          <dd>{selectedSkillMeta.allowed_tools}</dd>
                        </div>
                      )}
                    </dl>

                    <pre className="md-view ext-skill-content">{skillContent}</pre>
                  </aside>
                ) : (
                  <aside className="ext-skill-placeholder" aria-label={copy.skillDetailsAria}>
                    <strong>{copy.selectASkill}</strong>
                    <span>{copy.selectSkillHint}</span>
                  </aside>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      {/* ── MCP editor drawer ─────────────────────────────────────────────── */}
      {editorOpen && (selected || isNew) && (
        <>
          <button type="button" className="ext-overlay" aria-label={copy.closeAria} onClick={closeEditor} />
          <aside className={`ext-drawer${selectedManaged?.name === "oracle-web" ? " ext-drawer-oracle" : ""}`} aria-label={copy.mcpDetailsAria}>
            <div className="ext-drawer-head">
              <div>
                <span className="ext-drawer-eyebrow">
                  {isNew
                    ? copy.globalStdio
                    : `${sourceLabel(selected!.source, copy)} · ${selected!.transport.toUpperCase()}`}
                </span>
                <h2>{isNew ? draft?.name || copy.newMcpFallbackName : selected!.name}</h2>
              </div>
              <button type="button" className="ext-drawer-close" onClick={closeEditor} aria-label={copy.closeAria} title={copy.closeAria}>
                <SvgIcon name="close" size={16} />
              </button>
            </div>

            <div className="ext-drawer-body">
              {selectedManaged?.name === "oracle-web" ? (
                <OracleWebSettings language={language} embedded />
              ) : (
                <>
              {!isNew && (
                <div className="ext-drawer-actions">
                  <span className={selectedGlobalServer ? "mcp-editable" : "mcp-readonly"}>
                    {selectedGlobalServer ? copy.editable : copy.readonly}
                  </span>
                  <button type="button" disabled={testing || saving || draftDirty} onClick={() => void testTools()}>
                    {testing ? copy.checkingTools : draftDirty ? copy.saveBeforeTest : copy.testTools}
                  </button>
                  {selectedGlobalServer && (
                    <button
                      type="button"
                      className="mcp-delete-btn"
                      disabled={saving}
                      onClick={() => void deleteServer()}
                    >
                      {copy.delete}
                    </button>
                  )}
                </div>
              )}

              {!isNew && (
                <div
                  className={`mcp-runtime-status${selectedTest?.ok ? " ok" : selectedTest ? " failed" : ""}`}
                >
                  {!selectedTest ? (
                    <span>{draftDirty ? copy.unsavedTestHint : copy.runtimeStatusHint(copy.testTools)}</span>
                  ) : (
                    <>
                      <strong>{selectedTest.ok ? copy.toolsLoadedOk : copy.toolsLoadedFailed}</strong>
                      <span>{selectedTest.message}</span>
                      {selectedTest.tools.length > 0 && <code>{selectedTest.tools.join("\n")}</code>}
                    </>
                  )}
                </div>
              )}

              {showForm && draft ? (
                <div className="mcp-detail-form">
                  <label>
                    <span>{copy.nameLabel}</span>
                    <input
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>{copy.commandLabel}</span>
                    <input
                      value={draft.command}
                      onChange={(event) => setDraft({ ...draft, command: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>{copy.argsPerLineLabel}</span>
                    <textarea
                      value={draft.args.join("\n")}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          args: event.currentTarget.value.split(/\r?\n/).filter(Boolean),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{copy.envVarsLabel}</span>
                    <textarea
                      value={envText(draft.env)}
                      onChange={(event) =>
                        setDraft({ ...draft, env: parseEnv(event.currentTarget.value) })
                      }
                    />
                  </label>
                  <label>
                    <span>{copy.timeoutSecondsLabel}</span>
                    <input
                      type="number"
                      min={1}
                      max={1800}
                      value={draft.requestTimeoutSecs ?? 300}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          requestTimeoutSecs: Number(event.currentTarget.value) || 300,
                        })
                      }
                    />
                  </label>
                  <div className="mcp-form-actions">
                    <button type="button" className="primary" disabled={saving || !draftDirty} onClick={() => void save()}>
                      {saving ? copy.saving : !draftDirty ? copy.saved : isNew ? copy.addMcp : copy.saveSettings}
                    </button>
                    <button type="button" onClick={closeEditor}>
                      {copy.cancel}
                    </button>
                  </div>
                  <p className="mcp-reload-note">{copy.reloadNote}</p>
                </div>
              ) : (
                <dl className="mcp-detail-readonly">
                  <div>
                    <dt>{copy.nameLabel}</dt>
                    <dd>{selected!.name}</dd>
                  </div>
                  <div>
                    <dt>{copy.sourceLabelHeading}</dt>
                    <dd>{sourceLabel(selected!.source, copy)}</dd>
                  </div>
                  <div>
                    <dt>{copy.connectionTypeLabel}</dt>
                    <dd>{selected!.transport.toUpperCase()}</dd>
                  </div>
                  {selected!.command && (
                    <div>
                      <dt>{copy.commandLabel}</dt>
                      <dd>{selected!.command}</dd>
                    </div>
                  )}
                  <p>{copy.viewOnlyNote}</p>
                </dl>
              )}
                </>
              )}
            </div>
          </aside>
        </>
      )}

    </div>
  );
}
