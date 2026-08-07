import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowCss = readFileSync(
  new URL("../Workflows.css", import.meta.url),
  "utf8",
);

describe("Workflow typography", () => {
  it("uses a CJK-friendly sans baseline and reserves monospace for technical content", () => {
    expect(workflowCss).toContain('--wf-font-sans: "Noto Sans SC"');
    expect(workflowCss).toContain("font-family: var(--wf-font-sans);");
    expect(workflowCss).toContain(".wf-query-editor textarea {");
    expect(workflowCss).toContain("var(--wf-font-mono)");
    expect(workflowCss).not.toContain("ui-monospace, monospace");
  });

  it("does not render readable Workflow text below the metadata baseline", () => {
    const undersizedFontDeclarations = [...workflowCss.matchAll(
      /font(?:-size)?:\s*(?:\d+\s+)?(\d+(?:\.\d+)?)px/g,
    )].filter((match) => Number(match[1]) < 11);

    expect(undersizedFontDeclarations).toEqual([]);
  });

  it("keeps direction-selection actions readable beside long CJK content", () => {
    expect(workflowCss).toContain(".wf-direction-list article > div {");
    expect(workflowCss).toContain("flex: 1 1 auto;");
    expect(workflowCss).toContain(".wf-direction-select {");
    expect(workflowCss).toContain("min-width: 96px;");
    expect(workflowCss).toContain("white-space: nowrap;");
  });
});
