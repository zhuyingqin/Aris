import { useMemo, useState } from "react";
import { cliRun, isTauri } from "../api/tauri";
import { useStore, type Tab } from "../store";
import type { CliRunOutput } from "../types";
import { parseCliArgs } from "./args";

type Preset =
  | {
      kind: "command";
      label: string;
      args: string[];
      note: string;
      timeoutMs?: number;
    }
  | {
      kind: "native";
      label: string;
      tab: Tab;
      note: string;
      command: string;
    };

const GROUPS: { title: string; items: Preset[] }[] = [
  {
    title: "Core",
    items: [
      { kind: "command", label: "Version", args: ["--version"], note: "local build metadata" },
      { kind: "command", label: "Help", args: ["--help"], note: "full CLI help" },
      { kind: "command", label: "Doctor", args: ["doctor"], note: "runtime health check" },
      { kind: "command", label: "Init", args: ["init"], note: "initialize desktop workspace" },
    ],
  },
  {
    title: "Prompt",
    items: [
      {
        kind: "command",
        label: "Prompt text",
        args: ["--print", "prompt", "Summarize this workspace."],
        note: "one-shot assistant run",
      },
      {
        kind: "command",
        label: "Prompt JSON",
        args: ["--output-format", "json", "prompt", "Summarize this workspace."],
        note: "machine-readable output",
      },
      {
        kind: "native",
        label: "Interactive chat",
        tab: "chat",
        note: "desktop REPL surface",
        command: "aris",
      },
    ],
  },
  {
    title: "Sessions",
    items: [
      {
        kind: "command",
        label: "Resume status",
        args: ["--resume", "SESSION.json", "/status"],
        note: "edit session path before run",
      },
      {
        kind: "command",
        label: "Resume diff",
        args: ["--resume", "SESSION.json", "/diff"],
        note: "resume-safe slash command",
      },
      {
        kind: "native",
        label: "Session browser",
        tab: "sessions",
        note: "read saved transcripts",
        command: "aris /resume",
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        kind: "command",
        label: "System prompt",
        args: ["system-prompt"],
        note: "effective runtime prompt",
      },
      {
        kind: "command",
        label: "Manifests",
        args: ["dump-manifests"],
        note: "tool and skill manifests",
      },
      {
        kind: "command",
        label: "Bootstrap plan",
        args: ["bootstrap-plan"],
        note: "startup plan scaffold",
      },
    ],
  },
  {
    title: "Account",
    items: [
      {
        kind: "native",
        label: "Setup",
        tab: "settings",
        note: "model, URL and key settings",
        command: "aris setup",
      },
      {
        kind: "command",
        label: "Login",
        args: ["login"],
        note: "Claude OAuth login",
        timeoutMs: 300_000,
      },
      { kind: "command", label: "Logout", args: ["logout"], note: "clear saved OAuth credentials" },
    ],
  },
  {
    title: "Native",
    items: [
      {
        kind: "native",
        label: "Workflow",
        tab: "studio",
        note: "plan and launch workflows",
        command: "/workflows",
      },
      {
        kind: "native",
        label: "Run monitor",
        tab: "monitor",
        note: "pause, resume and inspect runs",
        command: "/status",
      },
      {
        kind: "native",
        label: "Team",
        tab: "teams",
        note: "agents, tasks and mailbox",
        command: "/team",
      },
      {
        kind: "native",
        label: "Skills",
        tab: "skills",
        note: "browse bundled skills",
        command: "/skills",
      },
    ],
  },
];

const TIMEOUTS = [
  { label: "30s", value: 30_000 },
  { label: "2m", value: 120_000 },
  { label: "5m", value: 300_000 },
  { label: "10m", value: 600_000 },
];

