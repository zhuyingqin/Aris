import { useEffect, useState } from "react";
import {
  isTauri,
  mcpConfigGet,
  mcpConfigSet,
  mcpConfigTest,
  projectPermissionGet,
  projectPermissionSet,
} from "../api/tauri";
import { useStore } from "../store";
import type {
  McpConfigView,
  McpStdioServerInput,
  McpTestResult,
  PermissionModeView,
} from "../types";

const PERMISSIONS = [
  { mode: "read-only", label: "Plan", description: "Inspect and search only" },
  { mode: "workspace-write", label: "Accept edits", description: "Read and edit workspace files" },
  { mode: "danger-full-access", label: "Don't ask", description: "Allow shell, agents, workflows, and MCP" },
];

const isWindows =
  typeof navigator !== "undefined" && /win/i.test(navigator.userAgent);

const playwrightArgs = () => [
  isWindows ? "--browser=msedge" : "--browser=chrome",
  "--caps=pdf",
];

const PRESETS: Record<string, McpStdioServerInput> = {
  codex: {
    name: "codex",
    command: "codex",
    args: ["mcp-server"],
    env: {},
    requestTimeoutSecs: 300,
  },
  claude: {
    name: "claude",
    command: "claude",
    args: ["mcp", "serve"],
    env: {},
    requestTimeoutSecs: 300,
  },
  playwright: {
    name: "playwright",
    command: isWindows ? "cmd" : "aris-playwright-mcp",
    args: isWindows ? ["/c", "aris-playwright-mcp.cmd", ...playwrightArgs()] : playwrightArgs(),
    env: {},
    requestTimeoutSecs: 900,
  },
  custom: {
    name: "server",
    command: "",
    args: [],
    env: {},
    requestTimeoutSecs: 300,
  },
};

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

