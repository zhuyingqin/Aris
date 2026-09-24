// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fileAssetUrl,
  fileOpen,
  fileReveal,
  pptMasterDecksList,
} from "../api/tauri";
import { useStore } from "../store";
import PptMasterPreview from "./PptMasterPreview";

vi.mock("../api/tauri", () => ({
  isTauri: () => false,
  fileAssetUrl: vi.fn(),
  fileOpen: vi.fn(),
  fileReveal: vi.fn(),
  pptMasterDecksList: vi.fn(),
}));

const deck = {
  id: ".somniq/slides/ppt-master/run-42/svg_final",
  title: "run-42",
  rootPath: ".somniq/slides/ppt-master/run-42",
  slides: [1, 2, 3].map((number) => ({
    number,
    name: `slide-${number}.svg`,
    path: `.somniq/slides/ppt-master/run-42/svg_final/slide-${number}.svg`,
  })),
  exportPath: ".somniq/slides/ppt-master/run-42/exports/result.pptx",
  modifiedEpochMs: 1_789_000_000_000,
};

describe("PptMasterPreview", () => {
  beforeEach(() => {
    useStore.setState({ language: "cn" });
    vi.mocked(pptMasterDecksList).mockResolvedValue([deck]);
    vi.mocked(fileAssetUrl).mockImplementation(async (path) => `asset://${path}`);
    vi.mocked(fileOpen).mockResolvedValue(undefined);
    vi.mocked(fileReveal).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("navigates final SVG slides with the keyboard", async () => {
    render(<PptMasterPreview onClose={vi.fn()} />);

    expect(await screen.findByAltText("第 1 / 3 页")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByAltText("第 2 / 3 页")).toBeTruthy();
    fireEvent.keyDown(window, { key: "End" });
    expect(await screen.findByAltText("第 3 / 3 页")).toBeTruthy();
  });

  it("opens the exported PPTX and reveals the run folder", async () => {
    render(<PptMasterPreview onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "用系统程序打开 PPTX" }));
    fireEvent.click(screen.getByRole("button", { name: "在资源管理器中显示" }));

    await waitFor(() => {
      expect(fileOpen).toHaveBeenCalledWith(deck.exportPath);
      expect(fileReveal).toHaveBeenCalledWith(deck.rootPath);
    });
  });
});
