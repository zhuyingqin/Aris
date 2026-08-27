import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appStyles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");

describe("Markdown Light theme", () => {
  it("uses light surfaces for fenced code blocks", () => {
    expect(appStyles).toMatch(
      /:root\[data-theme="light"\] \.md-code-block\s*\{[^}]*background:\s*#f8fafc;/s,
    );
    expect(appStyles).toMatch(
      /:root\[data-theme="light"\] \.md-code-header\s*\{[^}]*background:\s*var\(--bg-2\);/s,
    );
    expect(appStyles).toMatch(
      /:root\[data-theme="light"\] \.md-code-gutter\s*\{[^}]*background:\s*#f1f5f9;/s,
    );
  });

  it("overrides the imported dark syntax palette in Light mode", () => {
    expect(appStyles).toContain(':root[data-theme="light"] .md-code-block :is(');
    expect(appStyles).toMatch(
      /:root\[data-theme="light"\] \.md-code-block \.hljs-addition\s*\{[^}]*background-color:\s*#f0fff4;/s,
    );
    expect(appStyles).toMatch(
      /:root\[data-theme="light"\] \.md-code-block \.hljs-deletion\s*\{[^}]*background-color:\s*#ffeef0;/s,
    );
  });
});
