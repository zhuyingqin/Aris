import { describe, expect, it } from "vitest";
import { editorMessage } from "./editorBridge";

describe("figure editor isolation", () => {
  const frame = {} as Window;
  const message = (data: unknown, source = frame) => ({ data, source } as MessageEvent);
  it("rejects another window, another channel and native-operation requests", () => {
    expect(editorMessage(message({ channel: "figure", type: "ready" }, {} as Window), frame, "figure")).toBeNull();
    expect(editorMessage(message({ channel: "other", type: "ready" }), frame, "figure")).toBeNull();
    expect(editorMessage(message({ channel: "figure", type: "invoke", command: "file_write" }), frame, "figure")).toBeNull();
    expect(editorMessage(message({ channel: "figure", type: "serialized", svg: "x".repeat(2 * 1024 * 1024 + 1) }), frame, "figure")).toBeNull();
  });
  it("accepts a bounded SVG response from this frame", () => {
    expect(editorMessage(message({ channel: "figure", type: "serialized", requestId: "1", svg: "<svg/>" }), frame, "figure")?.svg).toBe("<svg/>");
  });
});
