import { describe, expect, it } from "vitest";
import type { ChatBlock, ChatTurn } from "../../types";
import { isFileChangeTool, latestFileChangesFromTurns } from "../model";
import { diffFromTool, fileChangesFromTurn } from "../toolSummaries";

describe("DOCX changes in Chat", () => {
  it("keeps the audited text patch and change id available for review and undo", () => {
    const patch = "--- report.docx\n+++ report.docx\n@@ -1 +1 @@\n-old [native equation 1]\n+new [native equation 1]";
    const block: ChatBlock = {
      kind: "tool", id: "docx-call", name: "edit_docx",
      input: JSON.stringify({ path: "papers/report.docx", expected_revision: "sha256:before" }),
      output: JSON.stringify({
        filePath: "papers/report.docx", revision: "sha256:after",
        appliedEdits: 1, preservedNativeEquations: 9, changeId: "docx-change",
        audit: {
          path: "papers/report.docx", sessionId: "session", turnId: "turn",
          changeIds: ["docx-change"], beforeHash: "before", afterHash: "after",
          beforeExists: true, afterExists: true, availability: "exact",
          unifiedDiff: patch, addedLines: 1, removedLines: 1,
        },
      }),
    };
    const turn: ChatTurn = { id: "turn", role: "assistant", blocks: [block] };
    expect(isFileChangeTool("edit_docx")).toBe(true);
    expect(latestFileChangesFromTurns([turn], "F:/Agent/Aris")).toEqual([
      { path: "papers/report.docx", status: "modified", sourceTool: "edit_docx" },
    ]);
    expect(diffFromTool(block)).toMatchObject({
      path: "papers/report.docx", diff: patch, diffAvailability: "exact", changeId: "docx-change",
    });
    expect(fileChangesFromTurn(turn)?.changeIds).toEqual(["docx-change"]);
  });
});
