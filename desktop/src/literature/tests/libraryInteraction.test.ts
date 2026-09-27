import { describe, expect, it } from "vitest";
import { idsInRange, nextAfterRemoval } from "../libraryInteraction";

describe("library list interaction helpers", () => {
  const ids = ["a", "b", "c", "d"];

  it("returns the inclusive run between anchor and target in either direction", () => {
    expect(idsInRange(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(idsInRange(ids, "d", "b")).toEqual(["b", "c", "d"]);
    expect(idsInRange(ids, "c", "c")).toEqual(["c"]);
  });

  it("falls back to the target when the anchor has left the list", () => {
    expect(idsInRange(ids, "gone", "c")).toEqual(["c"]);
    expect(idsInRange(ids, "a", "gone")).toEqual([]);
  });

  it("hands focus to the next survivor, or the previous one at the end", () => {
    expect(nextAfterRemoval(ids, new Set(["b"]), "b")).toBe("c");
    expect(nextAfterRemoval(ids, new Set(["b", "c"]), "b")).toBe("d");
    expect(nextAfterRemoval(ids, new Set(["c", "d"]), "d")).toBe("b");
    expect(nextAfterRemoval(ids, new Set(ids), "a")).toBeNull();
  });
});
