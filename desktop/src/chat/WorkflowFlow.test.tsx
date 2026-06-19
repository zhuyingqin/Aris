// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatTurn } from "../types";
import { latestFileChangesFromTurns, latestTodosFromTurns, makeId } from "./model";
import WorkflowFlow from "./WorkflowFlow";

afterEach(cleanup);

function todoTurn(todos: unknown): ChatTurn {
  return {
    id: makeId("turn"),
    role: "assistant",
    blocks: [{ kind: "tool", id: makeId("tool"), name: "TodoWrite", input: JSON.stringify({ todos }) }],
  };
}

function userTurn(text: string): ChatTurn {
  return {
    id: makeId("turn"),
    role: "user",
    blocks: [{ kind: "text", text }],
  };
}

function toolTurn(name: string, input: unknown, output: unknown): ChatTurn {
  return {
    id: makeId("turn"),
    role: "assistant",
    blocks: [{
      kind: "tool",
      id: makeId("tool"),
      name,
      input: typeof input === "string" ? input : JSON.stringify(input),
      output: typeof output === "string" ? output : JSON.stringify(output),
    }],
  };
}

const SAMPLE = [
  { content: "检查邮箱实现", activeForm: "正在检查邮箱实现", status: "completed" },
  { content: "实现 Rust IMAP/SMTP", activeForm: "正在实现 Rust IMAP/SMTP", status: "in_progress" },
  { content: "测试 Outlook 连接", activeForm: "正在测试 Outlook 连接", status: "pending" },
  { content: "类型检查与打包", activeForm: "正在打包验证", status: "pending" },
];

describe("latestTodosFromTurns", () => {
  it("returns the most recent TodoWrite plan", () => {
    const turns: ChatTurn[] = [
      todoTurn([{ content: "old", activeForm: "old", status: "pending" }]),
      todoTurn(SAMPLE),
    ];
    const todos = latestTodosFromTurns(turns);
    expect(todos).toHaveLength(4);
    expect(todos[1]).toMatchObject({ content: "实现 Rust IMAP/SMTP", status: "in_progress" });
  });

  it("does not carry a previous request's plan into the current request", () => {
    const turns: ChatTurn[] = [
      userTurn("first task"),
      todoTurn([{ content: "old", activeForm: "old", status: "in_progress" }]),
      userTurn("second task"),
    ];

    expect(latestTodosFromTurns(turns)).toEqual([]);
  });

  it("uses the latest TodoWrite update within the current request", () => {
    const turns: ChatTurn[] = [
      userTurn("first task"),
      todoTurn([{ content: "old", activeForm: "old", status: "completed" }]),
      userTurn("second task"),
      todoTurn([{ content: "draft", activeForm: "draft", status: "in_progress" }]),
      todoTurn([{ content: "final", activeForm: "final", status: "completed" }]),
    ];

    expect(latestTodosFromTurns(turns)).toEqual([
      { content: "final", activeForm: "final", status: "completed" },
    ]);
  });

  it("falls back to content when activeForm is missing", () => {
    const todos = latestTodosFromTurns([todoTurn([{ content: "lone step", status: "pending" }])]);
    expect(todos[0]).toMatchObject({ content: "lone step", activeForm: "lone step" });
  });

  it("ignores malformed or empty input", () => {
    expect(latestTodosFromTurns([])).toEqual([]);
    const bad: ChatTurn = {
      id: "t",
      role: "assistant",
      blocks: [{ kind: "tool", name: "TodoWrite", input: "not json" }],
    };
    expect(latestTodosFromTurns([bad])).toEqual([]);
  });
});

describe("latestFileChangesFromTurns", () => {
  it("extracts confirmed write and edit file changes from the latest request", () => {
    const turns: ChatTurn[] = [
      userTurn("old task"),
      toolTurn("write_file", { path: "old.md", content: "old" }, { type: "create", filePath: "old.md" }),
      userTurn("new task"),
      toolTurn(
        "write_file",
        { path: "desktop/src/new.ts", content: "new" },
        { type: "create", filePath: "F:\\Agent\\Aris\\desktop\\src\\new.ts" },
      ),
      toolTurn(
        "edit_file",
        { path: "desktop/src/App.tsx", old_string: "old", new_string: "new" },
        { filePath: "F:\\Agent\\Aris\\desktop\\src\\App.tsx" },
      ),
    ];

    expect(latestFileChangesFromTurns(turns, "F:\\Agent\\Aris")).toEqual([
      { path: "desktop/src/new.ts", status: "added", sourceTool: "write_file" },
      { path: "desktop/src/App.tsx", status: "modified", sourceTool: "edit_file" },
    ]);
  });

  it("uses git status --short output as a shell fallback", () => {
    const changes = latestFileChangesFromTurns([
      userTurn("check changes"),
      toolTurn(
        "bash",
        { command: "git status --short" },
        { stdout: " M desktop/src/App.tsx\n?? desktop/src/new.ts\nR  desktop/src/old.ts -> desktop/src/renamed.ts\n" },
      ),
    ]);

    expect(changes).toEqual([
      { path: "desktop/src/App.tsx", status: "modified", sourceTool: "git status" },
      { path: "desktop/src/new.ts", status: "added", sourceTool: "git status" },
      { path: "desktop/src/renamed.ts", status: "renamed", sourceTool: "git status" },
    ]);
  });

  it("extracts Codex-style structured file changes from tool output", () => {
    const turns: ChatTurn[] = [
      userTurn("codex changes"),
      toolTurn(
        "edit_file",
        { path: "desktop/src/App.tsx", old_string: "old", new_string: "new" },
        {
          changes: {
            "F:\\Agent\\Aris\\desktop\\src\\App.tsx": {
              type: "update",
              unified_diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
            },
            "F:\\Agent\\Aris\\desktop\\src\\new.ts": {
              type: "add",
              content: "new",
            },
          },
        },
      ),
    ];

    expect(latestFileChangesFromTurns(turns, "F:\\Agent\\Aris")).toEqual([
      { path: "desktop/src/App.tsx", status: "modified", sourceTool: "edit_file" },
      { path: "desktop/src/new.ts", status: "added", sourceTool: "edit_file" },
    ]);
  });
});

describe("WorkflowFlow", () => {
  it("shows the current step number and expands on click", async () => {
    const user = userEvent.setup();
    render(<WorkflowFlow todos={latestTodosFromTurns([todoTurn(SAMPLE)])} fileChanges={[]} bottomOffset={120} active />);

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

  it("renders nothing without todos or file changes", () => {
    const { container } = render(<WorkflowFlow todos={[]} fileChanges={[]} bottomOffset={120} active={false} />);
    expect(container.firstChild).toBeNull();
  });
});
