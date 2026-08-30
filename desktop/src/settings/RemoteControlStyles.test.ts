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

  it("keeps the Add and Connect device actions aligned and readable while busy", () => {
    const actionRule = appStyles.match(/\.sp-settings-page \.sp-remote-device-action\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(actionRule).toMatch(/width:\s*140px/);
    expect(actionRule).toMatch(/min-width:\s*140px/);
    expect(actionRule).toMatch(/height:\s*38px/);
    expect(actionRule).toMatch(/min-height:\s*38px/);

    const disabledRule = appStyles.match(/\.sp-settings-page \.sp-remote-device-action:disabled\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(disabledRule).toMatch(/opacity:\s*1/);
    expect(disabledRule).toMatch(/background:/);
    expect(disabledRule).toMatch(/color:\s*var\(--settings-text\)/);
  });

  it("keeps the standalone remote approval dialog readable outside the settings scope", () => {
    const dialogRule = appStyles.match(/\.sp-remote-approval-dialog\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(dialogRule).toMatch(/background:\s*var\(--settings-surface,\s*var\(--bg-1\)\)/);
    expect(dialogRule).toMatch(/color:\s*var\(--settings-text,\s*var\(--text\)\)/);
    expect(dialogRule).toMatch(/--settings-border,\s*var\(--border\)/);

    const detailsRule = appStyles.match(/\.sp-remote-approval-details\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(detailsRule).toMatch(/background:\s*var\(--settings-surface-2,\s*var\(--bg-2\)\)/);
    expect(detailsRule).toMatch(/border:\s*1px\s+solid\s+var\(--settings-border,\s*var\(--border\)\)/);
  });
});
