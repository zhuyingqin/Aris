import { describe, expect, it } from "vitest";
import { canDropOn, moveDestination, remapExpandedPaths } from "../treeMove";

describe("moveDestination", () => {
  it("moves an entry into the folder it was dropped on", () => {
    expect(moveDestination("chapters/ch2.tex", { path: "appendix", isDir: true })).toBe("appendix/ch2.tex");
    expect(moveDestination("ch2.tex", { path: "chapters", isDir: true })).toBe("chapters/ch2.tex");
  });

  it("treats a drop on a file as a drop into that file's folder", () => {
    expect(moveDestination("ch2.tex", { path: "chapters/ch1.tex", isDir: false })).toBe("chapters/ch2.tex");
  });

  it("moves an entry to the project root when dropped there", () => {
    expect(moveDestination("chapters/ch2.tex", { path: "", isDir: true })).toBe("ch2.tex");
  });

  it("refuses a drop that would change nothing", () => {
    expect(moveDestination("chapters/ch2.tex", { path: "chapters", isDir: true })).toBeNull();
    expect(moveDestination("chapters/ch2.tex", { path: "chapters/ch1.tex", isDir: false })).toBeNull();
  });

  it("refuses to move a folder inside itself, which would delete it", () => {
    expect(moveDestination("chapters", { path: "chapters", isDir: true })).toBeNull();
    expect(moveDestination("chapters", { path: "chapters/sections", isDir: true })).toBeNull();
    // A sibling whose name merely starts the same way is a legitimate target.
    expect(moveDestination("chapters", { path: "chapters-old", isDir: true })).toBe("chapters-old/chapters");
  });

  it("normalises separators so a Windows path drops like any other", () => {
    expect(moveDestination("chapters\\ch2.tex", { path: "appendix", isDir: true })).toBe("appendix/ch2.tex");
  });
});

describe("canDropOn", () => {
  it("is false with nothing being dragged", () => {
    expect(canDropOn(null, { path: "chapters", isDir: true })).toBe(false);
    expect(canDropOn("ch2.tex", { path: "chapters", isDir: true })).toBe(true);
  });
});

describe("remapExpandedPaths", () => {
  it("keeps the folders the user had open, at their new paths", () => {
    const next = remapExpandedPaths(
      ["chapters", "chapters/sections", "figures"],
      "chapters",
      "book/chapters",
    );
    expect([...next].sort()).toEqual(["book/chapters", "book/chapters/sections", "figures"]);
  });
});
