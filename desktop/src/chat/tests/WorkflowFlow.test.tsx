// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatTodoItem } from "../../types";
import { useStore } from "../../store";
import type { TurnFileChangeSummary } from "../ChatMessage";
import WorkflowFlow from "../WorkflowFlow";

const apiMocks = vi.hoisted(() => ({
  chatChangeRevert: vi.fn(),
  fileOpen: vi.fn(),
  fileReadBytes: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("../../api/tauri", () => apiMocks);

beforeEach(() => {
  useStore.setState({ tab: "chat", language: "en", pendingStudioArtifactId: null });
  apiMocks.isTauri.mockReturnValue(false);
  apiMocks.fileOpen.mockResolvedValue(undefined);
  apiMocks.fileReadBytes.mockResolvedValue([]);
  apiMocks.chatChangeRevert.mockResolvedValue({
    changeId: "change-id",
    filePath: "src/a.ts",
    reverted: true,
    revertChangeId: "revert-id",
  });
});

afterEach(cleanup);

const SAMPLE: ChatTodoItem[] = [
  { content: "检查邮箱实现", activeForm: "正在检查邮箱实现", status: "completed" },
  { content: "实现 Rust IMAP/SMTP", activeForm: "正在实现 Rust IMAP/SMTP", status: "in_progress" },
  { content: "测试 Outlook 连接", activeForm: "正在测试 Outlook 连接", status: "pending" },
  { content: "类型检查与打包", activeForm: "正在打包验证", status: "pending" },
];

describe("WorkflowFlow", () => {
  it("shows the current step number and expands on click", async () => {
    const user = userEvent.setup();
    render(<WorkflowFlow todos={SAMPLE} fileChanges={[]} bottomOffset={120} active />);

    // Collapsed chip shows current step (the in-progress one is step 2 of 4).
    const chip = screen.getByRole("button", { expanded: false });
    expect(chip.textContent).toContain("第 2 / 4 步");

    // Panel is hidden until clicked.
    expect(screen.queryByRole("list")).toBeNull();
    await user.click(chip);
    const panel = screen.getByRole("list");
    expect(panel.textContent).toContain("正在实现 Rust IMAP/SMTP"); // activeForm for in-progress
    expect(panel.textContent).toContain("检查邮箱实现"); // content for completed
  });

  it("renders a completed state when all steps are done", () => {
    const done = SAMPLE.map((t) => ({ ...t, status: "completed" as const }));
    render(<WorkflowFlow todos={done} fileChanges={[]} bottomOffset={120} active={false} />);
    expect(screen.getByRole("button").textContent).toContain("已完成 4 步");
  });

  it("renders file changes without todos", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowFlow
        todos={[]}
        fileChanges={[
          { path: "desktop/src/new.ts", status: "added" },
          { path: "desktop/src/App.tsx", status: "modified" },
        ]}
        bottomOffset={120}
        active={false}
      />,
    );

    const chip = screen.getByRole("button", { expanded: false });
    expect(chip.textContent).toContain("已变更 2 文件");
    await user.click(chip);
    expect(screen.getByText("desktop/src/new.ts")).toBeTruthy();
    expect(screen.getByText("desktop/src/App.tsx")).toBeTruthy();
    expect(screen.getByText("新增")).toBeTruthy();
    expect(screen.getByText("修改")).toBeTruthy();
  });

  it("renders audited file changes inside the workflow panel", async () => {
    const user = userEvent.setup();
    const summary: TurnFileChangeSummary = {
      fileCount: 2,
      addedLines: 4,
      removedLines: 1,
      changeIds: ["change-1", "change-2"],
      changes: [
        {
          path: "src/a.ts",
          diff: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more",
          changeId: "change-1",
          addedLines: 2,
          removedLines: 1,
          sourceTool: "edit_file",
          toolUseId: "tool-1",
        },
        {
          path: "src/b.ts",
          diff: "--- /dev/null\n+++ src/b.ts\n+one\n+two",
          changeId: "change-2",
          addedLines: 2,
          removedLines: 0,
          sourceTool: "write_file",
          toolUseId: "tool-2",
        },
      ],
      files: [
        {
          path: "src/a.ts",
          addedLines: 2,
          removedLines: 1,
          changes: [],
        },
        {
          path: "src/b.ts",
          addedLines: 2,
          removedLines: 0,
          changes: [],
        },
      ],
    };
    summary.files[0].changes = [summary.changes[0]];
    summary.files[1].changes = [summary.changes[1]];

    render(
      <WorkflowFlow
        todos={[]}
        fileChanges={[]}
        fileChangeSummary={summary}
        bottomOffset={120}
        active={false}
      />,
    );

    const chip = screen.getByRole("button", { expanded: false });
    expect(chip.textContent).toContain("2");
    await user.click(chip);

    expect(screen.getByText("Edited 2 files")).toBeTruthy();
    expect(screen.getAllByText("+4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-1").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText(/-old/)).toBeTruthy();
    expect(screen.getByText(/\+new/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(apiMocks.chatChangeRevert).toHaveBeenCalledTimes(2));
    expect(apiMocks.chatChangeRevert.mock.calls.map((call) => call[0])).toEqual(["change-2", "change-1"]);
  });

  it("renders nothing without todos or file changes", () => {
    const { container } = render(<WorkflowFlow todos={[]} fileChanges={[]} bottomOffset={120} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});
