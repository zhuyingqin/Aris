import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflowCss = readFileSync(
  new URL("../Workflows.css", import.meta.url),
  "utf8",
);

/**
 * Only the rule that survives a restyle.
 *
 * This file used to also pin the font stack (`--wf-font-sans: "Noto Sans SC"`)
 * and individual layout declarations (`min-width: 96px;`, `flex: 1 1 auto;`) by
 * exact string. Renaming a class or nudging a width broke them without any
 * regression having happened, which is the opposite of what a test should cost.
 * A readable minimum size is different: it is a requirement, not a value chosen
 * on the day.
 */
describe("Workflow typography", () => {
  it("does not render readable Workflow text below the metadata baseline", () => {
    const undersizedFontDeclarations = [...workflowCss.matchAll(
      /font(?:-size)?:\s*(?:\d+\s+)?(\d+(?:\.\d+)?)px/g,
    )].filter((match) => Number(match[1]) < 11);

    expect(undersizedFontDeclarations).toEqual([]);
  });
});
