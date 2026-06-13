import { useEffect, useMemo, useState } from "react";
import { isTauri, mcpConfigGet, mcpConfigSet, mcpConfigTest } from "../api/tauri";
import { useStore } from "../store";
import type {
  McpConfigView,
  McpServerSummary,
  McpStdioServerInput,
  McpTestResult,
} from "../types";

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

export default function McpPage() {
  const setError = useStore((state) => state.setError);
  const currentProject = useStore((state) => state.currentProject);
  const [view, setView] = useState<McpConfigView | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpStdioServerInput | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    setView(null);
    setSelectedKey(null);
    setDraft(null);
    setTestResult(null);
    mcpConfigGet()
      .then(setView)
      .catch((error) => setError(String(error)));
  }, [currentProject?.id, setError]);

  const servers = view?.mergedServers ?? [];
  const selected = useMemo(
    () => servers.find((server) => serverKey(server) === selectedKey) ?? null,
    [selectedKey, servers],
  );
  const selectedProjectServer = selected?.source === "project" && selected.transport === "stdio"
    ? view?.servers.find((server) => server.name === selected.name) ?? null
    : null;
  const selectedTest = selected
    ? testResult?.servers.find((server) => server.name === selected.name) ?? null
    : null;

  const selectServer = (server: McpServerSummary) => {
    setSelectedKey(serverKey(server));
    const projectServer = server.source === "project" && server.transport === "stdio"
      ? view?.servers.find((candidate) => candidate.name === server.name) ?? null
      : null;
    setDraft(projectServer ? {
      ...projectServer,
      args: [...projectServer.args],
      env: { ...projectServer.env },
    } : null);
  };

  const save = async () => {
    if (!view || !selectedProjectServer || !draft) return;
    setSaving(true);
    try {
      const next = await mcpConfigSet(view.servers.map((server) => (
        server.name === selectedProjectServer.name ? draft : server
      )));
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

  if (!isTauri()) {
    return (
      <div className="board">
        <div className="empty">MCP 列表需要桌面端支持。</div>
      </div>
    );
  }

  return (
    <div className="mcp-page">
      <header className="mcp-page-head">
        <div>
          <div className="st-eyebrow">Model Context Protocol</div>
          <h1>当前 MCP</h1>
          <p>选择一个 MCP 查看详情和设置。</p>
        </div>
        <span className="mcp-count">{view ? servers.length : "..."}</span>
      </header>

      <div className="mcp-page-scroll">
        {!view ? (
          <div className="st-inline-state">
            <div className="st-inline-state-title">正在读取 MCP...</div>
          </div>
        ) : servers.length === 0 ? (
          <div className="st-inline-state">
            <div className="st-inline-state-title">当前没有可用的 MCP</div>
          </div>
        ) : (
          <div className="mcp-browser">
            <section className="mcp-list" aria-label="当前可用的 MCP">
              {servers.map((server) => (
                <button
                  type="button"
                  className={`mcp-list-item${selectedKey === serverKey(server) ? " active" : ""}`}
                  key={serverKey(server)}
                  onClick={() => selectServer(server)}
                >
                  <span className="mcp-list-dot" aria-hidden="true" />
                  <span className="mcp-list-copy">
                    <strong>{server.name}</strong>
                    <span>{sourceLabel(server.source)}</span>
                  </span>
                  <span className="mcp-transport">{server.transport.toUpperCase()}</span>
                </button>
              ))}
            </section>

            <section className="mcp-detail" aria-label="MCP 详情">
              {!selected ? (
                <div className="mcp-detail-empty">点击左侧 MCP 查看详情</div>
              ) : (
                <>
                  <div className="mcp-detail-head">
                    <div>
                      <span>{sourceLabel(selected.source)} · {selected.transport.toUpperCase()}</span>
                      <h2>{selected.name}</h2>
                    </div>
                    <div className="mcp-detail-actions">
                      <span className={selectedProjectServer ? "mcp-editable" : "mcp-readonly"}>
                        {selectedProjectServer ? "可编辑" : "只读"}
                      </span>
                      <button type="button" disabled={testing || saving} onClick={() => void testTools()}>
                        {testing ? "检测中..." : "检测工具"}
                      </button>
                    </div>
                  </div>

                  <div className={`mcp-runtime-status${selectedTest?.ok ? " ok" : selectedTest ? " failed" : ""}`}>
                    {!selectedTest ? (
                      <span>配置文件存在不代表工具已经加载。点击“检测工具”确认服务器实际返回的工具。</span>
                    ) : (
                      <>
                        <strong>{selectedTest.ok ? "工具加载成功" : "工具加载失败"}</strong>
                        <span>{selectedTest.message}</span>
                        {selectedTest.tools.length > 0 && <code>{selectedTest.tools.join("\n")}</code>}
                      </>
                    )}
                  </div>

                  {selectedProjectServer && draft ? (
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
                          onChange={(event) => setDraft({
                            ...draft,
                            args: event.currentTarget.value.split(/\r?\n/).filter(Boolean),
                          })}
                        />
                      </label>
                      <label>
                        <span>环境变量，KEY=value</span>
                        <textarea
                          value={envText(draft.env)}
                          onChange={(event) => setDraft({ ...draft, env: parseEnv(event.currentTarget.value) })}
                        />
                      </label>
                      <label>
                        <span>超时秒数</span>
                        <input
                          type="number"
                          min={1}
                          max={1800}
                          value={draft.requestTimeoutSecs ?? 300}
                          onChange={(event) => setDraft({
                            ...draft,
                            requestTimeoutSecs: Number(event.currentTarget.value) || 300,
                          })}
                        />
                      </label>
                      <button
                        type="button"
                        className="primary mcp-save"
                        disabled={saving}
                        onClick={() => void save()}
                      >
                        {saving ? "保存中..." : "保存设置"}
                      </button>
                      <p className="mcp-reload-note">保存后，下一条 Chat 消息会重新发现并加载 MCP 工具。</p>
                    </div>
                  ) : (
                    <dl className="mcp-detail-readonly">
                      <div><dt>名称</dt><dd>{selected.name}</dd></div>
                      <div><dt>来源</dt><dd>{sourceLabel(selected.source)}</dd></div>
                      <div><dt>连接类型</dt><dd>{selected.transport.toUpperCase()}</dd></div>
                      {selected.command && <div><dt>命令</dt><dd>{selected.command}</dd></div>}
                      <p>该 MCP 不属于当前项目的 STDIO 配置，因此只能查看。</p>
                    </dl>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
