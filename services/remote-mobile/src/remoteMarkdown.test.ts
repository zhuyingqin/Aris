import { describe, expect, it } from "vitest";

import { parseRemoteMarkdown } from "./remoteMarkdown";

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
});
