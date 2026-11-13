// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/plugins";
import PluginPage from "./PluginPage";
import { pluginPageDocument } from "./pluginPageDocument";

vi.mock("../api/plugins", async (original) => ({
  ...(await original<typeof import("../api/plugins")>()), pluginsUiPage: vi.fn(), pluginsUiStateGet: vi.fn(), pluginsUiStateUpdate: vi.fn(),
}));
vi.mock("../api/tauri", () => ({ openExternalUrl: vi.fn() }));
vi.mock("../chat/MarkdownContent", () => ({ default: ({ text }: { text: string }) => <div>{text}</div> }));

const panel: api.ActiveUiPanel = {
  pluginName: "@local/focus-board", packageDigest: "d1", id: "focus-board", slot: "nav.page", order: 0, scope: "project", icon: "collection",
  title: { en: "Focus board", cn: "专注看板" }, page: "./page.html",
  widgets: [{ id: "cards", type: "json", title: "Cards" }, { id: "todos", type: "todo-list", title: "Todos" }],
};
const theme = { mode: "dark" as const, colors: { bg: "#111" }, font: "Inter" };
const stateOf = (revision: number, cards: unknown): api.UiPanelState => ({ revision, todoLists: { todos: [{ id: "t1", text: "Read", completed: false }] }, notes: {}, data: { cards } });

/** The page document inside the shell's one frame. */
const file = (html: string, assets: api.UiPageFile["assets"] = {}, path = "page.html") => ({ html, path, assets });
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const inner = (shell: string) => new DOMParser().parseFromString(shell, "text/html").querySelector("iframe")!.getAttribute("srcdoc")!;

