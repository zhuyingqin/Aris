import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const finalScheduledStyles = appStyles.slice(
  appStyles.lastIndexOf("/* Scheduled tasks final order overrides */"),
);

describe("Scheduled tasks workspace layout", () => {
  it("anchors the action footer to the editor pane instead of the app window", () => {
    const pageRule =
      finalScheduledStyles.match(/\.sched-page\s*\{([^}]*)\}/s)?.[1] ?? "";
    const shellRule =
      finalScheduledStyles.match(
        /\.sched-shell\s*\{[^}]*grid-template-columns:\s*minmax\(320px,\s*var\(--sched-sidebar-width\)\)[^}]*\}/s,
      )?.[0] ?? "";
    const editorRule =
      finalScheduledStyles.match(
        /\.sched-editor\s*\{[^}]*position:\s*relative;[^}]*\}/s,
      )?.[0] ?? "";
    const footerRule =
      finalScheduledStyles.match(
        /\.sched-action-footer\s*\{[^}]*position:\s*absolute;[^}]*\}/s,
      )?.[0] ?? "";

    expect(pageRule).toMatch(/--sched-sidebar-width:\s*505px/);
    expect(pageRule).toMatch(/position:\s*relative/);
    expect(shellRule).toMatch(
      /grid-template-columns:\s*minmax\(320px,\s*var\(--sched-sidebar-width\)\)\s+minmax\(0,\s*1fr\)/,
    );
    expect(editorRule).toMatch(/position:\s*relative/);
    expect(footerRule).toMatch(/position:\s*absolute/);
    expect(footerRule).toMatch(/left:\s*0/);
    expect(footerRule).toMatch(/right:\s*0/);
  });
});
