import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE_SPEC, LEGACY_STYLES, STYLE_FAMILIES, STYLE_LAYOUTS, STYLE_PALETTES, STYLE_DENSITIES,
  compileFigureStyle, parseFigureStyle, styleLabel } from "./figureStyles";

describe("persisted scientific style contracts", () => {
  it("round-trips every supported combination within the native UTF-8 limit", () => {
    for (const family of STYLE_FAMILIES) for (const layout of STYLE_LAYOUTS) for (const palette of STYLE_PALETTES)
      for (const density of STYLE_DENSITIES) for (const print of [false, true]) {
        const spec = { family: family.key, layout: layout.key, palette: palette.key, density: density.key, print };
        const stored = JSON.parse(JSON.stringify({ style: compileFigureStyle(spec) })).style;
        expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(2000);
        expect(parseFigureStyle(stored)).toEqual(spec);
      }
  });
  it("keeps readable rules in the stored value and source fidelity above appearance", () => {
    for (const family of STYLE_FAMILIES) {
      const value = compileFigureStyle({ ...DEFAULT_STYLE_SPEC, family: family.key });
      expect(value).toContain(family.rules);
      expect(value).toContain("Typography:");
      expect(value).toContain("explicit scientific requirements override visual preferences");
      expect(value).toContain("approved image/current document is authoritative");
      expect(value).toContain("never invent data or claims");
    }
  });
  it("reads old presets without replacing their stored prompt or displayed names", () => {
    for (const legacy of LEGACY_STYLES) {
      const before = legacy.value;
      expect(parseFigureStyle(before)).toEqual(legacy.spec);
      expect(styleLabel(before, "cn")).toBe(legacy.label[0]);
      expect(styleLabel(before, "en")).toBe(legacy.label[1]);
      expect(legacy.value).toBe(before);
    }
  });
  it("preserves custom text, invalid fields and future versions instead of resetting them", () => {
    const valid = compileFigureStyle(DEFAULT_STYLE_SPEC);
    for (const unknown of ["hand-drawn sketch", valid.replace("style v1:", "style v2:"),
      valid.replace("family=schematic", "family=unknown"), valid.replace("palette=muted", "palette=unknown"),
      valid.replace("layout=auto", "layout=unknown"), valid.replace("density=balanced", "density=unknown"), valid.replace("print=off", "print=maybe")]) {
      expect(parseFigureStyle(unknown)).toBeNull();
      expect(styleLabel(unknown, "en")).toBe(unknown);
    }
  });
  it("names modified contracts by family and output choices rather than raw prompt text", () => {
    const value = compileFigureStyle({ ...DEFAULT_STYLE_SPEC, family: "tensors", layout: "vertical", palette: "mono", density: "compact", print: true });
    expect(styleLabel(value, "cn")).toBe("张量与空间 · 黑白灰 · 印刷适配");
    expect(styleLabel(value, "en")).toBe("Tensor & spatial · Grayscale · Print ready");
  });
});