describe("pluginPageDocument", () => {
  it("wraps the page in a script-less shell that forbids every frame load", () => {
    const shell = pluginPageDocument(file("<h1>Board</h1>"), "chan", { language: "en", theme, data: {} });
    const outer = new DOMParser().parseFromString(shell, "text/html");
    expect(outer.querySelector("meta[http-equiv]")!.getAttribute("content")).toBe("frame-src 'none'");
    expect(outer.querySelectorAll("script")).toHaveLength(0);
    const frame = outer.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    const page = new DOMParser().parseFromString(frame.getAttribute("srcdoc")!, "text/html");
    const csp = page.querySelector("meta[http-equiv]")!.getAttribute("content")!;
    for (const rule of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'"]) expect(csp).toContain(rule);
    expect(csp).not.toMatch(/https?:|\*/);
    // The host's policy and bootstrap come before anything the package wrote.
    const source = frame.getAttribute("srcdoc")!;
    expect(source.indexOf("Content-Security-Policy")).toBeLessThan(source.indexOf("\"somniq\""));
    expect(source.indexOf("\"somniq\"")).toBeLessThan(source.indexOf("<h1>Board</h1>"));
    expect(page.querySelector("h1")!.textContent).toBe("Board");
  });

  it("keeps data and markup from breaking out of where they are put", () => {
    const hostile = "</script><script>window.escaped = 1</script>\u2028";
    const html = `<p title="a &amp; b" data-x='"quoted"'>ok</p>`;
    const source = inner(pluginPageDocument(file(html), "chan", { language: "cn", theme, data: { cards: hostile } }));
    // One script element of the host's, and the page's markup intact.
    expect(source.match(/<\/script>/g)).toHaveLength(1);
    expect(source).not.toContain("\u2028");
    const page = new DOMParser().parseFromString(source, "text/html");
    expect(page.querySelectorAll("script")).toHaveLength(1);
    expect(page.querySelector("p")!.getAttribute("title")).toBe("a & b");
    expect(page.querySelector("p")!.getAttribute("data-x")).toBe('"quoted"');
  });

  it("inlines the package files the page links to, and nothing outside the package", () => {
    const assets = {
      "ui/page.html": { mime: "text/html", data: "" },
      "ui/app.js": { mime: "text/javascript", data: b64("window.app = '</script>'; ") },
      "ui/lib/chart.mjs": { mime: "text/javascript", data: b64("export const draw = 1;") },
      "ui/main.mjs": { mime: "text/javascript", data: b64("import { draw } from 'pkg:ui/lib/chart.mjs';") },
      "ui/theme.css": { mime: "text/css", data: b64("@import './base.css'; body { background: url(img/bg.png) }") },
      "ui/base.css": { mime: "text/css", data: b64("@font-face { font-family: X; src: url('../fonts/x.woff2') }") },
      "ui/img/bg.png": { mime: "image/png", data: "iVBO" },
      "fonts/x.woff2": { mime: "font/woff2", data: "d09G" },
      "data/runs.json": { mime: "application/json", data: b64("[1,2]") },
    };
    const html = `<html><head><link rel="stylesheet" href="./theme.css"><script src="app.js"></script><script type="module" src="main.mjs"></script></head>
      <body><img src="img/bg.png?v=2" srcset="img/bg.png 2x"><img src="../../outside.png"><img src="https://example.com/x.png"><div style="background:url(img/bg.png)"></div></body></html>`;
    const source = inner(pluginPageDocument(file(html, assets, "ui/page.html"), "chan", { language: "en", theme, data: {} }));
    const page = new DOMParser().parseFromString(source, "text/html");
    // Scripts inline (unable to close their element), stylesheets inline with their imports and urls.
    const scripts = [...page.querySelectorAll("script")];
    expect(scripts.some((script) => script.getAttribute("src"))).toBe(false);
    expect(scripts.find((script) => script.textContent!.includes("window.app"))!.textContent).toContain("<\\/script>");
    expect(scripts.find((script) => script.getAttribute("type") === "module")!.textContent).toBe('import "pkg:ui/main.mjs";');
    const map = JSON.parse(scripts.find((script) => script.getAttribute("type") === "importmap")!.textContent!);
    expect(Object.keys(map.imports)).toEqual(["pkg:ui/lib/chart.mjs", "pkg:ui/main.mjs"]);
    expect(map.imports["pkg:ui/main.mjs"]).toMatch(/^data:text\/javascript;base64,/);
    expect(page.querySelector("link")).toBeNull();
    const style = page.querySelector("style")!.textContent!;
    expect(style).toContain('url("data:font/woff2;base64,d09G")');
    expect(style).toContain('url("data:image/png;base64,iVBO")');
    const images = [...page.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(images).toEqual(["data:image/png;base64,iVBO", "../../outside.png", "https://example.com/x.png"]);
    expect(page.querySelector("img")!.getAttribute("srcset")).toBe("data:image/png;base64,iVBO 2x");
    expect(page.querySelector("div")!.getAttribute("style")).toContain("data:image/png;base64,iVBO");
    // Data files reach script through somniq.asset / somniq.text; code is not copied there.
    const boot = scripts[0].textContent!;
    expect(boot).toContain("data/runs.json");
    expect(boot).not.toContain("main.mjs");
  });
});

describe("PluginPageFrame", () => {
  const post = vi.fn();
  const pageWindow = { postMessage: post };
  const onAction = vi.fn();
  /** Deliver a message as if `source` posted it to the app window. */
  const deliver = async (data: unknown, source: unknown = pageWindow) => {
    const event = new MessageEvent("message", { data });
    Object.defineProperty(event, "source", { value: source });
    await act(async () => { window.dispatchEvent(event); await Promise.resolve(); });
  };
  const mount = async () => {
    render(<PluginPage panel={panel} projectPath="F:/project" language="en" onAction={onAction} />);
    const shell = await screen.findByTitle("Focus board") as HTMLIFrameElement;
    Object.defineProperty(shell, "contentWindow", { value: { 0: pageWindow } });
    return shell;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("chan-chan-chan-chan-chan");
    vi.mocked(api.pluginsUiPage).mockResolvedValue({ html: "<h1>Board</h1>", path: "page.html", assets: {}, packageDigest: "d1" });
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue(stateOf(3, [{ id: "a" }]));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("runs the reviewed page in a frame with no origin, under the host's header", async () => {
    const shell = await mount();
    expect(screen.getByRole("heading", { level: 1, name: "Focus board" })).toBeTruthy();
    expect(screen.getByText(/@local\/focus-board/)).toBeTruthy();
    expect(api.pluginsUiPage).toHaveBeenCalledWith("F:/project", "@local/focus-board", "focus-board");
    expect(shell.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(shell.getAttribute("sandbox")).not.toContain("allow-same-origin");
    const source = inner(shell.getAttribute("srcdoc")!);
    expect(source).toContain("<h1>Board</h1>");
    // The page starts with the project's data, the list with the host's item ids.
    expect(source).toContain(JSON.stringify({ cards: [{ id: "a" }], todos: [{ id: "t1", text: "Read", completed: false }] }));
  });

  it("answers only its own page, and saves through the checked widget write", async () => {
    await mount();
    vi.mocked(api.pluginsUiStateUpdate).mockResolvedValue(stateOf(4, [{ id: "b" }]));
    const call = { channel: "chan-chan-chan-chan-chan", type: "call", id: 1, method: "set", args: { widget: "cards", value: [{ id: "b" }] } };
    await deliver(call, { postMessage: vi.fn() });
    await deliver({ ...call, channel: "another" });
    expect(api.pluginsUiStateUpdate).not.toHaveBeenCalled();
    await deliver(call);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(api.pluginsUiStateUpdate).toHaveBeenCalledWith("F:/project", "@local/focus-board", "focus-board", "", 3, { type: "widgetSet", widgetId: "cards", value: [{ id: "b" }] });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ channel: "chan-chan-chan-chan-chan", type: "result", id: 1, ok: true, value: expect.objectContaining({ cards: [{ id: "b" }] }) }), "*");

    // A widget the panel does not declare is refused before any write.
    await deliver({ ...call, id: 2, args: { widget: "other", value: 1 } });
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2, ok: false }), "*"));
    expect(api.pluginsUiStateUpdate).toHaveBeenCalledTimes(1);
    // A list is written back without the ids it was read with.
    await deliver({ ...call, id: 3, args: { widget: "todos", value: [{ id: "t1", text: "Read", completed: true }] } });
    await waitFor(() => expect(api.pluginsUiStateUpdate).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.pluginsUiStateUpdate).mock.calls[1][5]).toEqual({ type: "widgetSet", widgetId: "todos", value: [{ text: "Read", completed: true }] });
  });

  it("retries once on the agent's newer revision, then reports the refusal", async () => {
    await mount();
    vi.mocked(api.pluginsUiStateUpdate)
      .mockRejectedValueOnce("Plugin UI state changed in another window; reload before saving")
      .mockResolvedValueOnce(stateOf(9, []))
      .mockRejectedValueOnce("The json widget cards takes any JSON value: a value is outside the limits");
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue(stateOf(8, [{ id: "agent" }]));
    const call = { channel: "chan-chan-chan-chan-chan", type: "call", id: 1, method: "set", args: { widget: "cards", value: [] } };
    await deliver(call);
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, ok: true }), "*"));
    expect(vi.mocked(api.pluginsUiStateUpdate).mock.calls.map((args) => args[4])).toEqual([3, 8]);
    await deliver({ ...call, id: 2 });
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2, ok: false, error: expect.stringContaining("outside the limits") }), "*"));
  });

  it("hands prompts to the composer without ever sending them, and files to the side panel", async () => {
    await mount();
    const channel = "chan-chan-chan-chan-chan";
    await deliver({ channel, type: "prompt", text: "Plan next steps", send: true });
    expect(onAction).toHaveBeenLastCalledWith({ type: "prompt", text: "Plan next steps", send: false });
    await deliver({ channel, type: "open-file", path: "results/log.md" });
    expect(onAction).toHaveBeenLastCalledWith({ type: "open-file", path: "results/log.md" });
    await deliver({ channel, type: "prompt", text: "x".repeat(4001) });
    await deliver({ channel, type: "prompt", text: "   " });
    await deliver({ channel, type: "prompt", text: { toString: () => "object" } });
    await deliver({ channel, type: "open-file", path: 7 });
    await deliver({ channel, type: "prompt", text: "From elsewhere" }, window);
    expect(onAction).toHaveBeenCalledTimes(2);
  });

  it("pushes the agent's writes to the page and stops a page it cannot isolate", async () => {
    await mount();
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue(stateOf(5, [{ id: "agent" }]));
    const change = (detail: api.PluginPanelChange) => act(async () => { window.dispatchEvent(new CustomEvent(api.PLUGIN_PANEL_CHANGED_EVENT, { detail })); await Promise.resolve(); });
    await change({ projectPath: "F:/project", pluginName: "@local/other", panelId: "focus-board" });
    expect(post).not.toHaveBeenCalled();
    await change({ projectPath: "f:\\project\\", pluginName: "@local/focus-board", panelId: "focus-board" });
    await waitFor(() => expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ type: "data", data: expect.objectContaining({ cards: [{ id: "agent" }] }) }), "*"));

    await deliver({ channel: "chan-chan-chan-chan-chan", type: "error", message: "isolation" });
    expect(screen.queryByTitle("Focus board")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("could not be isolated");
  });

  it("shows why a page did not load and can try again", async () => {
    vi.mocked(api.pluginsUiPage).mockRejectedValueOnce("UI plugin is disabled or blocked; reload the plugin panels");
    render(<PluginPage panel={panel} projectPath="F:/project" language="en" onAction={onAction} />);
    expect((await screen.findByRole("alert")).textContent).toContain("disabled or blocked");
    await act(async () => { screen.getByRole("button", { name: "Reload" }).click(); });
    expect(await screen.findByTitle("Focus board")).toBeTruthy();
  });
});

