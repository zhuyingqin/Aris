// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  codeBridgeSetTheme,
  codeServerEnsure,
  codeServerStatus,
  codeServerStop,
  onCodeBridgeActiveEditor,
  onCodeBridgeAsk,
  onCodeBridgeConnection,
} from "../api/tauri";
import { useStore } from "../store";
import type { CodeBridgeAsk, CodeServerStatus } from "../types";
import { CODE_COPY } from "./i18n";
import CodePane, { askPromptFor, downloadPercent, frameKey } from "./CodePane";

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  codeServerStatus: vi.fn(),
  codeServerEnsure: vi.fn(),
  codeServerStop: vi.fn(),
  codeBridgeSetTheme: vi.fn(() => Promise.resolve()),
  onCodeServerStatus: vi.fn(() => Promise.resolve(() => {})),
  onCodeBridgeAsk: vi.fn(() => Promise.resolve(() => {})),
  onCodeBridgeConnection: vi.fn(() => Promise.resolve(() => {})),
  onCodeBridgeActiveEditor: vi.fn(() => Promise.resolve(() => {})),
}));

// The compute panel is rehosted here but pulls the whole compute API surface;
// the tests below only care that it is offered, not what it renders.
vi.mock("./ComputePanel", () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="compute-panel" data-active-path={String(props.activePath)} />
  ),
}));

const status = (patch: Partial<CodeServerStatus> = {}): CodeServerStatus => ({
  phase: "idle",
  version: "1.126.04524",
  installed: false,
  port: null,
  url: null,
  message: null,
  downloadedBytes: 0,
  totalBytes: 0,
  ...patch,
});

const READY = status({
  phase: "ready",
  installed: true,
  port: 39217,
  url: "http://code.tauri.localhost:39217/?tkn=abc&folder=D%3A%2Fwork",
});

