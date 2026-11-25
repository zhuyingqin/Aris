// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  typesetRevisionList: vi.fn(),
  typesetRevisionCompare: vi.fn(),
  typesetRevisionBlobText: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/tauri")>()),
  typesetRevisionCapture: vi.fn(),
  typesetRevisionCompare: mocks.typesetRevisionCompare,
  typesetRevisionBlobText: mocks.typesetRevisionBlobText,
  typesetRevisionExportZip: vi.fn(),
  typesetRevisionList: mocks.typesetRevisionList,
  typesetRevisionRestoreFile: vi.fn(),
  typesetRevisionRestoreProject: vi.fn(),
}));

import TypesetHistoryPanel from "../TypesetHistoryPanel";
import { useStore } from "../../store";

const revision = (id: string, parentRevisionId: string | null, createdAtMs: number) => ({
  id,
  parentRevisionId,
  createdAtMs,
  label: null,
  reason: "save",
  actor: "user",
  origin: "save",
  evidence: null,
  fileCount: 1,
  commentCount: 0,
  operationCount: 1,
});

const renderPanel = () => render(
  <TypesetHistoryPanel
    path="main.tex"
    onClose={vi.fn()}
    onBeforeSnapshot={vi.fn().mockResolvedValue(true)}
    onRestored={vi.fn().mockResolvedValue(undefined)}
  />,
);

describe("TypesetHistoryPanel line comparison", () => {
  afterEach(cleanup);

  beforeEach(() => {
    useStore.setState({ language: "en" });
    mocks.typesetRevisionList.mockReset().mockResolvedValue([revision("r2", "r1", 2), revision("r1", null, 1)]);
    mocks.typesetRevisionBlobText.mockReset().mockImplementation(async (hash: string) => ({
      old: "\\section{Intro}\nAlpha\nBeta\n",
      new: "\\section{Intro}\nAlpha\nGamma\n",
      png: null,
    } as Record<string, string | null>)[hash]);
  });

  it("opens a compared file into its changed lines", async () => {
    mocks.typesetRevisionCompare.mockReset().mockResolvedValue({
      baseRevisionId: "r1",
      targetRevisionId: "r2",
      operations: [{ id: "modify:main.tex", kind: "modify", path: "main.tex", previousPath: null, beforeHash: "old", afterHash: "new", bytes: 30 }],
    });
    renderPanel();
    const [compareLatest] = await screen.findAllByRole("button", { name: "Compare" });
    await act(async () => {
      fireEvent.click(compareLatest);
    });
    const toggle = await screen.findByRole("button", { name: /main\.tex/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(toggle);
    });
    const table = await screen.findByRole("table", { name: "Line comparison" });
    expect(table.textContent).toContain("+1 −1");
    const removed = table.querySelector(".typeset-history-diff-line.removed");
    const added = table.querySelector(".typeset-history-diff-line.added");
    expect(removed?.textContent).toContain("Beta");
    expect(added?.textContent).toContain("Gamma");
    // The changed line is line 3 on both sides.
    expect(removed?.querySelector(".old")?.textContent).toBe("3");
    expect(added?.querySelector(".new")?.textContent).toBe("3");
    expect(mocks.typesetRevisionBlobText).toHaveBeenCalledWith("old");
    expect(mocks.typesetRevisionBlobText).toHaveBeenCalledWith("new");

    fireEvent.click(toggle);
    expect(screen.queryByRole("table", { name: "Line comparison" })).toBeNull();
  });

  it("says a binary file cannot be compared line by line", async () => {
    mocks.typesetRevisionCompare.mockReset().mockResolvedValue({
      baseRevisionId: "r1",
      targetRevisionId: "r2",
      operations: [{ id: "modify:figure.png", kind: "modify", path: "figure.png", previousPath: null, beforeHash: "png", afterHash: "png", bytes: 30 }],
    });
    renderPanel();
    const [compareLatest] = await screen.findAllByRole("button", { name: "Compare" });
    await act(async () => {
      fireEvent.click(compareLatest);
    });
    const figure = await screen.findByRole("button", { name: /figure\.png/ });
    await act(async () => {
      fireEvent.click(figure);
    });
    await waitFor(() => expect(screen.getByText(/Binary or very large file/)).toBeTruthy());
  });
});
