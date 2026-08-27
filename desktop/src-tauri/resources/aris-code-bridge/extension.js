"use strict";

/**
 * Aris bridge for the embedded VS Code workbench.
 *
 * Deliberately plain CommonJS with no dependencies and no build step:
 *
 * - The extension host runs the Node the workbench ships (v24), which has a
 *   global `WebSocket`, so there is nothing to bundle for the socket.
 * - A folder dropped into `--extensions-dir` is loaded as-is, so there is no
 *   `.vsix` to package either.
 *
 * Both were measured against the shipped runtime rather than assumed. Keeping
 * it that way means this file stays reviewable and the desktop build gains no
 * second toolchain.
 */

const vscode = require("vscode");
const fs = require("fs");

/** Must match `CODE_BRIDGE_PROTOCOL_VERSION` in `crates/remote-protocol`. */
const PROTOCOL_VERSION = 1;

/** Must match `CODE_BRIDGE_MAX_SELECTION_BYTES`. The host truncates too; doing
 * it here as well keeps a huge selection off the socket in the first place. */
const MAX_SELECTION_BYTES = 32 * 1024;

/** Matches `publisher.name` in package.json; the walkthrough id is scoped by it. */
const ARIS_EXTENSION_ID = "aris.aris-code-bridge";

/** Backoff bounds for reconnecting to the desktop. */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15000;

let socket = null;
let statusItem = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let disposed = false;

/**
 * Last known on-disk content per file, so a save can be reported as a diff.
 *
 * Populated when a document opens and refreshed after every save. Without it
 * the host has no baseline and — by design — records nothing rather than
 * claiming the user authored the whole file.
 */
const baselines = new Map();

function setStatus(text, tooltip) {
  if (!statusItem) return;
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.show();
}

function send(message) {
  if (socket && socket.readyState === 1 /* OPEN */) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/** Cut to a byte budget without splitting a UTF-8 sequence. */
function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Walk back off a continuation byte (0b10xxxxxx).
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function readBaseline(uri) {
  try {
    return fs.readFileSync(uri.fsPath, "utf8");
  } catch {
    // A new file that is not on disk yet has no baseline, which is a fact the
    // host handles rather than something to paper over.
    return undefined;
  }
}

function connect() {
  const url = process.env.ARIS_BRIDGE_URL;
  const token = process.env.ARIS_BRIDGE_TOKEN;
  if (!url || !token) {
    setStatus("$(circle-slash) Aris", "Aris bridge is not configured for this window.");
    return;
  }

  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;
  setStatus("$(sync~spin) Aris", "Connecting to Aris…");

  ws.addEventListener("open", () => {
    reconnectDelay = RECONNECT_MIN_MS;
    send({
      type: "hello",
      token,
      protocol_version: PROTOCOL_VERSION,
      vscode_version: vscode.version,
    });
  });

  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : "");
    } catch {
      return;
    }
    handleHostMessage(message);
  });

  ws.addEventListener("close", () => {
    socket = null;
    setStatus("$(debug-disconnect) Aris", "Disconnected from Aris.");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // `close` always follows, which is where the retry lives.
  });
}

function scheduleReconnect() {
  if (disposed || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function handleHostMessage(message) {
  if (!message || typeof message.type !== "string") return;
  switch (message.type) {
    case "welcome":
      setStatus("$(check) Aris", "Connected to Aris.");
      // The host missed every editor change that happened before the socket
      // opened, so state the current one rather than waiting for the next.
      reportActiveEditor();
      break;
    case "save-all":
      void saveAll();
      break;
    case "reload-from-disk":
      // Aris just wrote these files. Drop the stale baselines so the next save
      // diffs against what is on disk rather than the pre-AI copy.
      for (const path of message.paths || []) baselines.delete(path);
      break;
    case "set-theme":
      void applyTheme(Boolean(message.dark), message.colors || {});
      break;
    case "open-file":
      void openFile(String(message.path || ""));
      break;
    case "status":
      setStatus(message.text || "Aris", message.tooltip || "");
      break;
    default:
      break;
  }
}

async function saveAll() {
  const saved = [];
  const failed = [];
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty) continue;
    try {
      if (await document.save()) {
        saved.push(document.uri.fsPath);
      } else {
        failed.push(document.uri.fsPath);
      }
    } catch (error) {
      failed.push(`${document.uri.fsPath}: ${error}`);
    }
  }
  send({ type: "save-all-done", saved, failed });
}

/** True when two flat string maps hold the same entries. */
function sameColors(a, b) {
  if (!a || typeof a !== "object") return Object.keys(b).length === 0;
  const left = Object.keys(a);
  if (left.length !== Object.keys(b).length) return false;
  return left.every((key) => a[key] === b[key]);
}

