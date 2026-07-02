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
import type {
  McpConfigView,
  McpServerSummary,
  McpStdioServerInput,
  McpTestResult,
  SkillMeta,
} from "../types";

// ── Plugins (MCP) helpers ──────────────────────────────────────────────────────

type ExtTab = "plugins" | "skills";

function sourceLabel(source: string) {
  if (source === "project") return "当前项目";
  if (source === "user") return "用户配置";
  if (source === "local") return "本地配置";
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

function skillSourceLabel(skill: SkillMeta) {
  return skill.path.startsWith("<bundled") ? "内置" : "本地";
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
];

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  glyph: string;
  build: () => McpStdioServerInput;
}

/** Curated one-click MCP servers SomniQ knows how to launch. The `id` must match
 *  the server `name` we write so the connected-state check lines up. On Windows,
 *  npm-shim CLIs (codex) must go through `cmd /c` — the runtime spawns via
 *  CreateProcess, which cannot execute a `.cmd` directly. */
const MCP_CATALOG: CatalogItem[] = [
  {
    id: "codex",
    name: "Codex",
    description: "把 OpenAI Codex 作为外部推理 / 审稿代理（codex · codex-reply）",
    glyph: "⌘",
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
    description: "接入 Claude Code 的完整工具集（Read / Edit / Grep / Agent …）",
    glyph: "✶",
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
    description: "Browser automation via SomniQ bundled Playwright MCP.",
    glyph: "P",
    build: () => ({
      name: "playwright",
      command: isWindows ? "cmd" : "aris-playwright-mcp",
      args: isWindows ? ["/c", "aris-playwright-mcp.cmd", ...playwrightArgs()] : playwrightArgs(),
      env: {},
      requestTimeoutSecs: 900,
    }),
  },
];

