// Unit tests for the shipped bridge extension.
//
// `desktop/src-tauri/resources/aris-code-bridge/extension.js` runs inside the
// workbench's Node extension host, so it is neither TypeScript nor part of the
// desktop bundle — but it is shipped code, and every branch here is one the
// user hits. It is loaded with a stubbed `vscode` module and a stubbed
// `WebSocket`, which is enough to drive activation, the editor events and the
// host commands without a workbench.

import Module from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EXTENSION_PATH = path.resolve(
  __dirname,
  "../../src-tauri/resources/aris-code-bridge/extension.js",
);

type Handler = (...args: unknown[]) => unknown;

interface Harness {
  extension: { activate: (context: unknown) => void; deactivate: () => void };
  sent: Array<Record<string, unknown>>;
  emit: (event: string, payload: string) => void;
  fire: (name: string, arg: unknown) => void;
  commands: Map<string, Handler>;
  status: { text: string; tooltip: string };
  statusItems: Map<string, { text: string; tooltip: string; command: string; visible: boolean }>;
  picks: Array<{ items: Array<Record<string, unknown>>; options: Record<string, unknown> }>;
  pickResponses: Array<Record<string, unknown> | undefined>;
  warningResponse: string | undefined;
  config: Map<string, unknown>;
  documents: unknown[];
  activeEditor: unknown;
  activeNotebook: unknown;
  executed: Array<{ id: string; arg: unknown }>;
  opened: unknown[];
  panels: Array<{ viewType: string; title: string; webview: { html: string } }>;
  socket: { readyState: number };
}

let harness: Harness;
let restoreLoad: (() => void) | null = null;

function makeVscodeStub(state: Harness) {
  const listeners = new Map<string, Handler[]>();
  const on = (name: string) => (handler: Handler) => {
    listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    return { dispose() {} };
  };
  state.fire = (name, arg) => {
    for (const handler of listeners.get(name) ?? []) handler(arg);
  };
  return {
    version: "1.126.0",
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1 },
    ViewColumn: { One: 1 },
    window: {
      createStatusBarItem: (id?: string | number) => {
        const key = typeof id === "string" ? id : "bridge";
        const item = { text: "", tooltip: "", command: "", visible: false };
        state.statusItems.set(key, item);
        return {
          show() { item.visible = true; },
          hide() { item.visible = false; },
          dispose() {},
          set text(value: string) {
            item.text = value;
            if (key === "bridge") state.status.text = value;
          },
          get text() {
            return item.text;
          },
          set tooltip(value: string) {
            item.tooltip = value;
            if (key === "bridge") state.status.tooltip = value;
          },
          get tooltip() {
            return item.tooltip;
          },
          set command(value: string) { item.command = value; },
          get command() { return item.command; },
        };
      },
      showQuickPick: async (items: Array<Record<string, unknown>>, options: Record<string, unknown>) => {
        state.picks.push({ items, options });
        return state.pickResponses.shift();
      },
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(async () => state.warningResponse),
      showTextDocument: async (uri: unknown) => {
        state.opened.push(uri);
      },
      createWebviewPanel: (viewType: string, title: string) => {
        const panel = { viewType, title, webview: { html: "" } };
        state.panels.push(panel);
        return panel;
      },
      get activeTextEditor() {
        return state.activeEditor;
      },
      get activeNotebookEditor() {
        return state.activeNotebook;
      },
      onDidChangeActiveTextEditor: on("activeEditor"),
      onDidChangeActiveNotebookEditor: on("activeNotebook"),
    },
    Uri: { file: (path: string) => ({ scheme: "file", fsPath: path }) },
    commands: {
      registerCommand: (id: string, handler: Handler) => {
        state.commands.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: async (id: string, arg: unknown) => {
        state.executed.push({ id, arg });
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { scheme: "file", fsPath: "D:/work" } }],
      get textDocuments() {
        return state.documents;
      },
      onDidOpenTextDocument: on("open"),
      onDidSaveTextDocument: on("save"),
      // Keys are stored fully qualified, and the section prefix is applied the
      // way the real API does. Flattening the section away would let the
      // extension read `workbench.x` through `getConfiguration("aris")` and
      // still pass, which is exactly the kind of mismatch these tests exist to
      // catch.
      getConfiguration: (section?: string) => {
        const qualify = (key: string) => (section ? `${section}.${key}` : key);
        return {
          get: (key: string) => state.config.get(qualify(key)),
          update: async (key: string, value: unknown) => {
            state.config.set(qualify(key), value);
          },
        };
      },
    },
  };
}