/**
 * Follow the app's appearance.
 *
 * This runs inside the extension host on purpose: the web workbench keeps user
 * settings in browser storage, so nothing the desktop writes to disk is ever
 * read. The configuration API is the only door in.
 *
 * `Global` scope means it behaves like the user picking a theme, so their own
 * later choice sticks — the desktop pushes a default, it does not enforce one.
 *
 * The base theme carries the syntax palette (SomniQ's code tokens are Dark+ /
 * Light+ already); `colorCustomizations` repaints the surrounding chrome so the
 * iframe stops looking like a different application bolted into the window.
 * Both writes are skipped when the value is already what we want — an update()
 * always rewrites the profile and triggers a configuration-change cascade.
 */
async function applyTheme(dark, colors) {
  const config = vscode.workspace.getConfiguration("workbench");
  const wanted = dark ? "Dark Modern" : "Light Modern";
  try {
    if (config.get("colorTheme") !== wanted) {
      await config.update("colorTheme", wanted, vscode.ConfigurationTarget.Global);
    }
  } catch {
    // A read-only profile is not worth surfacing; the editor still works.
  }
  // An empty map means the app could not resolve its palette. Leave whatever
  // is there rather than stripping the workbench back to the stock theme.
  if (!colors || Object.keys(colors).length === 0) return;
  try {
    if (!sameColors(config.get("colorCustomizations"), colors)) {
      await config.update("colorCustomizations", colors, vscode.ConfigurationTarget.Global);
    }
  } catch {
    // Same reasoning as above.
  }
}

/**
 * Open a path the app asked for.
 *
 * Notebooks go through the generic `vscode.open` command rather than
 * `showTextDocument`, which would open a `.ipynb` as raw JSON instead of
 * handing it to the notebook editor.
 */
async function openFile(path) {
  if (!path) return;
  const uri = vscode.Uri.file(path);
  try {
    if (path.toLowerCase().endsWith(".ipynb")) {
      await vscode.commands.executeCommand("vscode.open", uri);
    } else {
      await vscode.window.showTextDocument(uri, { preview: false });
    }
  } catch (error) {
    void vscode.window.showWarningMessage(`Aris could not open ${path}: ${error}`);
  }
}

function askAris() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("Open a file first.");
    return;
  }
  const selection = editor.selection;
  const range = selection.isEmpty
    ? editor.document.lineAt(selection.active.line).range
    : selection;
  const text = editor.document.getText(range);
  if (!text.trim()) {
    void vscode.window.showInformationMessage("Nothing selected.");
    return;
  }
  const delivered = send({
    type: "ask-aris",
    path: editor.document.uri.fsPath,
    // The protocol is 1-based to match what the gutter shows; the API is not.
    start_line: range.start.line + 1,
    end_line: range.end.line + 1,
    text: truncateUtf8(text, MAX_SELECTION_BYTES),
    language_id: editor.document.languageId,
  });
  if (!delivered) {
    void vscode.window.showWarningMessage("Not connected to Aris.");
  }
}

/**
 * Tell the host what the user is looking at.
 *
 * App-side panels outside the workbench — submitting the open notebook to a
 * compute node, for one — have no other way to know.
 */
function reportActiveEditor() {
  const notebook = vscode.window.activeNotebookEditor;
  if (notebook && notebook.notebook.uri.scheme === "file") {
    send({ type: "active-editor-changed", path: notebook.notebook.uri.fsPath, is_notebook: true });
    return;
  }
  const editor = vscode.window.activeTextEditor;
  const uri = editor && editor.document.uri;
  send({
    type: "active-editor-changed",
    path: uri && uri.scheme === "file" ? uri.fsPath : null,
    is_notebook: false,
  });
}

function activate(context) {
  disposed = false;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = "aris.askAris";
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("aris.askAris", askAris),

    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme !== "file") return;
      baselines.set(document.uri.fsPath, readBaseline(document.uri));
    }),

    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") return;
      const path = document.uri.fsPath;
      const after = document.getText();
      send({ type: "document-saved", path, before: baselines.get(path) ?? null, after });
      baselines.set(path, after);
    }),

    vscode.window.onDidChangeActiveTextEditor(reportActiveEditor),
    vscode.window.onDidChangeActiveNotebookEditor(reportActiveEditor),
  );

  // Files already open when the extension activates never fire `onDidOpen`.
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme === "file") {
      baselines.set(document.uri.fsPath, readBaseline(document.uri));
    }
  }

  void adoptWelcomePage();
  connect();
}

