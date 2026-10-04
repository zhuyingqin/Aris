import type { Plugin } from "postcss";

const FONT_PROPERTIES = new Set(["font-size", "font", "line-height"]);
const FONT_TOKEN = /^--(?:[\w-]*font(?:-[\w-]+)?|[\w-]*text-(?:label|caption|meta|compact|dense|body|h[1-6]|deck|lead|arrow)|[\w-]*line-height|st-(?:title|body|small|meta))$/;
const PDF_GEOMETRY = /--(?:font-height|total-scale-factor|scale-factor)/;

/** Normalize only authored typography. Layout pixels, PDF text geometry, and
 * third-party styles stay in their original coordinate systems. */
export function uiTypographyPostcss(): Plugin {
  return {
    postcssPlugin: "somniq-ui-typography",
    Once(root) {
      const file = root.source?.input.file?.replace(/\\/g, "/") ?? "";
      if (!file.includes("/src/") || file.includes("/node_modules/")) return;
      const fontTokens = new Set<string>();
      root.walkDecls((decl) => {
        if (FONT_PROPERTIES.has(decl.prop) && !PDF_GEOMETRY.test(decl.value)) {
          for (const match of decl.value.matchAll(/var\(\s*(--[\w-]+)/g)) fontTokens.add(match[1]);
        }
      });
      root.walkDecls((decl) => {
        if ((!FONT_PROPERTIES.has(decl.prop) && !FONT_TOKEN.test(decl.prop) && !fontTokens.has(decl.prop)) || PDF_GEOMETRY.test(decl.prop) || PDF_GEOMETRY.test(decl.value)) return;
        decl.value = decl.value.replace(/(-?\d*\.?\d+)px\b/g, (_, pixels: string) => `${Number(pixels) / 16}rem`);
      });
    },
  };
}
