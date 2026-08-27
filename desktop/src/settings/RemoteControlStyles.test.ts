import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("Remote control capability layout", () => {
  it("keeps every capability switch in a fixed right-hand grid column", () => {
    const rules = [...appStyles.matchAll(/\.sp-remote-capability-toggle\s*\{([^}]*)\}/gs)];
    const finalRule = rules.at(-1)?.[1] ?? "";

    expect(finalRule).toMatch(/display:\s*grid/);
    expect(finalRule).toMatch(
      /grid-template-columns:\s*32px\s+minmax\(0,\s*1fr\)\s+auto/,
    );
    expect(finalRule).toMatch(/align-items:\s*center/);
  });

  it("does not replace the dedicated icon and copy layouts with a generic span rule", () => {
    expect(appStyles).not.toMatch(/\.sp-remote-capability-toggle\s+span\s*\{/);
  });
});
