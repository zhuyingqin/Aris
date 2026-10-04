import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { uiTypographyPostcss } from "../uiTypographyPostcss";

async function convert(css: string, from = "/workspace/desktop/src/styles.css") {
  return (await postcss([uiTypographyPostcss()]).process(css, { from })).css;
}

describe("UI typography CSS", () => {
  it("scales authored typography, font shorthands, and referenced tokens while keeping layout coordinates", async () => {
    const result = await convert(".ui { --caption: 12px; --lit-font-body: 14px; width: 240px; padding: 8px; font-size: var(--caption, 12px); line-height: 20px; } .code { font: 600 13px/1.5 monospace; }");
    expect(result).toContain("--caption: 0.75rem");
    expect(result).toContain("--lit-font-body: 0.875rem");
    expect(result).toContain("width: 240px");
    expect(result).toContain("padding: 8px");
    expect(result).toContain("font-size: var(--caption, 0.75rem)");
    expect(result).toContain("line-height: 1.25rem");
    expect(result).toContain("font: 600 0.8125rem/1.5 monospace");
    expect(await convert(result)).toBe(result);
  });

  it("preserves PDF geometry and third-party font rules", async () => {
    const pdf = ".textLayer { --font-height: 12px; font-size: calc(var(--font-height, 1px) * var(--total-scale-factor, 1)); }";
    expect(await convert(pdf)).toBe(pdf);
    const vendor = ".editor { font-size: 13px; }";
    expect(await convert(vendor, "/workspace/node_modules/editor/src/editor.css")).toBe(vendor);
  });
});
