import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const literatureCss = readFileSync(
  new URL("../Literature.css", import.meta.url),
  "utf8",
);

describe("PDF text-layer selection styling", () => {
  it("keeps PDF.js structural nodes from painting selection fragments at the page edge", () => {
    expect(literatureCss).toMatch(
      /\.lit-pdf-text-layer \.markedContent\s*{[^}]*display:\s*contents;/s,
    );
    expect(literatureCss).toMatch(
      /\.lit-pdf-text-layer br::selection\s*{[^}]*background:\s*transparent;/s,
    );
  });

  it("centers the rail icons in generous targets and keeps the page field compact", () => {
    expect(literatureCss).toMatch(
      /\.lit-pdf-toolbar button\s*{[^}]*display:\s*inline-flex;[^}]*height:\s*44px;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s,
    );
    expect(literatureCss).toMatch(
      /\.lit-pdf-page-input input\s*{[^}]*box-sizing:\s*border-box;[^}]*height:\s*30px;/s,
    );
  });

  it("floats the PDF toolbar vertically instead of taking a horizontal row", () => {
    expect(literatureCss).toMatch(
      /\.lit-pdf-reader\s*{[^}]*position:\s*relative;/s,
    );
    expect(literatureCss).toMatch(
      /\.lit-pdf-toolbar\s*{[^}]*position:\s*absolute;[^}]*flex-direction:\s*column;/s,
    );
  });
});
