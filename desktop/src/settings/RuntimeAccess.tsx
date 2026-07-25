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
import { RUNTIME_ACCESS_COPY } from "./i18n";

const PERMISSION_MODES = ["read-only", "workspace-write", "danger-full-access"];

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
  const currentProject = useStore((state) => state.currentProject);
  const language = useStore((state) => state.language);
  const copy = RUNTIME_ACCESS_COPY[language];
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

  useEffect(load, [currentProject?.id, setError]);

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
          <div className="st-layer-title">{copy.title}</div>
          <div className="st-layer-sub">{copy.subtitle}</div>
        </div>
      </div>
      <div className="st-layer-body">
        <div className="st-field-group">
          <div className="st-field-label">{copy.defaultPermissionMode}</div>
          <div className="st-mode-grid">
            {PERMISSION_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={`st-mode-option${permission?.mode === mode ? " active" : ""}`}
                onClick={() => void setProjectPermission(mode)}
              >
                <span>{copy.permissionLabel(mode)}</span>
                <small>{copy.permissionDescription(mode)}</small>
              </button>
            ))}
          </div>
          <div className="st-access-note">
            {copy.accessNote}
          </div>
        </div>

        <div className="st-mcp-head">
          <div>
            <div className="st-field-label">{copy.projectMcpServers}</div>
            <div className="st-access-note">{view?.projectPath ?? copy.loadingProjectPath}</div>
          </div>
          <div className="st-mcp-actions">
            <button type="button" onClick={() => addPreset("codex")}>{copy.addCodex}</button>
            <button type="button" onClick={() => addPreset("claude")}>{copy.addClaudeCode}</button>
            <button type="button" onClick={() => addPreset("playwright")}>{copy.addPlaywright}</button>
            <button type="button" onClick={() => addPreset("custom")}>{copy.addCustom}</button>
          </div>
        </div>

        {servers.length === 0 ? (
          <div className="st-inline-state">
            <div className="st-inline-state-title">{copy.noProjectMcpServers}</div>
            <div className="st-inline-state-copy">{copy.noProjectMcpServersHint}</div>
          </div>
        ) : (
          <div className="st-mcp-list">
            {servers.map((server, index) => {
              const result = testResult?.servers.find((item) => item.name === server.name);
              return (
                <div className="st-mcp-server" key={`${server.name}:${index}`}>
                  <div className="st-mcp-server-head">
                    <input
                      aria-label={copy.serverNameLabel(index + 1)}
                      value={server.name}
                      onChange={(event) => updateServer(index, { name: event.currentTarget.value })}
                      placeholder={copy.serverNamePlaceholder}
                    />
                    <span className="st-mcp-transport">STDIO</span>
                    <button
                      type="button"
                      className="st-mcp-remove"
                      onClick={() => setServers((current) => current.filter((_, candidate) => candidate !== index))}
                      title={copy.removeMcpServer}
                    >
                      {copy.remove}
                    </button>
                  </div>
                  <div className="st-mcp-fields">
                    <label>
                      <span>{copy.command}</span>
                      <input
                        value={server.command}
                        onChange={(event) => updateServer(index, { command: event.currentTarget.value })}
                        placeholder={copy.commandPlaceholder}
                      />
                    </label>
                    <label>
                      <span>{copy.timeoutSeconds}</span>
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
                      <span>{copy.argumentsOnePerLine}</span>
                      <textarea
                        value={server.args.join("\n")}
                        onChange={(event) => updateServer(index, {
                          args: event.currentTarget.value.split(/\r?\n/).filter(Boolean),
                        })}
                        placeholder={"mcp-server"}
                      />
                    </label>
                    <label>
                      <span>{copy.environmentKeyValue}</span>
                      <textarea
                        value={envText(server.env)}
                        onChange={(event) => updateServer(index, { env: parseEnv(event.currentTarget.value) })}
                        placeholder={copy.environmentPlaceholder}
                      />
                    </label>
                  </div>
                  {result && (
                    <div className={`st-mcp-result${result.ok ? " ok" : " failed"}`}>
                      <strong>{result.ok ? copy.connected : copy.failed}</strong>
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
            <div className="st-field-label">{copy.effectiveMcpConfiguration}</div>
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
            {testing ? copy.testingMcp : copy.testMcpServers}
          </button>
          <button type="button" className="st-save-btn" onClick={() => void save()} disabled={saving || testing}>
            {saving ? copy.saving : copy.saveMcpConfiguration}
          </button>
        </div>
      </div>
    </section>
  );
}
