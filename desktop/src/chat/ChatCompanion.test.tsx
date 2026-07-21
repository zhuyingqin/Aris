import { describe, expect, it } from "vitest";
import { isChatCompanionMode } from "./ChatCompanion";

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
