// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import type { ChatSession } from "../types";

vi.mock("../ChatComposer", () => ({ attachmentFromFile: vi.fn() }));
const copyImage = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../imageClipboard", () => ({ copyImageToClipboard: copyImage }));
vi.mock("../../api/tauri", () => ({ isTauri: () => false, fileOpen: vi.fn(), fileRead: vi.fn() }));
import { useChatComposer } from "../useChatComposer";
import ChatImagePreview from "../ChatImagePreview";
import FilePathMenu from "../FilePathMenu";
import { useStore } from "../../store";

function ContextMenuSurface() {
  const composer = useChatComposer({
    currentSession: null, currentSessionRef: createRef<ChatSession>(),
    updateSession: vi.fn(), setDraft: vi.fn(),
  });
  return <div onContextMenu={composer.handleChatContextMenu}>
    <button><img alt="Generated result" data-image-path="F:/研究项目/图表/result.png" src="blob:preview" />
      <span>figures/wrong-image.png</span>
    </button>
    <img alt="Older upload" data-image-path="uploads/shot.png.pdf" src="blob:upload" />
    <code>notes/report.md</code>
    <output data-testid="menu">{JSON.stringify(composer.fileMenu)}</output>
  </div>;
}

describe("chat image context menu targeting", () => {
  afterEach(cleanup);
  it("uses the clicked image's actual path instead of nearby caption text", () => {
    render(<ContextMenuSurface />);
    fireEvent.contextMenu(screen.getByAltText("Generated result"), { clientX: 70, clientY: 90 });
    expect(JSON.parse(screen.getByTestId("menu").textContent!)).toEqual({
      x: 70, y: 90, path: "F:/研究项目/图表/result.png", image: true,
    });
  });
  it("marks image previews explicitly even if the stored filename ends in PDF", () => {
    render(<ContextMenuSurface />);
    fireEvent.contextMenu(screen.getByAltText("Older upload"));
    expect(JSON.parse(screen.getByTestId("menu").textContent!)).toMatchObject({
      path: "uploads/shot.png.pdf", image: true,
    });
  });
  it("keeps ordinary file context menus available", () => {
    render(<ContextMenuSurface />);
    fireEvent.contextMenu(screen.getByText("notes/report.md"));
    expect(JSON.parse(screen.getByTestId("menu").textContent!)).toMatchObject({ path: "notes/report.md" });
  });
});

function ImageCopySurface() {
  const composer = useChatComposer({
    currentSession: null, currentSessionRef: createRef<ChatSession>(),
    updateSession: vi.fn(), setDraft: vi.fn(),
  });
  return <>
    <main onContextMenu={composer.handleChatContextMenu}>
      <ChatImagePreview src="data:image/png;base64,iVBORw0KGgo=" alt="Generated image"
        title="An explanatory diagram" openPath="F:/研究项目/图表/result.png" />
    </main>
    {composer.fileMenu && <FilePathMenu {...composer.fileMenu}
      onClose={() => composer.setFileMenu(null)} onAttach={vi.fn()} onOpenInWorkspace={vi.fn()} />}
  </>;
}

describe("generated image copy flow", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });
  it("copies an image from its preview context menu", async () => {
    useStore.setState({ language: "cn" });
    render(<ImageCopySurface />);
    fireEvent.contextMenu(screen.getByAltText("Generated image"));
    fireEvent.click(screen.getByRole("menuitem", { name: "复制图片" }));
    expect(copyImage).toHaveBeenCalledWith("F:/研究项目/图表/result.png");
    await screen.findByRole("button", { name: /Generated image/ });
  });
  it("opens the same menu above the enlarged image and Escape dismisses only the menu", async () => {
    useStore.setState({ language: "en" });
    render(<ImageCopySurface />);
    fireEvent.click(screen.getByRole("button", { name: /Generated image/ }));
    const viewer = await screen.findByRole("dialog");
    fireEvent.contextMenu(within(viewer).getByAltText("Generated image"));
    expect(screen.getByRole("menuitem", { name: "Copy image" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog")).toBe(viewer);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