export default function Extensions() {
  const setError = useStore((state) => state.setError);
  const currentProject = useStore((state) => state.currentProject);

  const [extTab, setExtTab] = useState<ExtTab>("plugins");
  const [search, setSearch] = useState("");

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
    setSkillContent("正在读取 SKILL.md…");
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

  // ── Search filtering ─────────────────────────────────────────────────────────
  const query = search.trim().toLowerCase();
  const matchesQuery = (...fields: (string | null | undefined)[]) =>
    !query || fields.some((f) => (f ?? "").toLowerCase().includes(query));

  const shownConnected = servers.filter((s) => matchesQuery(s.name, s.source, s.transport));
  const shownCatalog = MCP_CATALOG.filter((c) => matchesQuery(c.name, c.description, c.id));
  const shownSkills = useMemo(() => {
    if (!query) return skills;
    return skills.filter((s) =>
      matchesQuery(s.name, s.description, s.argument_hint, s.allowed_tools, s.path),
    );
  }, [skills, query]);
  const selectedSkillMeta = useMemo(
    () => (selectedSkill ? skills.find((skill) => skill.name === selectedSkill) ?? null : null),
    [selectedSkill, skills],
  );

  if (!isTauri()) {
    return (
      <div className="board">
        <div className="empty">插件与技能需要桌面端支持。运行 <code>npm run tauri dev</code>。</div>
      </div>
    );
  }

  return (
    <div className="ext-page">
      <header className="ext-head">
        <div className="ext-tabs" role="tablist" aria-label="插件与技能">
          <button
            type="button"
            role="tab"
            aria-selected={extTab === "plugins"}
            className={`ext-tab${extTab === "plugins" ? " active" : ""}`}
            onClick={() => setExtTab("plugins")}
          >
            插件
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={extTab === "skills"}
            className={`ext-tab${extTab === "skills" ? " active" : ""}`}
            onClick={() => setExtTab("skills")}
          >
            技能
          </button>
        </div>

        <div className="ext-headline">
          <h1>{extTab === "plugins" ? "插件" : "技能"}</h1>
          <p>
            {extTab === "plugins"
              ? "在 SomniQ 中接入并管理 MCP 工具"
              : "浏览并查看当前可用的技能"}
          </p>
        </div>

        <div className="ext-search">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            placeholder="搜索插件和技能"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
      </header>

      <div className="ext-scroll">
        {extTab === "plugins" ? (
          !view ? (
            <div className="st-inline-state">
              <div className="st-inline-state-title">正在读取 MCP...</div>
            </div>
          ) : (
            <>
              <section className="ext-section">
                <div className="ext-section-head">
                  <h2>已连接</h2>
                  <span className="ext-section-count">{servers.length}</span>
                </div>
                {shownConnected.length === 0 ? (
                  <div className="ext-empty">
                    {query ? "没有匹配的已连接插件" : "还没有连接任何 MCP 插件"}
                  </div>
                ) : (
                  <div className="ext-connected">
                    {shownConnected.map((server) => (
                      <button
                        type="button"
                        className="ext-tile"
                        key={serverKey(server)}
                        onClick={() => openServer(server)}
                        title={`${server.name} · ${sourceLabel(server.source)}`}
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
                  + 添加自定义 MCP
                </button>
              </section>

              {shownCatalog.length > 0 && (
                <section className="ext-section">
                  <div className="ext-section-head">
                    <h2>推荐</h2>
                  </div>
                  <div className="ext-catalog">
                    {shownCatalog.map((item) => {
                      const added = connectedNames.has(item.id);
                      return (
                        <div className="ext-card" key={item.id}>
                          <span className="ext-card-icon" aria-hidden="true">
                            {item.glyph}
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
                            {added ? "已添加" : "添加"}
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
                <h2>技能</h2>
                <p className="ext-section-sub">点击一个技能查看说明、路径和完整 SKILL.md。</p>
              </div>
              <span className="ext-section-count">{skills.length}</span>
            </div>
            {shownSkills.length === 0 ? (
              <div className="ext-empty">
                {query ? "没有匹配的技能" : "未发现可用技能"}
              </div>
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
                          <span className="ext-card-muted">参数：{skill.argument_hint}</span>
                        )}
                      </div>
                      <span className="ext-card-stack">
                        <span className="ext-card-tag">{skillSourceLabel(skill)}</span>
                        <span className="ext-card-action">查看</span>
                      </span>
                    </button>
                  ))}
                </div>

                {selectedSkillMeta ? (
                  <aside className="ext-skill-detail" aria-label="技能详情">
                    <div className="ext-skill-detail-head">
                      <div>
                        <span className="ext-drawer-eyebrow">SKILL.md</span>
                        <h3>/{selectedSkillMeta.name}</h3>
                      </div>
                      <span className="ext-card-tag">{skillSourceLabel(selectedSkillMeta)}</span>
                    </div>

                    {selectedSkillMeta.description && (
                      <p className="ext-skill-description">{selectedSkillMeta.description}</p>
                    )}

                    <dl className="ext-skill-meta">
                      <div>
                        <dt>路径</dt>
                        <dd>{selectedSkillMeta.path}</dd>
                      </div>
                      {selectedSkillMeta.argument_hint && (
                        <div>
                          <dt>参数</dt>
                          <dd>{selectedSkillMeta.argument_hint}</dd>
                        </div>
                      )}
                      {selectedSkillMeta.allowed_tools && (
                        <div>
                          <dt>工具</dt>
                          <dd>{selectedSkillMeta.allowed_tools}</dd>
                        </div>
                      )}
                    </dl>

                    <pre className="md-view ext-skill-content">{skillContent}</pre>
                  </aside>
                ) : (
                  <aside className="ext-skill-placeholder" aria-label="技能详情">
                    <strong>选择一个技能</strong>
                    <span>点开左侧列表后，会在这里查看技能说明和完整 SKILL.md。</span>
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
          <button className="ext-overlay" aria-label="关闭" onClick={closeEditor} />
          <aside className="ext-drawer" aria-label="MCP 详情">
            <div className="ext-drawer-head">
              <div>
                <span className="ext-drawer-eyebrow">
                  {isNew
                    ? "当前项目 · STDIO"
                    : `${sourceLabel(selected!.source)} · ${selected!.transport.toUpperCase()}`}
                </span>
                <h2>{isNew ? draft?.name || "新 MCP" : selected!.name}</h2>
              </div>
              <button type="button" className="ext-drawer-close" onClick={closeEditor}>
                ×
              </button>
            </div>

            <div className="ext-drawer-body">
              {!isNew && (
                <div className="ext-drawer-actions">
                  <span className={selectedProjectServer ? "mcp-editable" : "mcp-readonly"}>
                    {selectedProjectServer ? "可编辑" : "只读"}
                  </span>
                  <button type="button" disabled={testing || saving} onClick={() => void testTools()}>
                    {testing ? "检测中..." : "检测工具"}
                  </button>
                  {selectedProjectServer && (
                    <button
                      type="button"
                      className="mcp-delete-btn"
                      disabled={saving}
                      onClick={() => void deleteServer()}
                    >
                      删除
                    </button>
                  )}
                </div>
              )}

              {!isNew && (
                <div
                  className={`mcp-runtime-status${selectedTest?.ok ? " ok" : selectedTest ? " failed" : ""}`}
                >
                  {!selectedTest ? (
                    <span>配置文件存在不代表工具已经加载。点击"检测工具"确认服务器实际返回的工具。</span>
                  ) : (
                    <>
                      <strong>{selectedTest.ok ? "工具加载成功" : "工具加载失败"}</strong>
                      <span>{selectedTest.message}</span>
                      {selectedTest.tools.length > 0 && <code>{selectedTest.tools.join("\n")}</code>}
                    </>
                  )}
                </div>
              )}

              {showForm && draft ? (
                <div className="mcp-detail-form">
                  <label>
                    <span>名称</span>
                    <input
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>命令</span>
                    <input
                      value={draft.command}
                      onChange={(event) => setDraft({ ...draft, command: event.currentTarget.value })}
                    />
                  </label>
                  <label>
                    <span>参数，每行一个</span>
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
                    <span>环境变量，KEY=value</span>
                    <textarea
                      value={envText(draft.env)}
                      onChange={(event) =>
                        setDraft({ ...draft, env: parseEnv(event.currentTarget.value) })
                      }
                    />
                  </label>
                  <label>
                    <span>超时秒数</span>
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
                      {saving ? "保存中..." : isNew ? "添加 MCP" : "保存设置"}
                    </button>
                    <button type="button" onClick={closeEditor}>
                      取消
                    </button>
                  </div>
                  <p className="mcp-reload-note">保存后，下一条 Chat 消息会重新发现并加载 MCP 工具。</p>
                </div>
              ) : (
                <dl className="mcp-detail-readonly">
                  <div>
                    <dt>名称</dt>
                    <dd>{selected!.name}</dd>
                  </div>
                  <div>
                    <dt>来源</dt>
                    <dd>{sourceLabel(selected!.source)}</dd>
                  </div>
                  <div>
                    <dt>连接类型</dt>
                    <dd>{selected!.transport.toUpperCase()}</dd>
                  </div>
                  {selected!.command && (
                    <div>
                      <dt>命令</dt>
                      <dd>{selected!.command}</dd>
                    </div>
                  )}
                  <p>该 MCP 不属于当前项目的 STDIO 配置，因此只能查看。</p>
                </dl>
              )}
            </div>
          </aside>
        </>
      )}

    </div>
  );
}
