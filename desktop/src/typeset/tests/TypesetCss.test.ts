import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const typesetCss = readFileSync(
  new URL("../Typeset.css", import.meta.url),
  "utf8",
);
const latexHighlighting = readFileSync(
  new URL("../../editor/latexVscodeHighlighting.ts", import.meta.url),
  "utf8",
);

describe("Typeset compile-log control alignment", () => {
  it("centers diagnostic actions without inherited button padding", () => {
    expect(typesetCss).toMatch(
      /\.typeset-diagnostic-summary\s*{[^}]*align-items:\s*center;/s,
    );
    expect(typesetCss).toMatch(
      /\.typeset-diagnostic-expand\s*{[^}]*place-items:\s*center;[^}]*padding:\s*0;/s,
    );
    expect(typesetCss).toMatch(
      /\.typeset-diagnostic-locate,\s*\.typeset-diagnostic-copy-btn\s*{[^}]*place-items:\s*center;[^}]*padding:\s*0;/s,
    );
  });

  it("rotates only disclosure chevrons, not nested copy icons", () => {
    expect(typesetCss).toContain(".typeset-raw-logs summary > svg");
    expect(typesetCss).not.toContain(".typeset-raw-logs summary svg,");
  });
});

describe("Typeset review decision styling", () => {
  function rule(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return typesetCss.match(new RegExp(`${escaped}\\s*{([^}]*)}`, "s"))?.[1] ?? "";
  }

  it("never dims a decided line, because the line wraps its own accept/reject controls", () => {
    // A CodeMirror line decoration is an ancestor of the inline hunk controls,
    // so `opacity` here multiplies into them. At the .58 this rule used to
    // carry, a rejected hunk's buttons rendered within a hair of the .55 this
    // file uses for `:disabled` — the "accept" that undoes the rejection looked
    // unclickable. Contrast belongs on background and rule colour.
    const rejected = rule(".typeset-editor-body .cm-diff-line.cm-diff-added.cm-diff-decision-reject");
    expect(rejected).toContain("line-through");
    expect(rejected).not.toContain("opacity");
    expect(rule(".typeset-editor-body .cm-diff-line.cm-diff-added.cm-diff-decision-accept"))
      .not.toContain("opacity");
    expect(typesetCss).toMatch(
      /\.cm-diff-decision-reject \.cm-review-hunk-controls[^{]*{[^}]*text-decoration:\s*none/s,
    );
  });

  it("keeps a Beamer frame's own side borders on a decided line", () => {
    // `.cm-line.cm-vis-frame-line` draws the slide edge in `box-shadow`, and
    // box-shadow replaces rather than merges.
    expect(typesetCss).toContain(".cm-diff-decision-accept:not(.cm-vis-frame-line)");
    expect(typesetCss).toContain(".cm-diff-decision-reject:not(.cm-vis-frame-line)");
  });
});

describe("Typeset LaTeX editor theme", () => {
  it("uses inherited theme variables for the CodeMirror canvas and syntax tokens", () => {
    expect(typesetCss).toMatch(
      /\.code-editor\.typeset-latex-vscode \.cm-scroller\s*{[^}]*background:\s*var\(--typeset-code-bg\)/s,
    );
    expect(typesetCss).toMatch(
      /\.code-editor\.typeset-latex-vscode \.cm-gutters\s*{[^}]*background:\s*var\(--typeset-code-gutter-bg\)/s,
    );
    expect(latexHighlighting).toContain('color: "var(--typeset-code-keyword)"');
    expect(latexHighlighting).not.toMatch(/color:\s*"#[0-9a-f]+"/i);
  });

  it("defines a complete light canvas and Light+ token palette", () => {
    const lightRule = typesetCss.match(
      /:root\[data-theme="light"\] \.typeset-editor-body \.code-editor\.typeset-latex-vscode\s*{([^}]*)}/s,
    )?.[1];
    expect(lightRule).toBeDefined();
    expect(lightRule).toContain("--typeset-code-bg: #ffffff");
    expect(lightRule).toContain("--typeset-code-fg: #1f1f1f");
    expect(lightRule).toContain("--typeset-code-gutter-bg: #f7f7f7");
    expect(lightRule).toContain("--typeset-code-keyword: var(--code-func)");
    expect(lightRule).toContain("--typeset-code-comment: var(--code-comment)");
  });
});

describe("Typeset embedded AI assistant layout", () => {
  it("uses the shared Chat surface as a compact single-column host", () => {
    expect(typesetCss).toMatch(
      /\.typeset-ai-chat-host\s*{[^}]*container-type:\s*inline-size;/s,
    );
    expect(typesetCss).toMatch(
      /\.typeset-ai-chat-host\s*>\s*\.chat-root\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(typesetCss).toMatch(
      /\.typeset-ai-chat-host \.chat-welcome-mark\s*{[^}]*display:\s*none;/s,
    );
  });

  it("keeps starter cards readable in the narrow project rail", () => {
    expect(typesetCss).toMatch(
      /\.typeset-ai-chat-host \.chat-starters\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s,
    );
    expect(typesetCss).toMatch(
      /\.typeset-ai-chat-host \.chat-starter-label\s*{[^}]*white-space:\s*nowrap;/s,
    );
    const extraTightRule = typesetCss.match(
      /@container\s*\(max-width:\s*280px\)\s*{([\s\S]*?)\/\* Common Header/,
    )?.[1];
    expect(extraTightRule).toBeDefined();
    expect(extraTightRule).toContain(".typeset-ai-chat-host .chat-input-footer");
    expect(extraTightRule).toMatch(/flex-wrap:\s*wrap;/);
  });
});

describe("Typeset unified review dock layout", () => {
  it("uses display: contents for external review in docked-unified mode so drawer wraps full width", () => {
    expect(typesetCss).toMatch(
      /\.typeset-review-dock\.docked-unified \.typeset-external-review\s*{[^}]*display:\s*contents;/s,
    );
    expect(typesetCss).toMatch(
      /\.typeset-review-dock\.docked-unified \.typeset-external-review-drawer\s*{[^}]*flex:\s*1 0 100%;[^}]*width:\s*100%;/s,
    );
  });
});