/**
 * Show SomniQ's own welcome the first time a profile is used.
 *
 * Two layers are needed, because the editor's stock welcome page advertises
 * VSCodium — its walkthroughs, its announcements feed, its release notes —
 * which is the wrong product for someone who opened the Code tab of SomniQ:
 *
 * 1. The page is stopped from opening at all by patching the
 *    `workbench.startupEditor` default in the installed runtime (see `PATCHES`
 *    in `codeserver.rs`). Setting it from here loses a race — the page is
 *    already open by the time an `onStartupFinished` extension runs, and the
 *    workbench's restore pass paints it back over anything opened in its place.
 * 2. This panel takes its slot. A webview rather than the walkthrough this
 *    extension also contributes, because `workbench.action.openWalkthrough`
 *    was measured against the real workbench and does not reliably bring its
 *    own walkthrough to the front: the getting-started editor opens showing the
 *    category list, with the requested walkthrough rendered but not selected.
 *    The walkthrough contribution is still worth having for the editor's own
 *    Welcome page; it is just not something to land a first run on.
 *
 * The "already shown" flag is a *setting*, deliberately not `globalState`. The
 * two live in different stores — extension state is kept server-side, while the
 * web workbench keeps settings in browser storage keyed by origin — so a
 * cleared profile, or a port collision that moves the origin, would forget the
 * welcome while the flag stayed set. Keeping both in the profile means they
 * reset together.
 */
async function adoptWelcomePage() {
  const config = vscode.workspace.getConfiguration();
  if (config.get("aris.welcomeAdopted")) return;
  try {
    await config.update("aris.welcomeAdopted", true, vscode.ConfigurationTarget.Global);
    showWelcomePanel();
  } catch {
    // Starting on an empty editor is a cosmetic loss, not a reason to fail
    // activation and take the bridge down with it.
  }
}

/**
 * SomniQ's welcome panel.
 *
 * Styled entirely with the workbench's own CSS variables, so it follows both
 * the base theme and the palette the desktop pushes over the bridge without
 * knowing either.
 */
function showWelcomePanel() {
  const panel = vscode.window.createWebviewPanel(
    "aris.welcome",
    "Welcome",
    { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
    { enableCommandUris: true, enableScripts: false, retainContextWhenHidden: false },
  );
  panel.webview.html = WELCOME_HTML;
}

const WELCOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body {
    margin: 0;
    padding: 56px 48px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    line-height: 1.6;
  }
  .wrap { max-width: 720px; }
  h1 { margin: 0; font-size: 34px; font-weight: 600; letter-spacing: -0.4px; }
  .tagline { margin: 6px 0 40px; color: var(--vscode-descriptionForeground); font-size: 15px; }
  section { margin-bottom: 28px; }
  h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
  p { margin: 0; color: var(--vscode-descriptionForeground); }
  kbd {
    padding: 1px 6px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 3px;
    background: var(--vscode-keybindingLabel-background, transparent);
    color: var(--vscode-keybindingLabel-foreground, inherit);
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }
  .links { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 36px; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .note {
    margin-top: 36px;
    padding-top: 20px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    color: var(--vscode-descriptionForeground);
    font-size: 13px;
  }
</style>
</head>
<body>
  <div class="wrap">
    <h1>SomniQ Code</h1>
    <p class="tagline">A full editor, sharing one project with the rest of SomniQ.</p>

    <section>
      <h2>One project, two surfaces</h2>
      <p>This is the project you picked in SomniQ. Files the assistant writes show up
      here as they land, and files you save here go into the same change history.</p>
    </section>

    <section>
      <h2>Ask about a selection</h2>
      <p>Select code and press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd>. The snippet goes
      into the chat composer with its file and line range — nothing is sent until you add
      the question yourself.</p>
    </section>

    <section>
      <h2>Notebooks run here</h2>
      <p>Python and Jupyter are already installed. Cells you run use this editor's kernel,
      which is separate from the assistant's — if you ask it to carry on from state you
      created by hand, tell it to re-run the cells that produce it.</p>
    </section>

    <section>
      <h2>Install what you are missing</h2>
      <p>Extensions come from Open VSX. Language servers, linters, formatters and keymaps
      are nearly all there; a few Microsoft-licensed ones (Pylance, C/C++, C#) are not.</p>
    </section>

    <div class="links">
      <a href="command:workbench.view.explorer">Open the explorer</a>
      <a href="command:workbench.view.extensions">Browse extensions</a>
      <a href="command:workbench.action.terminal.new">New terminal</a>
      <a href="command:workbench.action.showCommands">Show all commands</a>
    </div>

    <p class="note">The terminal and any extension you install run as you, with your
    permissions. They are not limited by the permission level set for chat.</p>
  </div>
</body>
</html>`;

function deactivate() {
  disposed = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (socket) socket.close();
}

module.exports = { activate, deactivate, truncateUtf8 };
