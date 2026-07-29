import { describe, expect, it } from "vitest";
import type { ChatAttachment, ChatTurn, DesktopProject } from "../../types";
import {
  cleanChatTitle,
  fileChangePathMatches,
  fuzzyScore,
  groupSessionsByProject,
  latestFileChangesFromTurns,
  latestTodosFromTurns,
  makeId,
  makeSession,
  migrateSession,
  parseToolBlockJson,
  patchLastAssistantTurn,
  titleFromTurns,
  transcriptFromTurn,
} from "../model";

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
  it("tracks NotebookEdit in the same file-change stream as file tools", () => {
    const changes = latestFileChangesFromTurns([
      userTurn("update notebook"),
      toolTurn(
        "NotebookEdit",
        {
          notebook_path: "notebooks/experiment.ipynb",
          cell_id: "cell-1",
          new_source: "print('updated')",
          edit_mode: "replace",
        },
        {
          notebook_path: "notebooks/experiment.ipynb",
          cell_id: "cell-1",
          edit_mode: "replace",
        },
      ),
    ]);

    expect(changes).toEqual([
      { path: "notebooks/experiment.ipynb", status: "modified", sourceTool: "NotebookEdit" },
    ]);
  });

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
      toolTurn(
        "multi_edit",
        {
          path: "desktop/src/store.ts",
          edits: [
            { old_string: "oldA", new_string: "newA" },
            { old_string: "oldB", new_string: "newB" },
          ],
        },
        { filePath: "F:\\Agent\\Aris\\desktop\\src\\store.ts", editsApplied: 2 },
      ),
      toolTurn(
        "append_file",
        { path: "slides/chapter3.tex", content: "\\begin{frame}\n" },
        { type: "append", filePath: "F:\\Agent\\Aris\\slides\\chapter3.tex", created: false },
      ),
    ];

    expect(latestFileChangesFromTurns(turns, "F:\\Agent\\Aris")).toEqual([
      { path: "desktop/src/new.ts", status: "added", sourceTool: "write_file" },
      { path: "desktop/src/App.tsx", status: "modified", sourceTool: "edit_file" },
      { path: "desktop/src/store.ts", status: "modified", sourceTool: "multi_edit" },
      { path: "slides/chapter3.tex", status: "modified", sourceTool: "append_file" },
    ]);
  });

  it("tracks a recompiled PDF as a file change via LaTeXCompile's outputPath", () => {
    const changes = latestFileChangesFromTurns(
      [
        userTurn("recompile the paper"),
        toolTurn(
          "LaTeXCompile",
          { path: "papers/main.tex" },
          {
            success: true,
            inputPath: "F:\\Agent\\Aris\\papers\\main.tex",
            outputPath: "F:\\Agent\\Aris\\papers\\main.pdf",
            engine: "latexmk",
          },
        ),
      ],
      "F:\\Agent\\Aris",
    );

    expect(changes).toEqual([
      { path: "papers/main.pdf", status: "modified", sourceTool: "LaTeXCompile" },
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

  it("extracts files changed by REPL write scripts", () => {
    const turns: ChatTurn[] = [
      userTurn("fix latex overflow"),
      toolTurn(
        "REPL",
        {
          language: "python",
          code: String.raw`
from pathlib import Path
p = r"C:\Users\wt\.config\aris\desktop-workspace\papers\longyoung\chap3_6_copper_foil_peers.tex"
with open(p, "w", encoding="utf-8") as f:
    f.write(updated)
Path(r"C:\Users\wt\.config\aris\desktop-workspace\papers\longyoung\chap4_valuation.tex").write_text(updated, encoding="utf-8")
Path(r"C:\Users\wt\.config\aris\desktop-workspace\papers\longyoung\report.pdf").read_bytes()
`,
        },
        { stdout: "fixed overflow" },
      ),
    ];

    expect(latestFileChangesFromTurns(turns, "C:\\Users\\wt\\.config\\aris\\desktop-workspace")).toEqual([
      { path: "papers/longyoung/chap3_6_copper_foil_peers.tex", status: "modified", sourceTool: "REPL" },
      { path: "papers/longyoung/chap4_valuation.tex", status: "modified", sourceTool: "REPL" },
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

describe("fileChangePathMatches", () => {
  it("matches a project-relative change against an already-open absolute side-panel path", () => {
    expect(
      fileChangePathMatches("papers/main.pdf", "F:\\Agent\\Aris\\papers\\main.pdf", "F:\\Agent\\Aris"),
    ).toBe(true);
  });

  it("is case-insensitive, matching Windows path conventions", () => {
    expect(
      fileChangePathMatches("Papers/Main.PDF", "f:\\agent\\aris\\papers\\main.pdf", "F:\\Agent\\Aris"),
    ).toBe(true);
  });

  it("does not match an unrelated open file", () => {
    expect(
      fileChangePathMatches("papers/main.pdf", "F:\\Agent\\Aris\\papers\\other.pdf", "F:\\Agent\\Aris"),
    ).toBe(false);
  });
});

describe("model chat helpers", () => {
  it("caches parsed tool JSON by immutable block identity", () => {
    const block = {
      kind: "tool" as const,
      name: "write_file",
      input: JSON.stringify({ path: "report.md", content: "large output" }),
      output: JSON.stringify({ filePath: "report.md" }),
    };

    const first = parseToolBlockJson(block, "output");
    const second = parseToolBlockJson(block, "output");

    expect(second).toBe(first);
  });

  it("scores direct slash-style abbreviations above weak subsequence matches", () => {
    const literature = fuzzyScore("lit", "research-lit literature paper search");
    const weak = fuzzyScore("lit", "utility cleanup");

    expect(literature).not.toBeNull();
    expect(weak).not.toBeNull();
    expect(literature ?? 999).toBeLessThan(weak ?? 999);
  });

  it("creates a streaming assistant turn when an event arrives before one exists", () => {
    const next = patchLastAssistantTurn(
      [{ id: "user-1", role: "user", blocks: [{ kind: "text", text: "Pick one" }] }],
      (turn) => ({
        ...turn,
        blocks: [
          ...turn.blocks,
          {
            kind: "tool",
            id: "ask-1",
            name: "AskUserQuestion",
            input: "{\"question\":\"Continue?\",\"options\":[{\"label\":\"Yes\"}]}",
          },
        ],
      }),
    );

    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      role: "assistant",
      streaming: true,
      blocks: [{ kind: "tool", id: "ask-1", name: "AskUserQuestion" }],
    });
  });

  it("serializes assistant tool blocks for exported transcripts", () => {
    const turn: ChatTurn = {
      id: "assistant-1",
      role: "assistant",
      blocks: [
        { kind: "text", text: "I checked the file." },
        { kind: "tool", id: "tool-1", name: "read_file", input: "{\"path\":\"README.md\"}", output: "README body" },
      ],
    };

    const transcript = transcriptFromTurn(turn);

    expect(transcript).toContain("I checked the file.");
    expect(transcript).toContain("[Tool call: read_file (tool-1)]");
    expect(transcript).toContain("README body");
  });
});

describe("project chat grouping", () => {
  const projects: DesktopProject[] = [
    { id: "project-a", name: "Alpha", path: "C:/Alpha", addedAt: 1, lastOpenedAt: 2 },
    { id: "project-b", name: "Beta", path: "C:/Beta", addedAt: 1, lastOpenedAt: 1 },
  ];

  it("migrates legacy chats to the default project", () => {
    expect(migrateSession({ title: "Legacy" }).projectId).toBe("default");
  });

  it("keeps a valid persisted backend context estimate", () => {
    expect(migrateSession({ contextTokens: 32_768 }).contextTokens).toBe(32_768);
    expect(migrateSession({ contextTokens: -1 }).contextTokens).toBeUndefined();
  });

  it("preserves a valid remote Agent session binding", () => {
    expect(migrateSession({
      remoteAgent: {
        nodeId: "node-a",
        nodeName: "Lab computer",
        projectId: "remote-project",
        projectName: "Protein study",
        sessionId: "remote-chat",
      },
    }).remoteAgent).toEqual({
      nodeId: "node-a",
      nodeName: "Lab computer",
      projectId: "remote-project",
      projectName: "Protein study",
      sessionId: "remote-chat",
    });
    expect(migrateSession({
      remoteAgent: {
        nodeId: "node-a",
        nodeName: "Lab computer",
      } as never,
    }).remoteAgent).toBeNull();
  });

  it("cleans generated titles before showing them in the sidebar", () => {
    expect(cleanChatTitle(
      "<think>\nThe user asked me to pick a title.\n</think>\nTitle: Chemistry Slides",
    )).toBe("Chemistry Slides");
    expect(cleanChatTitle("<think>The user asked me to pick a title")).toBe("");
    expect(cleanChatTitle("The user asked for help")).toBe("");
    expect(cleanChatTitle("Untitled")).toBe("");
    expect(cleanChatTitle("无主题")).toBe("");
  });

  it("falls back to the first user request when a stored title is unusable", () => {
    const turns: ChatTurn[] = [
      { id: "turn-user", role: "user", blocks: [{ kind: "text", text: "选择化学论文 slides 制作" }] },
      { id: "turn-assistant", role: "assistant", blocks: [{ kind: "text", text: "可以。" }] },
    ];

    expect(titleFromTurns(turns)).toBe("选择化学论文 slides 制作");
    expect(migrateSession({ title: "<think>The user asked me", turns }).title)
      .toBe("选择化学论文 slides 制作");
    expect(migrateSession({ title: "The user asked for help", turns }).title)
      .toBe("选择化学论文 slides 制作");
    expect(migrateSession({ title: "无主题", turns }).title)
      .toBe("选择化学论文 slides 制作");
  });

  it("uses attached file context when the first user turn has no typed title", () => {
    const attachment: ChatAttachment = {
      id: "att-report",
      kind: "file",
      name: "analysis-report.md",
      path: "docs/analysis-report.md",
    };
    const turns: ChatTurn[] = [
      {
        id: "turn-user",
        role: "user",
        blocks: [{ kind: "text", text: "Attached context" }],
        attachments: [attachment],
      },
      { id: "turn-assistant", role: "assistant", blocks: [{ kind: "text", text: "收到。" }] },
    ];

    expect(titleFromTurns(turns)).toBe("docs/analysis-report.md");
    expect(migrateSession({ title: "Untitled", turns }).title).toBe("docs/analysis-report.md");
  });

  it("groups chats by project instead of date", () => {
    const alpha = { ...makeSession("project-a"), title: "Alpha chat" };
    const beta = { ...makeSession("project-b"), title: "Beta chat" };

    const groups = groupSessionsByProject([beta, alpha], projects);

    expect(groups.map((group) => group.label)).toEqual(["Alpha", "Beta"]);
    expect(groups[0].sessions[0].projectId).toBe("project-a");
  });
});