export default function Cli() {
  const setError = useStore((s) => s.setError);
  const setTab = useStore((s) => s.setTab);
  const [input, setInput] = useState("--version");
  const [timeoutMs, setTimeoutMs] = useState(120_000);
  const [result, setResult] = useState<CliRunOutput | null>(null);
  const [running, setRunning] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const output = useMemo(() => {
    if (!result) return "";
    const parts = [];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    return parts.join("\n\n") || "(no output)";
  }, [result]);

  const choose = (preset: Preset) => {
    setLocalError(null);
    if (preset.kind === "native") {
      setTab(preset.tab);
      return;
    }
    setInput(formatArgs(preset.args));
    if (preset.timeoutMs) setTimeoutMs(preset.timeoutMs);
  };

  const run = async () => {
    setLocalError(null);
    setResult(null);
    let args: string[];
    try {
      args = parseCliArgs(input);
    } catch (err) {
      setLocalError(String(err));
      return;
    }
    if (args.length === 0) {
      setLocalError("Empty command would start the interactive REPL.");
      return;
    }
    if (!isTauri()) {
      setLocalError("CLI commands need the Tauri backend.");
      return;
    }

    setRunning(true);
    try {
      const out = await cliRun({ args, timeoutMs });
      setResult(out);
    } catch (err) {
      const message = String(err);
      setLocalError(message);
      setError(message);
    } finally {
      setRunning(false);
    }
  };

  const copyOutput = async () => {
    if (!output) return;
    await navigator.clipboard?.writeText(output);
  };

  return (
    <div className="cli-page">
      <aside className="cli-catalog">
        {GROUPS.map((group) => (
          <section className="cli-command-group" key={group.title}>
            <div className="panel-title">{group.title}</div>
            <div className="cli-command-list">
              {group.items.map((preset) => (
                <button
                  key={`${group.title}:${preset.label}`}
                  type="button"
                  className={`cli-command-card cli-${preset.kind}`}
                  onClick={() => choose(preset)}
                >
                  <span className="cli-command-card-head">
                    <span>{preset.label}</span>
                    <span className="cli-command-kind">
                      {preset.kind === "native" ? "UI" : "CLI"}
                    </span>
                  </span>
                  <span className="cli-command-note">{preset.note}</span>
                  <code>
                    {preset.kind === "native"
                      ? preset.command
                      : `aris ${formatArgs(preset.args)}`}
                  </code>
                </button>
              ))}
            </div>
          </section>
        ))}
      </aside>

      <section className="cli-console">
        <div className="cli-runbar">
          <span className="cli-prefix">aris</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void run();
            }}
          />
          <select
            value={timeoutMs}
            onChange={(event) => setTimeoutMs(Number(event.target.value))}
            aria-label="Timeout"
          >
            {TIMEOUTS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <button className="primary" type="button" disabled={running} onClick={run}>
            {running ? "Running" : "Run"}
          </button>
        </div>

        <div className="cli-status-row">
          {result ? (
            <>
              <span className={`badge ${result.success ? "st-completed" : "st-failed"}`}>
                {result.timedOut ? "timeout" : result.success ? "ok" : "failed"}
              </span>
              <code>{result.command}</code>
              <span>{result.elapsedMs}ms</span>
              <span>exit {result.code ?? "signal"}</span>
            </>
          ) : (
            <span className="cli-muted">Ready</span>
          )}
        </div>

        {(localError || result) && (
          <div className="cli-meta">
            {localError && <div className="err">{localError}</div>}
            {result && (
              <>
                <div>
                  <span>Executable</span>
                  <code>{result.executable}</code>
                </div>
                <div>
                  <span>Workspace</span>
                  <code>{result.cwd}</code>
                </div>
              </>
            )}
          </div>
        )}

        <div className="cli-output-head">
          <div className="panel-title">Output</div>
          <div className="cli-output-actions">
            <button type="button" onClick={() => setResult(null)} disabled={!result && !localError}>
              Clear
            </button>
            <button type="button" onClick={copyOutput} disabled={!result}>
              Copy
            </button>
          </div>
        </div>
        <pre className="cli-output">{result ? output : "No command output yet."}</pre>
      </section>
    </div>
  );
}

function formatArgs(args: string[]) {
  return args.map(formatArg).join(" ");
}

function formatArg(arg: string) {
  if (/^[^\s"']+$/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
