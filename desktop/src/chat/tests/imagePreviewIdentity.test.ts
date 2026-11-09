import { describe, expect, it } from "vitest";
import { imagePreviewKey } from "../imagePreviewIdentity";

describe("image preview identity", () => {
  it("matches Windows relative, absolute, URI, encoded and editor-location aliases", () => {
    const sources = ["./figures/../figures/plot%20one.png", "D:\\work\\figures\\plot one.png",
      "file:///D:/WORK/figures/plot%20one.png", "vscode://file/D:/work/figures/plot%20one.png:12:3",
      "//?/D:/work/figures/plot one.png#L12"];
    expect(new Set(sources.map((source) => imagePreviewKey(source, "D:/work"))).size).toBe(1);
  });

  it("keeps different projects, POSIX case, URL query variants and embedded image bytes distinct", () => {
    expect(imagePreviewKey("plot.png", "D:/first")).not.toBe(imagePreviewKey("plot.png", "D:/second"));
    expect(imagePreviewKey("Plot.png", "/work")).not.toBe(imagePreviewKey("plot.png", "/work"));
    expect(imagePreviewKey("https://example.com/plot.png?v=1", null)).not.toBe(imagePreviewKey("https://example.com/plot.png?v=2", null));
    expect(imagePreviewKey("data:image/png;base64,AAA", null)).not.toBe(imagePreviewKey("data:image/png;base64,aaa", null));
  });
});
