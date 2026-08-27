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
