import { describe, expect, it } from "vitest";

import { parseRemoteMarkdown, safeRemoteUrl } from "./remoteMarkdown";

describe("parseRemoteMarkdown", () => {
  it("keeps headings, report lists, and fenced evidence blocks distinct", () => {
    expect(parseRemoteMarkdown("## 审查结论\n\n- **问题**：证据不足\n- 路径：`review.tex`\n\n```text\nMajor revision\n```"))
      .toEqual([
        { kind: "heading", level: 2, text: "审查结论" },
        { kind: "unordered_list", items: ["**问题**：证据不足", "路径：`review.tex`"] },
        { kind: "code", language: "text", text: "Major revision" },
      ]);
  });

  it("preserves ordered work items and paragraphs", () => {
    expect(parseRemoteMarkdown("1. 复核证据\n2. 修改论文\n\n结论已经记录。"))
      .toEqual([
        { kind: "ordered_list", items: ["复核证据", "修改论文"] },
        { kind: "paragraph", text: "结论已经记录。" },
      ]);
  });

  it("does not interpret ordinary HTML-like content as markup", () => {
    expect(parseRemoteMarkdown("<script>alert(1)</script>"))
      .toEqual([{ kind: "paragraph", text: "<script>alert(1)</script>" }]);
  });

  it("keeps task state and GFM-style tables as structured safe content", () => {
    expect(parseRemoteMarkdown("- [x] 已完成实验\n- [ ] *复核*结果\n\n| 项目 | 状态 |\n| --- | :---: |\n| 论文 | ~~待定~~ **完成** |"))
      .toEqual([
        {
          kind: "task_list",
          ordered: false,
          items: [
            { text: "已完成实验", checked: true },
            { text: "*复核*结果", checked: false },
          ],
        },
        {
          kind: "table",
          headers: ["项目", "状态"],
          rows: [["论文", "~~待定~~ **完成**"]],
        },
      ]);
  });

  it("only permits absolute HTTP(S) links and images", () => {
    expect(safeRemoteUrl("https://example.com/image.png")).toBe("https://example.com/image.png");
    expect(safeRemoteUrl("http://example.com/report")).toBe("http://example.com/report");
    expect(safeRemoteUrl("javascript:alert(1)")).toBeNull();
    expect(safeRemoteUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeRemoteUrl("/relative/image.png")).toBeNull();
  });
});
