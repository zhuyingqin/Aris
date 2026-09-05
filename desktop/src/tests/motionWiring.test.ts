import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(__dirname, "../styles.css"), "utf8");

/**
 * Only the accessibility half of this file survives.
 *
 * The other case asserted that five specific panels animate with one specific
 * keyframe name, which locked a styling choice: renaming the animation or
 * giving a panel a different entrance broke the suite while nothing had
 * regressed. Honouring `prefers-reduced-motion` is not a styling choice — a
 * panel that keeps animating there is a real defect for the people who set it.
 */
describe("ambient motion pass wiring", () => {
  it("disables entrance animations and the kb-graph-node transition under reduced motion", () => {
    const reduced = styles.slice(styles.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const cls of [
      ".independent-review-panel",
      ".lit-overview",
      ".lit-pdf-reader",
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
