import { describe, expect, it } from "vitest";

import { somniqWorkbenchColors, toVsCodeColor } from "./codeTheme";

/** Stands in for `getComputedStyle(:root)`, which is what ships this in the app. */
const reader = (tokens: Record<string, string>) => (token: string) => tokens[token] ?? "";

describe("toVsCodeColor", () => {
  it("passes through the hex forms VS Code accepts", () => {
    expect(toVsCodeColor("#0e1116")).toBe("#0e1116");
    expect(toVsCodeColor("  #FFF  ")).toBe("#fff");
    expect(toVsCodeColor("#12345678")).toBe("#12345678");
  });

  it("converts computed rgb values to hex", () => {
    expect(toVsCodeColor("rgb(14, 17, 22)")).toBe("#0e1116");
    expect(toVsCodeColor("rgb(255 255 255)")).toBe("#ffffff");
  });

  it("carries alpha through, and drops it when fully opaque", () => {
    expect(toVsCodeColor("rgba(0, 0, 0, 0.5)")).toBe("#00000080");
    expect(toVsCodeColor("rgba(0, 0, 0, 1)")).toBe("#000000");
  });

  it("clamps channels rather than emitting an out-of-range hex", () => {
    expect(toVsCodeColor("rgb(300, -20, 17)")).toBe("#ff0011");
  });

  /// An unparseable value written into `colorCustomizations` is not ignored
  /// per key: VS Code rejects the whole customisation.
  it("rejects anything it cannot turn into a hex colour", () => {
    expect(toVsCodeColor("")).toBeNull();
    expect(toVsCodeColor("   ")).toBeNull();
    expect(toVsCodeColor("color-mix(in srgb, var(--bg-2) 88%, #000 12%)")).toBeNull();
    expect(toVsCodeColor("var(--bg)")).toBeNull();
    expect(toVsCodeColor("#12345")).toBeNull();
  });
});

describe("somniqWorkbenchColors", () => {
  const dark = {
    "--bg": "#0e1116",
    "--bg-1": "#151a21",
    "--bg-2": "#1c232c",
    "--bg-3": "#232c37",
    "--border": "#2b3440",
    "--text": "#d7dee7",
    "--text-dim": "#8a97a6",
    "--accent": "#4f9cf9",
    "--red": "#f85149",
    "--amber": "#d29922",
    "--green": "#3fb950",
  };

  it("maps the app's surfaces onto the workbench's", () => {
    const colors = somniqWorkbenchColors(reader(dark));

    expect(colors["editor.background"]).toBe("#0e1116");
    expect(colors["sideBar.background"]).toBe("#151a21");
    expect(colors["input.background"]).toBe("#1c232c");
    expect(colors["list.activeSelectionBackground"]).toBe("#232c37");
    expect(colors["editor.foreground"]).toBe("#d7dee7");
    expect(colors["statusBar.foreground"]).toBe("#8a97a6");
    expect(colors["focusBorder"]).toBe("#4f9cf9");
    expect(colors["errorForeground"]).toBe("#f85149");
  });

  it("reads the theme that is live rather than a baked-in palette", () => {
    const light = somniqWorkbenchColors(reader({ ...dark, "--bg": "#f4f6f8" }));
    expect(light["editor.background"]).toBe("#f4f6f8");
  });

  /// Syntax colours come from the base Dark+/Light+ theme, which is what the
  /// app's own `--code-*` tokens already are. Customising them here would be a
  /// second copy to keep in sync for no gain.
  it("does not touch syntax highlighting", () => {
    const colors = somniqWorkbenchColors(reader(dark));
    expect(Object.keys(colors).some((key) => key.startsWith("editor.token"))).toBe(false);
    expect(colors["textMateRules"]).toBeUndefined();
  });

  it("skips tokens it cannot resolve instead of guessing", () => {
    const colors = somniqWorkbenchColors(
      reader({ ...dark, "--accent": "color-mix(in srgb, red 50%, blue)" }),
    );

    expect(colors["editor.background"]).toBe("#0e1116");
    expect(colors["focusBorder"]).toBeUndefined();
    expect(colors["button.background"]).toBeUndefined();
  });

  /// Sending only the fixed foregrounds would recolour badges to white on the
  /// stock background and read as a rendering bug.
  it("sends nothing at all when no token resolves", () => {
    expect(somniqWorkbenchColors(() => "")).toEqual({});
  });

  it("pairs the accent with a foreground that reads on it", () => {
    const colors = somniqWorkbenchColors(reader(dark));
    expect(colors["button.background"]).toBe("#4f9cf9");
    expect(colors["button.foreground"]).toBe("#ffffff");
  });

  it("emits only values VS Code can parse", () => {
    for (const value of Object.values(somniqWorkbenchColors(reader(dark)))) {
      expect(value).toMatch(/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    }
  });
});
