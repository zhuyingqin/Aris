import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = read("../paperGuideTokens.css");
const styles = read("../PaperGuideView.css");
const view = read("../PaperGuideView.tsx") + read("../PaperGuideDiagram.tsx");
const template = read("../../../../docs/design/paper-guide/template.html");

/** Declarations inside innermost blocks, comments removed. */
const declarations = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\{([^{}]*)\}/g)]
    .flatMap(([, body]) => body.split(";"))
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => {
      const colon = item.indexOf(":");
      return { property: item.slice(0, colon).trim(), value: item.slice(colon + 1).trim() };
    });

/** Replace token references (and calc() built from them) with a marker. */
const withoutTokens = (value: string) => {
  let result = value;
  for (let pass = 0; pass < 4; pass += 1) {
    result = result.replace(/var\(--[\w-]+(?:,[^()]*)?\)/g, "V").replace(/calc\([^()]*\)/g, "V");
  }
  return result;
};
const guideClasses = (source: string) => new Set(source.match(/paper-essay(?:-[a-z0-9]+)+/g) ?? []);

describe("paper guide format template", () => {
  it("styles components only through design tokens", () => {
    const rules = declarations(styles);
    const fontSizes = rules.filter(rule => rule.property === "font-size");
    expect(fontSizes.length).toBeGreaterThan(40);
    for (const rule of fontSizes) expect(rule.value, rule.value).toMatch(/^(var\(--essay-[\w-]+\)|[\d.]+em)$/);
    const spacing = rules.filter(rule => /^(margin|padding|gap|row-gap|column-gap|top)(-\w+)?$/.test(rule.property));
    for (const rule of spacing) {
      for (const part of withoutTokens(rule.value).split(/\s+/)) {
        expect(part, `${rule.property}: ${rule.value}`).toMatch(/^(V|0|auto|[1-3]px)$/);
      }
    }
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    const colored = rules.filter(rule => /color|background|border|outline|shadow/.test(rule.property));
    for (const rule of colored) expect(rule.value, `${rule.property}: ${rule.value}`).not.toMatch(/\b(white|black|red|green|blue|gray|grey)\b/i);
  });

  it("defines every token the components use", () => {
    const defined = new Set([...tokens.matchAll(/(--essay-[\w-]+)\s*:/g)].map(match => match[1]));
    const used = new Set([...styles.matchAll(/var\((--essay-[\w-]+)/g)].map(match => match[1]));
    expect([...used].filter(name => !defined.has(name))).toEqual([]);
    expect(styles).toMatch(/^[\s\S]*?@import "\.\/paperGuideTokens\.css";/);
  });

  it("keeps the static template in step with the rendered view", () => {
    const rendered = guideClasses(view);
    const shown = guideClasses(template);
    expect([...rendered].filter(name => !shown.has(name)), "classes missing from template.html").toEqual([]);
    expect([...shown].filter(name => !rendered.has(name)), "stale classes in template.html").toEqual([]);
    for (const sheet of ["styles.css", "PaperReadingPanel.css", "PaperGuideView.css"]) {
      expect(template).toContain(`${sheet}"`);
    }
    const chrome = template.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(chrome, "the template must not restyle guide components").not.toMatch(/paper-essay-/);
  });
});
