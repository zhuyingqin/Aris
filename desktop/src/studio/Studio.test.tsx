// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioLibrary } from "./studioTypes";

const mocks = vi.hoisted(() => ({
  studioLoad: vi.fn(),
  studioSave: vi.fn(),
  studioHtml: vi.fn(),
  fileOpen: vi.fn(),
  fileRead: vi.fn(),
}));

vi.mock("../api/tauri", () => ({
  isTauri: () => true,
  studioLoad: mocks.studioLoad,
  studioSave: mocks.studioSave,
  studioHtml: mocks.studioHtml,
  fileOpen: mocks.fileOpen,
  fileRead: mocks.fileRead,
  projectAdd: vi.fn(),
  projectsGet: vi.fn(),
  projectsReorder: vi.fn(),
  projectSetCurrent: vi.fn(),
  stateDir: vi.fn(),
}));

vi.mock("../literature/PdfReader", () => ({
  default: ({
    relativePath,
    onPageChange,
  }: {
    relativePath: string;
    onPageChange?: (page: number) => void;
  }) => (
    <div>
      <div data-testid="pdf-preview">{relativePath}</div>
      <button type="button" onClick={() => onPageChange?.(2)}>Show page 2</button>
    </div>
  ),
}));

vi.mock("./Presentation", () => ({
  default: ({ relativePath, onClose }: { relativePath: string; onClose: () => void }) => (
    <div data-testid="presentation">
      <span>{relativePath}</span>
      <button type="button" onClick={onClose}>Exit presentation</button>
    </div>
  ),
}));

import Studio from "./Studio";
import { resetStudioStore } from "./studioStore";
import { useStore } from "../store";

const library = (): StudioLibrary => ({
  version: 1,
  artifacts: [
    {
      id: "slides:main",
      kind: "slides",
      title: "Research Talk",
      status: "ready",
      pdfPath: "slides/main.pdf",
      pptxPath: "slides/main.pptx",
      generatedAt: "2026-06-15T00:00:00.000Z",
      pinned: false,
      notes: "",
      pageReviews: [],
    },
  ],
});

beforeEach(() => {
  localStorage.clear();
  resetStudioStore();
  useStore.setState({
    tab: "studio",
    pendingStudioArtifactId: null,
    currentProject: {
      id: "project-test",
      name: "Test",
      path: "C:/project",
      addedAt: 0,
      lastOpenedAt: 0,
    },
  });
  mocks.studioLoad.mockReset().mockImplementation(async () => library());
  mocks.studioSave.mockReset().mockResolvedValue(undefined);
  mocks.studioHtml.mockReset().mockResolvedValue("<h1>Interactive</h1>");
  mocks.fileOpen.mockReset().mockResolvedValue(undefined);
  mocks.fileRead.mockReset().mockResolvedValue("# Speaker notes");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Studio", () => {
  it("is a result review library without generation or compilation controls", async () => {
    render(<Studio />);

    expect(await screen.findByText("Research Talk")).toBeTruthy();
    expect(screen.getByTestId("pdf-preview").textContent).toBe("slides/main.pdf");
    expect(screen.queryByRole("button", { name: /Generate/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Recompile/i })).toBeNull();
  });

  it("refreshes externally generated results from the Studio index", async () => {
    const user = userEvent.setup();
    render(<Studio />);
    await screen.findByText("Research Talk");

    await user.click(screen.getByRole("button", { name: "Refresh results" }));
    await waitFor(() => expect(mocks.studioLoad).toHaveBeenCalledTimes(2));
  });

  it("attaches feedback to the currently visible page and persists it", async () => {
    const user = userEvent.setup();
    render(<Studio />);
    await screen.findByText("Research Talk");

    await user.click(screen.getByRole("button", { name: "Show page 2" }));
    const feedback = screen.getByRole("textbox", { name: "Feedback for page 2" });
    await user.type(feedback, "Make the comparison easier to read.");
    await user.click(screen.getByRole("button", { name: "Add page feedback" }));

    expect(await screen.findByText("Make the comparison easier to read.")).toBeTruthy();
    await waitFor(() => expect(mocks.studioSave).toHaveBeenCalled(), { timeout: 1500 });
    const calls = mocks.studioSave.mock.calls;
    const saved = calls[calls.length - 1]?.[0] as StudioLibrary;
    expect(saved.artifacts[0].pageReviews[0]).toMatchObject({
      page: 2,
      body: "Make the comparison easier to read.",
      status: "open",
    });
  });

  it("routes open page feedback to Chat and marks reviews as submitted", async () => {
    const next = library();
    next.artifacts[0].pageReviews = [
      {
        id: "review-1",
        page: 3,
        body: "State the takeaway in the title.",
        status: "open",
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z",
      },
    ];
    mocks.studioLoad.mockImplementation(async () => next);
    const user = userEvent.setup();
    render(<Studio />);
    await screen.findByText("Research Talk");

    await user.click(screen.getByRole("button", { name: "Send to Chat (1)" }));

    const state = useStore.getState();
    expect(state.tab).toBe("chat");
    const prompt = state.pendingChatRunInput ?? "";
    expect(prompt).toContain("Do not generate a new deck or poster");
    expect(prompt).toContain("[Page 3] State the takeaway in the title.");
    expect(prompt).toContain("slides/main.pptx");
    await waitFor(() => expect(mocks.studioSave).toHaveBeenCalled(), { timeout: 1500 });
    const calls = mocks.studioSave.mock.calls;
    const saved = calls[calls.length - 1]?.[0] as StudioLibrary;
    expect(saved.artifacts[0].pageReviews[0].status).toBe("submitted");
  });

  it("persists user title and pinned state in the Studio library", async () => {
    const user = userEvent.setup();
    render(<Studio />);
    await screen.findByText("Research Talk");

    const title = screen.getByRole("textbox", { name: "Artifact title" });
    await user.clear(title);
    await user.type(title, "Conference Talk");
    await user.click(screen.getByRole("button", { name: "Pin" }));

    await waitFor(() => expect(mocks.studioSave).toHaveBeenCalled(), { timeout: 1500 });
    const calls = mocks.studioSave.mock.calls;
    const saved = calls[calls.length - 1]?.[0] as StudioLibrary;
    expect(saved.artifacts[0]).toMatchObject({
      title: "Conference Talk",
      pinned: true,
    });
  });

  it("presents a slide deck fullscreen and closes the overlay on exit", async () => {
    const user = userEvent.setup();
    render(<Studio />);
    await screen.findByText("Research Talk");

    await user.click(screen.getByRole("button", { name: "Present" }));
    expect(screen.getByTestId("presentation").textContent).toContain("slides/main.pdf");

    await user.click(screen.getByRole("button", { name: "Exit presentation" }));
    await waitFor(() => expect(screen.queryByTestId("presentation")).toBeNull());
  });

  it("renders interactive HTML artifacts and opens a pending deep link", async () => {
    const next = library();
    next.artifacts.push({
      id: "web:irl-demo",
      kind: "web",
      title: "IRL Interactive Demo",
      status: "ready",
      htmlPath: "web/irl.html",
      generatedAt: "2026-06-15T01:00:00.000Z",
      pinned: false,
      notes: "",
      pageReviews: [],
    });
    mocks.studioLoad.mockImplementation(async () => next);
    useStore.setState({ pendingStudioArtifactId: "web:irl-demo" });

    render(<Studio />);

    const frame = await screen.findByTitle("Web preview: web/irl.html");
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    expect(mocks.studioHtml).toHaveBeenCalledWith("web/irl.html");
    expect(useStore.getState().pendingStudioArtifactId).toBeNull();
  });
});
