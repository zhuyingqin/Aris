import { describe, expect, it } from "vitest";

import { mobileBasePathUrl, normalizeMobileBasePath, resolveMobileBasePath } from "./basePath";

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
    expect(mobileBasePathUrl("icon.png", "/somniq/")).toBe("/somniq/icon.png");
  });

  it("prefers the configured base over the document location", () => {
    expect(resolveMobileBasePath("/remote/", "/remote/")).toBe("/remote/");
    expect(resolveMobileBasePath("/remote/", "/somewhere/else/pair")).toBe("/remote/");
  });

  it("falls back to the document directory when the host app owns the base", () => {
    // The landing-page dev server serves this PWA at /remote/ under its own
    // Vite root, so BASE_URL is "/" while the document is one level down.
    expect(resolveMobileBasePath("/", "/remote/")).toBe("/remote/");
    expect(resolveMobileBasePath("/", "/remote/index.html")).toBe("/remote/");
    expect(resolveMobileBasePath(undefined, "/remote/pair")).toBe("/remote/");
    expect(resolveMobileBasePath("/", "/")).toBe("/");
  });

  it("never lets a hostile location escape the mount", () => {
    expect(resolveMobileBasePath("/", "/remote/../admin/")).toBe("/");
    expect(resolveMobileBasePath("/", "no-leading-slash")).toBe("/");
  });

  it("rejects values that could escape or replace the same origin", () => {
    expect(() => normalizeMobileBasePath("https://other.example/somniq")).toThrow(/URL path/);
    expect(() => normalizeMobileBasePath("//other.example/somniq")).toThrow(/URL path/);
    expect(() => normalizeMobileBasePath("/somniq/../admin")).toThrow(/cannot contain/);
  });
});