describe("a page in the Chat sidebar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("side-side-side-side-side");
    vi.mocked(api.pluginsUiPage).mockResolvedValue({ html: "<h1>Side</h1>", path: "page.html", assets: {}, packageDigest: "d1" });
    vi.mocked(api.pluginsUiStateGet).mockResolvedValue(stateOf(1, null));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("reads this conversation's copy and hands prompts to the composer unsent", async () => {
    const { default: ChatPluginPanel } = await import("./ChatPluginPanel");
    const onPrompt = vi.fn();
    const side: api.ActiveUiPanel = { ...panel, slot: "chat.sidebar", scope: "session", title: "Side" };
    render(<ChatPluginPanel panel={side} projectPath="F:/project" sessionId="s1" language="en" agentTodos={[]} onPrompt={onPrompt} />);
    const shell = await screen.findByTitle("Side") as HTMLIFrameElement;
    expect(shell.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(api.pluginsUiStateGet).toHaveBeenCalledWith("F:/project", "@local/focus-board", "focus-board", "s1");
    const pageWindow = { postMessage: vi.fn() };
    Object.defineProperty(shell, "contentWindow", { value: { 0: pageWindow } });
    const event = new MessageEvent("message", { data: { channel: "side-side-side-side-side", type: "prompt", text: "Summarize" } });
    Object.defineProperty(event, "source", { value: pageWindow });
    await act(async () => { window.dispatchEvent(event); });
    expect(onPrompt).toHaveBeenCalledWith("Summarize", false);
  });

  it("waits for a real conversation before a session page stores anything", async () => {
    const { default: ChatPluginPanel } = await import("./ChatPluginPanel");
    render(<ChatPluginPanel panel={{ ...panel, slot: "chat.sidebar", scope: "session" }} projectPath="F:/project" sessionId="chat-home" language="en" agentTodos={[]} />);
    expect(screen.queryByTitle("Focus board")).toBeNull();
    expect(api.pluginsUiPage).not.toHaveBeenCalled();
  });
});
