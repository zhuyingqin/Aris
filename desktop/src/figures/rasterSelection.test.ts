import { describe, expect, it } from "vitest";
import { imagePoint, rectangleRegion, regionArea } from "./rasterSelection";

describe("PNG selection in original pixel coordinates", () => {
  it("maps a scaled image and ignores horizontal letterboxing", () => {
    const rect = { left: 100, top: 50, width: 800, height: 300 };
    expect(imagePoint(400, 150, rect, 600, 600)).toEqual({ x: 100, y: 200 });
    expect(imagePoint(200, 150, rect, 600, 600)).toBeNull();
    expect(imagePoint(900, 500, rect, 600, 600, true)).toEqual({ x: 600, y: 600 });
  });
  it("maps a portrait viewport's vertical letterboxing independently of browser pixels", () => {
    const rect = { left: 10, top: 20, width: 400, height: 800 };
    expect(imagePoint(110, 370, rect, 800, 400)).toEqual({ x: 200, y: 100 });
    expect(imagePoint(110, 30, rect, 800, 400)).toBeNull();
    expect(imagePoint(110, 30, rect, 800, 400, true)).toEqual({ x: 200, y: 0 });
  });
  it("rejects empty layouts and builds backwards-dragged rectangles", () => {
    expect(imagePoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, 600, 400)).toBeNull();
    const region = rectangleRegion({ x: 80, y: 70 }, { x: 10, y: 20 });
    expect(region).toHaveLength(4); expect(regionArea(region)).toBe(3500);
    expect(regionArea([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toBe(0);
  });
});
