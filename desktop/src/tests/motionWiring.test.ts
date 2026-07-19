import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(__dirname, "../styles.css"), "utf8");

describe("ambient motion pass wiring", () => {
  it("applies entrance animations to nested view containers in normal flow", () => {
    for (const cls of [
      ".independent-review-panel",
      ".lit-overview",
      ".lit-pdf-reader",
      ".studio-web-preview",
      ".studio-review-workspace",
      ".kb-review",
      ".kb-confirmed",
    ]) {
      const rule = new RegExp(
        `${cls.replace(".", "\\.")}[\\s\\S]*?\\{[^}]*animation:\\s*sq-subpane-in`,
      );
      expect(styles, `${cls} should animate sq-subpane-in`).toMatch(rule);
    }
  });

  it("disables those same animations and the kb-graph-node transition under reduced motion", () => {
    const reduced = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const cls of [
      ".independent-review-panel",
      ".lit-overview",
      ".lit-pdf-reader",
      ".studio-web-preview",
      ".studio-review-workspace",
      ".kb-review",
      ".kb-confirmed",
      ".ext-overlay",
      ".ext-drawer",
      ".command-select",
    ]) {
      expect(reduced, `${cls} disabled under reduced motion`).toContain(cls);
    }
    expect(reduced).toContain(".kb-graph-node");
  });
});
