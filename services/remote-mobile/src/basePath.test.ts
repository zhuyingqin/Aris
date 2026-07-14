import { describe, expect, it } from "vitest";

import { mobileBasePathUrl, normalizeMobileBasePath } from "./basePath";

describe("mobile deployment base path", () => {
  it("defaults to root and normalizes a subpath with one leading and trailing slash", () => {
    expect(normalizeMobileBasePath(undefined)).toBe("/");
    expect(normalizeMobileBasePath("   ")).toBe("/");
    expect(normalizeMobileBasePath("somniq")).toBe("/somniq/");
    expect(normalizeMobileBasePath(" /somniq//remote/ ")).toBe("/somniq/remote/");
  });

  it("builds same-origin paths without losing the deployment base", () => {
    expect(mobileBasePathUrl("/v1/browser-ws-tickets", "/")).toBe("/v1/browser-ws-tickets");
    expect(mobileBasePathUrl("/v1/browser-ws-tickets", "/somniq")).toBe("/somniq/v1/browser-ws-tickets");
    expect(mobileBasePathUrl("icon.svg", "/somniq/")).toBe("/somniq/icon.svg");
  });

  it("rejects values that could escape or replace the same origin", () => {
    expect(() => normalizeMobileBasePath("https://other.example/somniq")).toThrow(/URL path/);
    expect(() => normalizeMobileBasePath("//other.example/somniq")).toThrow(/URL path/);
    expect(() => normalizeMobileBasePath("/somniq/../admin")).toThrow(/cannot contain/);
  });
});
