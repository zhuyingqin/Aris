import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isChatCompanionMode } from "./ChatCompanion";

const appStyles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("isChatCompanionMode", () => {
  it("recognizes the dedicated Chat companion query", () => {
    expect(isChatCompanionMode("?companion=chat")).toBe(true);
    expect(isChatCompanionMode("?theme=dark&companion=chat")).toBe(true);
  });

  it("recognizes the native companion window by label without a query", () => {
    expect(isChatCompanionMode("", "chat-companion")).toBe(true);
  });

  it("leaves normal and unrelated windows on the main app route", () => {
    expect(isChatCompanionMode("")).toBe(false);
    expect(isChatCompanionMode("?companion=typeset")).toBe(false);
  });
});

describe("Chat companion theme contract", () => {
  it("defines the sidebar palette on the shared Chat root instead of requiring the main app shell", () => {
    expect(appStyles).toMatch(
      /\.chat-root\s*{[^}]*--chat-sidebar-bg:\s*#101720;/s,
    );
    expect(appStyles).toMatch(
      /:root\[data-theme="light"\] \.chat-root\s*{[^}]*--chat-sidebar-bg:\s*#f8fafc;/s,
    );
  });
});
