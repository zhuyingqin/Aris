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
import { EXTENSIONS_COPY } from "./i18n";
import type {
  McpConfigView,
  McpServerSummary,
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

function serverKey(server: McpServerSummary) {
  return `${server.source}:${server.name}`;
}

function tileGlyph(name: string) {
  return (name.trim()[0] ?? "?").toUpperCase();
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

const isWindows =
  typeof navigator !== "undefined" && /win/i.test(navigator.userAgent);

const playwrightArgs = () => [
  isWindows ? "--browser=msedge" : "--browser=chrome",
  "--caps=pdf",
  "--user-data-dir",
  ".somniq/tmp/browser/profile",
  "--output-dir",
  ".somniq/tmp/browser/output",
];

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  icon: SvgIconName;
  build: () => McpStdioServerInput;
}

/** Curated one-click MCP servers SomniQ knows how to launch. The `id` must match
 *  the server `name` we write so the connected-state check lines up. On Windows,
 *  npm-shim CLIs (codex) must go through `cmd /c` — the runtime spawns via
 *  CreateProcess, which cannot execute a `.cmd` directly. */
function mcpCatalog(copy: ExtensionsCopy): CatalogItem[] {
  return [
    {
      id: "codex",
      name: "Codex",
      description: copy.catalog.codexDescription,
      icon: "graph",
      build: () => ({
        name: "codex",
        command: isWindows ? "cmd" : "codex",
        args: isWindows ? ["/c", "codex", "mcp-server"] : ["mcp-server"],
        env: {},
        requestTimeoutSecs: 900,
      }),
    },
    {
      id: "claude",
      name: "Claude Code",
      description: copy.catalog.claudeDescription,
      icon: "sparkle",
      build: () => ({
        name: "claude",
        command: "claude",
        args: ["mcp", "serve"],
        env: {},
        requestTimeoutSecs: 900,
      }),
    },
    {
      id: "playwright",
      name: "Playwright",
      description: copy.catalog.playwrightDescription,
      icon: "externalLink",
      build: () => ({
        name: "playwright",
        command: isWindows ? "cmd" : "aris-playwright-mcp",
        args: isWindows ? ["/c", "aris-playwright-mcp.cmd", ...playwrightArgs()] : playwrightArgs(),
        env: {},
        requestTimeoutSecs: 900,
      }),
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
    mcpConfigGet().then(setView).catch((error) => setError(String(error)));
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

  const servers = view?.mergedServers ?? [];
  const connectedNames = useMemo(
    () => new Set(servers.map((server) => server.name)),
    [servers],
  );

  const selected = useMemo(
    () => (isNew ? null : servers.find((server) => serverKey(server) === selectedKey) ?? null),
    [selectedKey, servers, isNew],
  );
  const selectedProjectServer =
    selected?.source === "project" && selected.transport === "stdio"
      ? view?.servers.find((server) => server.name === selected.name) ?? null
      : null;
  const selectedTest = selected
    ? testResult?.servers.find((server) => server.name === selected.name) ?? null
    : null;

  const openServer = (server: McpServerSummary) => {
    setSelectedKey(serverKey(server));
    const projectServer =
      server.source === "project" && server.transport === "stdio"
        ? view?.servers.find((candidate) => candidate.name === server.name) ?? null
        : null;
    setDraft(
      projectServer
        ? { ...projectServer, args: [...projectServer.args], env: { ...projectServer.env } }
        : null,
    );
    setTestResult(null);
    setEditorOpen(true);
  };

  const startAdd = () => {
    setSelectedKey(NEW_KEY);
    setDraft(emptyDraft());
    setTestResult(null);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setSelectedKey(null);
    setDraft(null);
  };

  const addCatalog = async (item: CatalogItem) => {
    if (!view || connectedNames.has(item.id)) return;
    setSaving(true);
    try {
      const next = await mcpConfigSet([...view.servers, item.build()]);
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
            server.name === selectedProjectServer?.name ? draft : server,
          );
      const next = await mcpConfigSet(nextServers);
      setView(next);
      setSelectedKey(`project:${draft.name}`);
      setDraft(next.servers.find((server) => server.name === draft.name) ?? draft);
      setTestResult(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const deleteServer = async () => {
    if (!view || !selectedProjectServer) return;
    setSaving(true);
    try {
      const next = await mcpConfigSet(
        view.servers.filter((server) => server.name !== selectedProjectServer.name),
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

  const showForm = isNew || (selectedProjectServer !== null && draft !== null);

  const shownConnected = servers;
  const shownCatalog = useMemo(() => mcpCatalog(copy), [copy]);
  const shownSkills = skills;
  const selectedSkillMeta = useMemo(
    () => (selectedSkill ? skills.find((skill) => skill.name === selectedSkill) ?? null : null),
    [selectedSkill, skills],
  );

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
      </header>

      <div className="ext-scroll">
        {extTab === "plugins" ? (
          !view ? (
            <div className="st-inline-state">
              <div className="st-inline-state-title">{copy.loadingMcp}</div>
            </div>
          ) : (
            <>
              <section className="ext-section">
                <div className="ext-section-head">
                  <h2>{copy.connectedHeading}</h2>
                  <span className="ext-section-count">{servers.length}</span>
                </div>
                {shownConnected.length === 0 ? (
                  <div className="ext-empty">{copy.noConnectedPlugins}</div>
                ) : (
                  <div className="ext-connected">
                    {shownConnected.map((server) => (
                      <button
                        type="button"
                        className="ext-tile"
                        key={serverKey(server)}
                        onClick={() => openServer(server)}
                        title={`${server.name} · ${sourceLabel(server.source, copy)}`}
                      >
                        <span className="ext-tile-icon" aria-hidden="true">
                          {tileGlyph(server.name)}
                        </span>
                        <span className="ext-tile-name">{server.name}</span>
                        <span className="ext-tile-sub">{server.transport.toUpperCase()}</span>
                      </button>
                    ))}
                  </div>
                )}
                <button type="button" className="ext-link" onClick={startAdd}>
                  <SvgIcon name="plus" size={14} /> {copy.addCustomMcp}
                </button>
              </section>

              {shownCatalog.length > 0 && (
                <section className="ext-section">
                  <div className="ext-section-head">
                    <h2>{copy.recommended}</h2>
                  </div>
                  <div className="ext-catalog">
                    {shownCatalog.map((item) => {
                      const added = connectedNames.has(item.id);
                      return (
                        <div className="ext-card" key={item.id}>
                          <span className="ext-card-icon" aria-hidden="true">
                            <SvgIcon name={item.icon} size={19} />
                          </span>
                          <div className="ext-card-copy">
                            <strong>{item.name}</strong>
                            <span>{item.description}</span>
                          </div>
                          <button
                            type="button"
                            className={`ext-add-btn${added ? " added" : ""}`}
                            disabled={added || saving}
                            onClick={() => void addCatalog(item)}
                          >
                            {added ? copy.added : copy.add}
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
                        /
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
          <button className="ext-overlay" aria-label={copy.closeAria} onClick={closeEditor} />
          <aside className="ext-drawer" aria-label={copy.mcpDetailsAria}>
            <div className="ext-drawer-head">
              <div>
                <span className="ext-drawer-eyebrow">
                  {isNew
                    ? copy.currentProjectStdio
                    : `${sourceLabel(selected!.source, copy)} · ${selected!.transport.toUpperCase()}`}
                </span>
                <h2>{isNew ? draft?.name || copy.newMcpFallbackName : selected!.name}</h2>
              </div>
              <button type="button" className="ext-drawer-close" onClick={closeEditor}>
                <SvgIcon name="close" size={16} />
              </button>
            </div>

            <div className="ext-drawer-body">
              {!isNew && (
                <div className="ext-drawer-actions">
                  <span className={selectedProjectServer ? "mcp-editable" : "mcp-readonly"}>
                    {selectedProjectServer ? copy.editable : copy.readonly}
                  </span>
                  <button type="button" disabled={testing || saving} onClick={() => void testTools()}>
                    {testing ? copy.checkingTools : copy.testTools}
                  </button>
                  {selectedProjectServer && (
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
                    <span>{copy.runtimeStatusHint(copy.testTools)}</span>
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
                    <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
                      {saving ? copy.saving : isNew ? copy.addMcp : copy.saveSettings}
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
            </div>
          </aside>
        </>
      )}

    </div>
  );
}