function setProject(path: string | null) {
  useStore.setState({
    currentProject: path
      ? { id: "p1", name: "work", path, addedAt: 0, lastOpenedAt: 0 }
      : null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("somniq-code-trust-ack", "true");
  useStore.setState({ language: "en", theme: "dark" });
  setProject("D:/work");
  vi.mocked(codeServerStatus).mockResolvedValue(status());
  vi.mocked(codeServerEnsure).mockResolvedValue(READY);
  vi.mocked(codeServerStop).mockResolvedValue(status({ installed: true }));
});

afterEach(cleanup);

describe("downloadPercent", () => {
  it("is zero before the content length is known", () => {
    expect(downloadPercent(null)).toBe(0);
    expect(downloadPercent(status({ downloadedBytes: 500, totalBytes: 0 }))).toBe(0);
  });

  it("rounds and clamps", () => {
    expect(downloadPercent(status({ downloadedBytes: 50, totalBytes: 200 }))).toBe(25);
    expect(downloadPercent(status({ downloadedBytes: 999, totalBytes: 200 }))).toBe(100);
  });
});

describe("frameKey", () => {
  it("only yields a url once the server is ready", () => {
    expect(frameKey(null)).toBeNull();
    expect(frameKey(status({ phase: "starting", url: "http://x/" }))).toBeNull();
    expect(frameKey(READY)).toBe(READY.url);
  });

  // A restart mints a new port and a new token, so remounting on url change is
  // what makes the iframe pick up the new server instead of a dead one.
  it("changes when the server restarts on a different port", () => {
    const restarted = status({ ...READY, port: 40001, url: "http://code.tauri.localhost:40001/?tkn=xyz" });
    expect(frameKey(restarted)).not.toBe(frameKey(READY));
  });
});

describe("askPromptFor", () => {
  const copy = CODE_COPY.en;
  const ask = (patch: Partial<CodeBridgeAsk> = {}): CodeBridgeAsk => ({
    path: "D:/work/main.rs",
    startLine: 4,
    endLine: 4,
    text: "let x = 1;",
    languageId: "rust",
    truncated: false,
    ...patch,
  });

  it("names the file and a single line", () => {
    const prompt = askPromptFor(ask(), copy);
    expect(prompt).toContain("D:/work/main.rs");
    expect(prompt).toContain("line 4");
    expect(prompt).not.toContain("4-4");
  });

  it("renders a range when the selection spans lines", () => {
    expect(askPromptFor(ask({ endLine: 9 }), copy)).toContain("lines 4-9");
  });

  it("says when the selection was truncated instead of passing off a fragment", () => {
    expect(askPromptFor(ask({ truncated: true }), copy)).toContain("truncated");
    expect(askPromptFor(ask(), copy)).not.toContain("truncated");
  });

  /// A selection containing a fence would otherwise break out of the block and
  /// the model would see the tail as prose.
  it("uses a longer fence when the selection contains a code fence", () => {
    const prompt = askPromptFor(ask({ text: "```js\nx\n```" }), copy);
    expect(prompt).toContain("````rust");
    expect(prompt.trimEnd().endsWith("````")).toBe(true);
  });
});

describe("CodePane", () => {
  it("shows the permission notice before anything is downloaded", async () => {
    localStorage.removeItem("somniq-code-trust-ack");
    render(<CodePane />);

    expect(await screen.findByText(/About permissions/i)).toBeTruthy();
    expect(codeServerEnsure).not.toHaveBeenCalled();
  });

  it("does not prepare the runtime without an explicit click", async () => {
    render(<CodePane />);

    expect(await screen.findByText(/needs to be prepared once/i)).toBeTruthy();
    expect(codeServerEnsure).not.toHaveBeenCalled();
  });

  it("starts on click and renders the workbench iframe", async () => {
    render(<CodePane />);
    await userEvent.click(await screen.findByRole("button", { name: /Prepare and start/i }));

    await waitFor(() => {
      const frame = document.querySelector("iframe.code-frame") as HTMLIFrameElement | null;
      expect(frame?.getAttribute("src")).toBe(READY.url);
    });
    expect(codeServerEnsure).toHaveBeenCalledWith("D:/work");
  });

  // The runtime is already on disk, so there is nothing to consent to and no
  // large download to trigger.
  it("auto-starts when the runtime is already installed", async () => {
    vi.mocked(codeServerStatus).mockResolvedValue(status({ installed: true }));
    render(<CodePane />);

    await waitFor(() => expect(codeServerEnsure).toHaveBeenCalledWith("D:/work"));
  });

  it("refuses to start without a project folder", async () => {
    setProject(null);
    render(<CodePane />);
    await userEvent.click(await screen.findByRole("button", { name: /Prepare and start/i }));

    expect(await screen.findByText(/Pick a project folder first/i)).toBeTruthy();
    expect(codeServerEnsure).not.toHaveBeenCalled();
  });

  it("surfaces a crash with a retry instead of a blank frame", async () => {
    vi.mocked(codeServerStatus).mockResolvedValue(
      status({ phase: "failed", installed: true, message: "VS Code server exited unexpectedly (exit code: 1)" }),
    );
    render(<CodePane />);

    expect(await screen.findByText(/stopped running/i)).toBeTruthy();
    expect(screen.getByText(/exited unexpectedly/i)).toBeTruthy();
    expect(document.querySelector("iframe.code-frame")).toBeNull();
  });

  it("offers a cancel while downloading", async () => {
    vi.mocked(codeServerStatus).mockResolvedValue(
      status({ phase: "downloading", downloadedBytes: 30, totalBytes: 100 }),
    );
    render(<CodePane />);

    expect(await screen.findByText(/Downloading runtime… 30%/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(codeServerStop).toHaveBeenCalled();
  });

  it("seeds the chat composer from a selection and switches tabs", async () => {
    let emit: ((ask: CodeBridgeAsk) => void) | null = null;
    vi.mocked(onCodeBridgeAsk).mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    render(<CodePane />);
    await waitFor(() => expect(emit).not.toBeNull());

    emit!({
      path: "D:/work/main.rs",
      startLine: 4,
      endLine: 6,
      text: "fn main() {}",
      languageId: "rust",
      truncated: false,
    });

    await waitFor(() => expect(useStore.getState().tab).toBe("chat"));
    const draft = useStore.getState().pendingChatInput ?? "";
    expect(draft).toContain("D:/work/main.rs");
    expect(draft).toContain("4-6");
    expect(draft).toContain("```rust");
    // Seeded, not sent — the user still has to write the actual question.
    expect(draft).toContain("fn main() {}");
  });

  /// The workbench keeps settings in browser storage, so the extension host is
  /// the only way in. Pushing on connect matters as much as pushing on change.
  it("pushes the theme once the bridge connects", async () => {
    let emit: ((connected: boolean) => void) | null = null;
    vi.mocked(onCodeBridgeConnection).mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    useStore.setState({ theme: "light" });
    render(<CodePane />);
    await waitFor(() => expect(emit).not.toBeNull());
    expect(codeBridgeSetTheme).not.toHaveBeenCalled();

    emit!(true);
    await waitFor(() =>
      expect(codeBridgeSetTheme).toHaveBeenCalledWith(false, expect.any(Object)),
    );

    useStore.setState({ theme: "dark" });
    await waitFor(() =>
      expect(codeBridgeSetTheme).toHaveBeenCalledWith(true, expect.any(Object)),
    );
  });

  /// The workbench renders in an iframe with its own stylesheet, so it cannot
  /// inherit the app's look; the palette has to travel with the theme flag.
  it("sends the app's palette alongside the light/dark flag", async () => {
    let emit: ((connected: boolean) => void) | null = null;
    vi.mocked(onCodeBridgeConnection).mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    document.documentElement.style.setProperty("--bg", "#0e1116");
    useStore.setState({ theme: "dark" });
    render(<CodePane />);
    await waitFor(() => expect(emit).not.toBeNull());

    emit!(true);
    await waitFor(() => expect(codeBridgeSetTheme).toHaveBeenCalled());

    const [, colors] = vi.mocked(codeBridgeSetTheme).mock.calls.at(-1)!;
    expect(colors["editor.background"]).toBe("#0e1116");
    document.documentElement.style.removeProperty("--bg");
  });

  /// `compute_submit` has no other entry point in the app, so switching the
  /// Code page to VS Code without rehosting this panel would make remote GPU
  /// submission unreachable.
  it("keeps remote compute reachable next to the workbench", async () => {
    vi.mocked(codeServerStatus).mockResolvedValue(status({ installed: true }));
    render(<CodePane />);
    await waitFor(() => expect(document.querySelector("iframe.code-frame")).toBeTruthy());

    expect(screen.queryByTestId("compute-panel")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Compute/i }));
    expect(screen.getByTestId("compute-panel")).toBeTruthy();
  });

  /// The panel submits "the file you have open", which lives inside the iframe
  /// — the bridge is the only way the app can know what that is.
  it("feeds the compute panel the workbench's active editor", async () => {
    let emit: ((editor: { path: string | null; isNotebook: boolean }) => void) | null = null;
    vi.mocked(onCodeBridgeActiveEditor).mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    vi.mocked(codeServerStatus).mockResolvedValue(status({ installed: true }));
    render(<CodePane />);
    await waitFor(() => expect(document.querySelector("iframe.code-frame")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: /Compute/i }));

    emit!({ path: "D:/work/train.ipynb", isNotebook: true });

    await waitFor(() =>
      expect(screen.getByTestId("compute-panel").getAttribute("data-active-path")).toBe(
        "D:/work/train.ipynb",
      ),
    );
  });

  it("retargets the workbench when the project changes", async () => {
    vi.mocked(codeServerStatus).mockResolvedValue(status({ installed: true }));
    render(<CodePane />);
    await waitFor(() => expect(codeServerEnsure).toHaveBeenCalledWith("D:/work"));

    setProject("D:/other");
    await waitFor(() => expect(codeServerEnsure).toHaveBeenCalledWith("D:/other"));
  });
});