function loadExtension(): Harness {
  const state: Harness = {
    extension: null as never,
    sent: [],
    emit: () => {},
    fire: () => {},
    commands: new Map(),
    status: { text: "", tooltip: "" },
    statusItems: new Map(),
    picks: [],
    pickResponses: [],
    warningResponse: undefined,
    config: new Map(),
    documents: [],
    activeEditor: undefined,
    activeNotebook: undefined,
    executed: [],
    opened: [],
    panels: [],
    socket: { readyState: 1 },
  };

  const stub = makeVscodeStub(state);
  // The extension does `require("vscode")`, which only resolves inside a real
  // extension host; intercept the loader rather than reshaping the source.
  const loader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const original = loader._load;
  loader._load = (request, parent, isMain) =>
    request === "vscode" ? stub : original(request, parent, isMain);
  restoreLoad = () => {
    loader._load = original;
  };

  const wsListeners = new Map<string, Handler[]>();
  class FakeWebSocket {
    readyState = 1;
    constructor(public url: string) {
      state.socket = this;
    }
    addEventListener(name: string, handler: Handler) {
      wsListeners.set(name, [...(wsListeners.get(name) ?? []), handler]);
      if (name === "open") queueMicrotask(() => handler({}));
    }
    send(text: string) {
      state.sent.push(JSON.parse(text));
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  state.emit = (event, payload) => {
    for (const handler of wsListeners.get(event) ?? []) handler({ data: payload });
  };

  delete require.cache[require.resolve(EXTENSION_PATH)];
  state.extension = require(EXTENSION_PATH);
  return state;
}

beforeEach(() => {
  vi.stubEnv("ARIS_BRIDGE_URL", "ws://127.0.0.1:52999");
  vi.stubEnv("ARIS_BRIDGE_TOKEN", "s3cret");
  harness = loadExtension();
});

afterEach(() => {
  harness.extension.deactivate();
  restoreLoad?.();
  restoreLoad = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function activate() {
  harness.extension.activate({ subscriptions: [] });
}

function doc(fsPath: string, text: string, isDirty = false) {
  return {
    uri: { scheme: "file", fsPath },
    getText: () => text,
    isDirty,
    save: async () => true,
    languageId: "rust",
    lineAt: () => ({ range: { start: { line: 0 }, end: { line: 0 } } }),
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("aris-code-bridge", () => {
  const shell = {
    language: "cn",
    modules: [{ id: "lab", label: "代码" }, { id: "chat", label: "对话" }],
    projects: [{ id: "p1", name: "work", path: "D:/work" }, { id: "p2", name: "other", path: "D:/other" }],
    currentProjectId: "p1", projectBusy: false,
    account: { name: "Researcher", plan: "Pro", allowance: "$12.50", remainingPercent: 75 },
  };
  function connectShell(patch = {}) {
    harness.emit("message", JSON.stringify({ type: "welcome", protocol_version: 1 }));
    harness.emit("message", JSON.stringify({ type: "set-shell", revision: 7, shell: { ...shell, ...patch } }));
  }

  it("populates native shell controls before acknowledging the desktop header handoff", async () => {
    activate();
    connectShell();
    expect(harness.statusItems.get("somniq.modules")).toMatchObject({ visible: true, command: "aris.switchModule" });
    expect(harness.statusItems.get("somniq.projects")).toMatchObject({ visible: true, text: "$(folder-opened) work" });
    expect(harness.statusItems.get("somniq.account")?.tooltip).toContain("$12.50");
    expect(harness.sent.at(-1)).toEqual({ type: "shell-ready", revision: 7 });
    harness.emit("close", "");
    expect(harness.statusItems.get("somniq.modules")?.visible).toBe(false);
    harness.pickResponses.push({ id: "chat" });
    await harness.commands.get("aris.switchModule")!();
    expect(harness.sent.some((message) => message.type === "shell-action")).toBe(false);
  });

  it("uses native pickers and sends IDs back to the existing desktop navigation", async () => {
    activate();
    connectShell();
    harness.pickResponses.push({ id: "chat" });
    await harness.commands.get("aris.switchModule")!();
    expect(harness.picks[0]?.options.title).toBe("SomniQ 功能");
    expect(harness.sent.at(-1)).toEqual({ type: "shell-action", action: { kind: "select-module", id: "chat" } });
    harness.pickResponses.push({ action: { kind: "select-project", id: "p2" } });
    await harness.commands.get("aris.switchProject")!();
    expect(harness.picks[1]?.items[0]?.detail).toBe("D:/work");
    expect(harness.sent.at(-1)).toEqual({ type: "shell-action", action: { kind: "select-project", id: "p2" } });
    harness.pickResponses.push({ action: { kind: "settings" } });
    await harness.commands.get("aris.account")!();
    expect(harness.picks[2]?.items[1]).toMatchObject({ description: "$12.50", detail: "75%" });
    expect(harness.sent.at(-1)).toEqual({ type: "shell-action", action: { kind: "settings" } });
  });

  it("does not switch a project when the user cancels saving dirty editors", async () => {
    activate();
    connectShell();
    harness.documents = [doc("D:/work/main.rs", "unsaved", true)];
    harness.pickResponses.push({ action: { kind: "select-project", id: "p2" } });
    await harness.commands.get("aris.switchProject")!();
    expect(harness.sent.some((message) => message.type === "shell-action")).toBe(false);
  });

  it("requires every dirty editor to save successfully before switching", async () => {
    activate();
    connectShell();
    const dirty = doc("D:/work/main.rs", "unsaved", true);
    const save = vi.fn(async () => false);
    harness.documents = [{ ...dirty, save }];
    harness.warningResponse = "保存并切换";
    harness.pickResponses.push({ action: { kind: "select-project", id: "p2" } });
    await harness.commands.get("aris.switchProject")!();
    expect(save).toHaveBeenCalled();
    expect(harness.sent.some((message) => message.type === "shell-action")).toBe(false);
    save.mockResolvedValue(true);
    harness.pickResponses.push({ action: { kind: "select-project", id: "p2" } });
    await harness.commands.get("aris.switchProject")!();
    expect(harness.sent.at(-1)).toEqual({ type: "shell-action", action: { kind: "select-project", id: "p2" } });
  });

  it("ignores cancelled pickers and blocks project actions while the host is busy", async () => {
    activate();
    connectShell();
    await harness.commands.get("aris.switchModule")!();
    await harness.commands.get("aris.switchProject")!();
    await harness.commands.get("aris.account")!();
    expect(harness.sent.some((message) => message.type === "shell-action")).toBe(false);
    connectShell({ projectBusy: true });
    await harness.commands.get("aris.switchProject")!();
    expect(harness.picks).toHaveLength(3);
  });
  it("opens with a handshake carrying the token from the environment", async () => {
    activate();
    await flush();

    expect(harness.sent[0]).toMatchObject({
      type: "hello",
      token: "s3cret",
      protocol_version: 1,
    });
  });

  /// Without the address and token there is nothing to connect to, and the
  /// editor must still work — just without the Aris integration.
  it("stays quiet when the bridge is not configured", async () => {
    harness.extension.deactivate();
    restoreLoad?.();
    vi.stubEnv("ARIS_BRIDGE_URL", "");
    vi.stubEnv("ARIS_BRIDGE_TOKEN", "");
    harness = loadExtension();
    activate();
    await flush();

    expect(harness.sent).toHaveLength(0);
    expect(harness.status.text).toContain("Aris");
  });

  it("reports a save as a diff against the content it had cached", async () => {
    activate();
    await flush();
    const file = "D:/work/main.rs";
    harness.fire("open", doc(file, "before"));
    // The open handler reads from disk; there is no such file, so seed the
    // baseline the way a real edit would leave it.
    harness.sent.length = 0;
    harness.fire("save", doc(file, "after"));

    const saved = harness.sent.find((message) => message.type === "document-saved");
    expect(saved).toBeTruthy();
    expect(saved).toMatchObject({ path: file, after: "after" });
  });

  it("ignores documents that are not files on disk", async () => {
    activate();
    await flush();
    harness.sent.length = 0;
    harness.fire("save", {
      uri: { scheme: "untitled", fsPath: "Untitled-1" },
      getText: () => "x",
    });

    expect(harness.sent.filter((m) => m.type === "document-saved")).toHaveLength(0);
  });

  /// Aris just wrote these files, so the cached baseline is pre-AI. Keeping it
  /// would make the user's next save look like it also undid the AI's edit.
  it("refreshes cached baselines when the host says Aris wrote a file", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aris-code-bridge-"));
    const file = path.join(root, "main.rs");
    writeFileSync(file, "v1", "utf8");
    try {
      activate();
      await flush();
      harness.fire("open", doc(file, "v1"));

      writeFileSync(file, "v2", "utf8");
      harness.emit("message", JSON.stringify({ type: "reload-from-disk", paths: [file] }));
      harness.sent.length = 0;
      harness.fire("save", doc(file, "v3"));

      const saved = harness.sent.find((m) => m.type === "document-saved");
      expect(saved).toMatchObject({ before: "v2", after: "v3" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flushes dirty editors on request and reports what it wrote", async () => {
    activate();
    await flush();
    harness.documents = [
      doc("D:/work/a.rs", "a", true),
      doc("D:/work/b.rs", "b", false),
    ];
    harness.sent.length = 0;

    harness.emit("message", JSON.stringify({ type: "save-all" }));
    await flush();

    const done = harness.sent.find((m) => m.type === "save-all-done");
    expect(done).toMatchObject({ saved: ["D:/work/a.rs"], failed: [] });
  });

  /// The workbench keeps settings in browser storage, so this is the only way
  /// the app's theme can reach it.
  it("applies the theme the host pushes", async () => {
    activate();
    await flush();

    harness.emit("message", JSON.stringify({ type: "set-theme", dark: true }));
    await flush();
    expect(harness.config.get("workbench.colorTheme")).toBe("Dark Modern");

    harness.emit("message", JSON.stringify({ type: "set-theme", dark: false }));
    await flush();
    expect(harness.config.get("workbench.colorTheme")).toBe("Light Modern");
  });

  it("repaints the workbench chrome with the palette the host sends", async () => {
    activate();
    await flush();

    const colors = { "editor.background": "#0e1116", "sideBar.background": "#151a21" };
    harness.emit("message", JSON.stringify({ type: "set-theme", dark: true, colors }));
    await flush();

    expect(harness.config.get("workbench.colorCustomizations")).toEqual(colors);
  });

  /// An app that cannot resolve its own tokens sends nothing. Writing `{}` in
  /// that case would strip a palette the user is already looking at.
  it("leaves existing colours alone when the palette is empty", async () => {
    activate();
    await flush();
    harness.config.set("workbench.colorCustomizations", { "editor.background": "#111111" });

    harness.emit("message", JSON.stringify({ type: "set-theme", dark: true, colors: {} }));
    await flush();

    expect(harness.config.get("workbench.colorCustomizations")).toEqual({
      "editor.background": "#111111",
    });
  });

  /// `update()` rewrites the profile and fans out a configuration-change event,
  /// and the host pushes on every reconnect.
  it("does not rewrite settings that already hold the wanted value", async () => {
    activate();
    await flush();
    const colors = { "editor.background": "#0e1116" };
    harness.emit("message", JSON.stringify({ type: "set-theme", dark: true, colors }));
    await flush();

    let writes = 0;
    const original = harness.config.set.bind(harness.config);
    harness.config.set = ((key: string, value: unknown) => {
      writes += 1;
      return original(key, value);
    }) as typeof harness.config.set;

    harness.emit("message", JSON.stringify({ type: "set-theme", dark: true, colors }));
    await flush();

    expect(writes).toBe(0);
  });

  /// The stock welcome page is suppressed in the runtime itself (see PATCHES
  /// in codeserver.rs), so nothing else opens and this panel is what the user
  /// lands on for a profile's first launch.
  it("opens its own welcome panel on a fresh profile", async () => {
    activate();
    await flush();

    expect(harness.panels).toHaveLength(1);
    expect(harness.panels[0]).toMatchObject({ viewType: "aris.welcome", title: "Welcome" });
    expect(harness.panels[0]!.webview.html).toContain("SomniQ Code");
  });

  /// It is styled with the workbench's own variables so that it follows both
  /// the base theme and the palette pushed over the bridge. Hard-coded colours
  /// would be a third copy of the palette, and wrong in one theme or the other.
  it("styles the panel from workbench theme variables rather than fixed colours", async () => {
    activate();
    await flush();
    const html = harness.panels[0]!.webview.html;

    expect(html).toContain("var(--vscode-foreground)");
    expect(html).toContain("var(--vscode-font-family)");
    expect(html).not.toMatch(/(?:color|background)\s*:\s*#[0-9a-f]{3,8}/i);
  });

  it("does not reopen the panel on later launches", async () => {
    activate();
    await flush();
    harness.panels.length = 0;

    activate();
    await flush();

    expect(harness.panels).toHaveLength(0);
  });

  /// Extension state is kept server-side while the web workbench keeps settings
  /// in browser storage keyed by origin. Clearing browser data — or a port
  /// collision moving the origin — resets the profile; if the "already shown"
  /// flag lived anywhere else it would survive, and a user who had never
  /// actually seen the welcome would never be shown it.
  it("shows the welcome again after the profile is reset", async () => {
    activate();
    await flush();
    expect(harness.config.get("aris.welcomeAdopted")).toBe(true);

    harness.config.delete("aris.welcomeAdopted");
    harness.panels.length = 0;
    activate();
    await flush();

    expect(harness.panels).toHaveLength(1);
  });

  it("shows the connection state in the status bar", async () => {
    activate();
    await flush();
    harness.emit("message", JSON.stringify({ type: "welcome", protocol_version: 1 }));

    expect(harness.status.text).toContain("Aris");
    expect(harness.status.tooltip).toMatch(/connected/i);
  });

  it("sends the selection with 1-based lines, matching the gutter", async () => {
    activate();
    await flush();
    harness.activeEditor = {
      document: {
        uri: { scheme: "file", fsPath: "D:/work/main.rs" },
        getText: () => "let x = 1;",
        languageId: "rust",
        lineAt: () => ({ range: {} }),
      },
      selection: { isEmpty: false, start: { line: 3 }, end: { line: 5 }, active: { line: 3 } },
    };
    harness.sent.length = 0;

    harness.commands.get("aris.askAris")?.();

    expect(harness.sent[0]).toMatchObject({
      type: "ask-aris",
      path: "D:/work/main.rs",
      start_line: 4,
      end_line: 6,
      language_id: "rust",
    });
  });

  it("does not send anything when there is no editor", async () => {
    activate();
    await flush();
    harness.activeEditor = undefined;
    harness.sent.length = 0;

    harness.commands.get("aris.askAris")?.();

    expect(harness.sent).toHaveLength(0);
  });

  /// The host missed every editor change from before the socket opened, so a
  /// panel that acts on "the file you have open" would start out blind.
  it("states the active editor as soon as the host welcomes it", async () => {
    activate();
    await flush();
    harness.activeEditor = { document: { uri: { scheme: "file", fsPath: "D:/work/a.rs" } } };
    harness.sent.length = 0;

    harness.emit("message", JSON.stringify({ type: "welcome", protocol_version: 1 }));

    expect(harness.sent[0]).toMatchObject({
      type: "active-editor-changed",
      path: "D:/work/a.rs",
      is_notebook: false,
    });
  });

  it("prefers an open notebook over a text editor", async () => {
    activate();
    await flush();
    harness.activeNotebook = { notebook: { uri: { scheme: "file", fsPath: "D:/work/train.ipynb" } } };
    harness.activeEditor = { document: { uri: { scheme: "file", fsPath: "D:/work/a.rs" } } };
    harness.sent.length = 0;

    harness.fire("activeNotebook", undefined);

    expect(harness.sent[0]).toMatchObject({
      type: "active-editor-changed",
      path: "D:/work/train.ipynb",
      is_notebook: true,
    });
  });

  it("reports no path when nothing file-backed is focused", async () => {
    activate();
    await flush();
    harness.activeEditor = { document: { uri: { scheme: "untitled", fsPath: "Untitled-1" } } };
    harness.sent.length = 0;

    harness.fire("activeEditor", undefined);

    expect(harness.sent[0]).toMatchObject({ type: "active-editor-changed", path: null });
  });

  /// Clicking a path in chat has to land somewhere. The workbench owns its own
  /// tabs, so this is the only route.
  it("opens a plain file the host asked for", async () => {
    activate();
    await flush();

    harness.emit("message", JSON.stringify({ type: "open-file", path: "D:/work/main.rs" }));
    await flush();

    expect(harness.opened).toEqual([{ scheme: "file", fsPath: "D:/work/main.rs" }]);
  });

  it("resolves a workspace-relative file before opening it", async () => {
    activate();
    await flush();

    harness.emit(
      "message",
      JSON.stringify({ type: "open-file", path: "scripts/cpu_burn.py" }),
    );
    await flush();

    expect(harness.opened).toEqual([
      { scheme: "file", fsPath: path.resolve("D:/work", "scripts/cpu_burn.py") },
    ]);
  });

  /// `showTextDocument` would open a notebook as raw JSON; `vscode.open` hands
  /// it to the notebook editor.
  it("routes a notebook through the notebook editor rather than the text editor", async () => {
    activate();
    await flush();

    harness.emit("message", JSON.stringify({ type: "open-file", path: "D:/work/train.ipynb" }));
    await flush();

    expect(harness.opened).toHaveLength(0);
    expect(harness.executed).toContainEqual({
      id: "vscode.open",
      arg: { scheme: "file", fsPath: "D:/work/train.ipynb" },
    });
  });

  it("truncates on a character boundary so the host never sees broken UTF-8", () => {
    const { truncateUtf8 } = harness.extension as unknown as {
      truncateUtf8: (text: string, max: number) => string;
    };
    expect(truncateUtf8("hello", 32)).toBe("hello");
    // Three bytes per character, so a 4-byte budget lands mid-character.
    expect(truncateUtf8("中文字", 4)).toBe("中");
    expect(Buffer.from(truncateUtf8("中文字", 7), "utf8").length).toBeLessThanOrEqual(7);
  });
});
