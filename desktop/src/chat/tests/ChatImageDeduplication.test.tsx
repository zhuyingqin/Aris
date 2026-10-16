// @vitest-environment jsdom

import { StrictMode } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBlock, ChatTurn } from "../../types";
import { useStore } from "../../store";
import ChatMessage from "../ChatMessage";

const apiMocks = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  fileReadBytes: vi.fn(),
  fileOpen: vi.fn(),
  chatChangeRevert: vi.fn(),
}));
vi.mock("../../api/tauri", () => apiMocks);

const path = ".somniq/artifacts/somni-images/run/image-1.png";
const absolutePath = `D:/work/${path}`;
const generated: ChatBlock = {
  kind: "tool", id: "generate", name: "SomniImage", input: "{}",
  output: JSON.stringify({ status: "completed", images: [{ path }] }),
};
const readImage = (id: string, filePath: string): ChatBlock => ({
  kind: "tool", id, name: "ReadMediaFile", input: JSON.stringify({ path: filePath }),
  output: JSON.stringify({ type: "image", filePath, image: { base64: "ZmFrZQ==" } }),
});
const message = (turn: ChatTurn) => <ChatMessage turn={turn} canRetry={false}
  onEdit={() => undefined} onRetry={() => undefined} onContinue={() => undefined} />;

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.fileReadBytes.mockResolvedValue([137, 80, 78, 71]);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:mock-image") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  useStore.setState({ language: "en", tab: "chat", pendingTypesetFilePath: null,
    currentProject: { id: "p1", name: "work", path: "D:/work", addedAt: 0, lastOpenedAt: 0 } });
});
afterEach(cleanup);

describe("Chat image deduplication", () => {
  it("shows generation, verification and final Markdown as one preview with usable references", async () => {
    const user = userEvent.setup();
    render(message({ id: "generation-read-final", role: "assistant", blocks: [generated,
      { kind: "text", text: "Checking the rendering." },
      readImage("read", absolutePath.replace(/\//g, "\\")),
      { kind: "text", text: `![Final diagram](<${absolutePath}>)\n\n[Download diagram](${path})` },
    ] }));

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(1));
    expect(apiMocks.fileReadBytes).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("button", { name: /View image/ })).toHaveLength(3);
    await user.click(screen.getByText("ReadMediaFile"));
    expect(screen.getByText(/"base64"/)).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "View image · Final diagram" }));
    const viewer = screen.getByRole("dialog", { name: "image-1.png" });
    expect(await within(viewer).findByRole("img", { name: "Final diagram" })).toBeTruthy();
    expect(useStore.getState().pendingTypesetFilePath).toBeNull();
    expect(useStore.getState().tab).toBe("chat");
    expect(apiMocks.fileOpen).not.toHaveBeenCalled();
    await user.click(within(viewer).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("keeps the first preview stable during streaming, StrictMode replays and history remounts", async () => {
    const initial: ChatTurn = { id: "streaming", role: "assistant", streaming: true, blocks: [generated] };
    const view = render(<StrictMode>{message(initial)}</StrictMode>);
    const image = await screen.findByRole("img");
    const saved: ChatTurn = { ...initial, streaming: false, blocks: [generated,
      readImage("read", path), { kind: "text", text: `![Diagram](${path})` }] };
    view.rerender(<StrictMode>{message(saved)}</StrictMode>);
    expect(screen.getAllByRole("img")).toEqual([image]);
    view.unmount();
    render(<StrictMode>{message(saved)}</StrictMode>);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(1));
    expect(screen.getAllByRole("button", { name: /View image/ })).toHaveLength(2);
  });

  it("deduplicates reference-style Markdown across blocks without claiming code or hidden thinking", async () => {
    render(message({ id: "markdown-first", role: "assistant", blocks: [
      { kind: "text", text: `<think>![Hidden](${path})</think>\n\n\`![Example](${path})\`\n\n![First diagram][plot]\n\n[plot]: <${absolutePath}>` },
      readImage("read", path),
      { kind: "text", text: `[Same diagram][again]\n\n[again]: ${path}` },
    ] }));
    const image = await screen.findByRole("img", { name: "First diagram" });
    expect(screen.getAllByRole("img")).toEqual([image]);
    expect(screen.getAllByRole("button", { name: /View image/ })).toHaveLength(2);
  });

  it("keeps grouped tool previews visible and unique when expanding or collapsing their audit details", async () => {
    const user = userEvent.setup();
    render(message({ id: "grouped-reads", role: "assistant", blocks: [
      readImage("first-read", path), readImage("second-read", absolutePath),
      { kind: "text", text: `![Final](${path})` },
    ] }));
    const image = await screen.findByRole("img");
    expect(screen.getAllByRole("img")).toEqual([image]);
    const group = screen.getByRole("button", { name: /ReadMediaFile.*2\/2/ });
    await user.click(group);
    expect(screen.getAllByText("ReadMediaFile")).toHaveLength(3);
    expect(screen.getAllByRole("img")).toEqual([image]);
    await user.click(group);
    expect(screen.getAllByRole("img")).toEqual([image]);
  });

  it("does not let thinking, code, raw HTML or a large text excerpt consume the first image preview", async () => {
    const paths = ["results/thinking.png", "results/code.png", "results/html.png", "results/large.png"];
    render(message({ id: "unrendered-image-syntax", role: "assistant", blocks: [
      { kind: "text", text: `<think>![Hidden](${paths[0]})</think>\n\n\`![Code](${paths[1]})\`\n\n<img src="${paths[2]}" />` },
      { kind: "notice", message: "A large report follows." },
      { kind: "text", text: `${"x".repeat(81_000)}\n\n![Excerpt](${paths[3]})` },
      ...paths.map((source, index) => readImage(`unrendered-${index}`, source)),
    ] }));
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(4));
    expect(screen.queryByRole("button", { name: /View image/ })).toBeNull();
  });

  it("preserves different artifacts, URL query variants, user attachments and later turns", async () => {
    const source = "https://example.com/plot.png?v=1";
    const turn: ChatTurn = { id: "first", role: "assistant", blocks: [generated,
      { kind: "text", text: `![Other](results/other.png)\n\n![One](${source})\n\n[Same](${source})\n\n![Two](https://example.com/plot.png?v=2)` },
    ] };
    render(<>{message({ id: "user", role: "user", blocks: [], attachments: [{ id: "upload", kind: "image",
      name: "Uploaded", preview: "data:image/png;base64,ZmFrZQ==" }] })}{message(turn)}{message({ ...turn, id: "later" })}</>);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(9));
    expect(screen.getAllByRole("img", { name: "One" })).toHaveLength(2);
    expect(screen.getAllByRole("img", { name: "Two" })).toHaveLength(2);
    expect(screen.getAllByRole("img", { name: "Uploaded" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "View image · Same" })).toHaveLength(2);
  });
});