function uniqueName(base: string, servers: McpStdioServerInput[]) {
  const names = new Set(servers.map((server) => server.name));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export default function RuntimeAccess() {
  const setError = useStore((state) => state.setError);
  const [permission, setPermission] = useState<PermissionModeView | null>(null);
  const [view, setView] = useState<McpConfigView | null>(null);
  const [servers, setServers] = useState<McpStdioServerInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);

  const load = () => {
    if (!isTauri()) return;
    Promise.all([projectPermissionGet(), mcpConfigGet()])
      .then(([nextPermission, nextView]) => {
        setPermission(nextPermission);
        setView(nextView);
        setServers(nextView.servers);
      })
      .catch((error) => setError(String(error)));
  };

  useEffect(load, [setError]);

  const setProjectPermission = async (mode: string) => {
    try {
      setPermission(await projectPermissionSet(mode));
    } catch (error) {
      setError(String(error));
    }
  };

  const updateServer = (index: number, patch: Partial<McpStdioServerInput>) => {
    setTestResult(null);
    setServers((current) => current.map((server, candidate) => (
      candidate === index ? { ...server, ...patch } : server
    )));
  };

  const addPreset = (preset: keyof typeof PRESETS) => {
    setTestResult(null);
    setServers((current) => [
      ...current,
      { ...PRESETS[preset], name: uniqueName(PRESETS[preset].name, current), env: {} },
    ]);
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await mcpConfigSet(servers);
      setView(next);
      setServers(next.servers);
      setTestResult(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      setTestResult(await mcpConfigTest());
    } catch (error) {
      setError(String(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="st-layer st-layer-access">
      <div className="st-layer-head">
        <div className="st-layer-marker">04</div>
        <div className="st-layer-title-wrap">
          <div className="st-layer-title">Permissions & MCP</div>
          <div className="st-layer-sub">Project defaults and external STDIO tool servers used by Chat and CLI.</div>
        </div>
      </div>
      <div className="st-layer-body">
        <div className="st-field-group">
          <div className="st-field-label">Default permission mode</div>
          <div className="st-mode-grid">
            {PERMISSIONS.map((item) => (
              <button
                key={item.mode}
                type="button"
                className={`st-mode-option${permission?.mode === item.mode ? " active" : ""}`}
                onClick={() => void setProjectPermission(item.mode)}
              >
                <span>{item.label}</span>
                <small>{item.description}</small>
              </button>
            ))}
          </div>
          <div className="st-access-note">
            New chats use this project default. The Chat header can override it for the active session.
          </div>
        </div>

        <div className="st-mcp-head">
          <div>
            <div className="st-field-label">Project MCP servers</div>
            <div className="st-access-note">{view?.projectPath ?? "Loading project .mcp.json..."}</div>
          </div>
          <div className="st-mcp-actions">
            <button type="button" onClick={() => addPreset("codex")}>+ Codex</button>
            <button type="button" onClick={() => addPreset("claude")}>+ Claude Code</button>
            <button type="button" onClick={() => addPreset("playwright")}>+ Playwright</button>
            <button type="button" onClick={() => addPreset("custom")}>+ Custom</button>
          </div>
        </div>

        {servers.length === 0 ? (
          <div className="st-inline-state">
            <div className="st-inline-state-title">No project MCP servers</div>
            <div className="st-inline-state-copy">Add Codex, Claude Code, Playwright, or a custom STDIO server.</div>
          </div>
        ) : (
          <div className="st-mcp-list">
            {servers.map((server, index) => {
              const result = testResult?.servers.find((item) => item.name === server.name);
              return (
                <div className="st-mcp-server" key={`${server.name}:${index}`}>
                  <div className="st-mcp-server-head">
                    <input
                      aria-label={`MCP server ${index + 1} name`}
                      value={server.name}
                      onChange={(event) => updateServer(index, { name: event.currentTarget.value })}
                      placeholder="server name"
                    />
                    <span className="st-mcp-transport">STDIO</span>
                    <button
                      type="button"
                      className="st-mcp-remove"
                      onClick={() => setServers((current) => current.filter((_, candidate) => candidate !== index))}
                      title="Remove MCP server"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="st-mcp-fields">
                    <label>
                      <span>Command</span>
                      <input
                        value={server.command}
                        onChange={(event) => updateServer(index, { command: event.currentTarget.value })}
                        placeholder="codex"
                      />
                    </label>
                    <label>
                      <span>Timeout seconds</span>
                      <input
                        type="number"
                        min={1}
                        max={1800}
                        value={server.requestTimeoutSecs ?? 300}
                        onChange={(event) => updateServer(index, {
                          requestTimeoutSecs: Number(event.currentTarget.value) || 300,
                        })}
                      />
                    </label>
                    <label>
                      <span>Arguments, one per line</span>
                      <textarea
                        value={server.args.join("\n")}
                        onChange={(event) => updateServer(index, {
                          args: event.currentTarget.value.split(/\r?\n/).filter(Boolean),
                        })}
                        placeholder={"mcp-server"}
                      />
                    </label>
                    <label>
                      <span>Environment, KEY=value</span>
                      <textarea
                        value={envText(server.env)}
                        onChange={(event) => updateServer(index, { env: parseEnv(event.currentTarget.value) })}
                        placeholder="TOKEN=value"
                      />
                    </label>
                  </div>
                  {result && (
                    <div className={`st-mcp-result${result.ok ? " ok" : " failed"}`}>
                      <strong>{result.ok ? "Connected" : "Failed"}</strong>
                      <span>{result.message}</span>
                      {result.tools.length > 0 && <code>{result.tools.join(", ")}</code>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {view && view.mergedServers.length > 0 && (
          <div className="st-mcp-merged">
            <div className="st-field-label">Effective MCP configuration</div>
            <div className="st-mcp-summary-list">
              {view.mergedServers.map((server) => (
                <span key={server.name} title={server.command ?? server.transport}>
                  {server.name} · {server.transport} · {server.source}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="st-mcp-footer">
          <button type="button" className="st-test-btn" onClick={() => void test()} disabled={testing || saving}>
            {testing ? "Testing MCP..." : "Test MCP servers"}
          </button>
          <button type="button" className="st-save-btn" onClick={() => void save()} disabled={saving || testing}>
            {saving ? "Saving..." : "Save MCP configuration"}
          </button>
        </div>
      </div>
    </section>
  );
}
