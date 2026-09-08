import { describe, expect, it } from "vitest";
import { FULL_SCREEN_REMOTE_QUERY, buildRemoteWorkspaceUrl } from "./remoteHandoff";

describe("Remote workspace handoff (src/remoteHandoff.ts)", () => {
  it("marks the console's framed copy as embedded", () => {
    const url = buildRemoteWorkspaceUrl({ deviceId: "pc-1", theme: "dark", embedded: true });
    expect(url).toBe("./remote/?embed=1&theme=dark&desktop=pc-1");
  });

  it("never sends embed=1 on a handoff", () => {
    // `embed=1` would force the desktop layout onto the phone and break the
    // app's software-keyboard compensation. This is the whole point of the
    // full-screen handoff, so it is worth pinning.
    const url = buildRemoteWorkspaceUrl({ deviceId: "pc-1", theme: "light", embedded: false });
    expect(url).toBe("./remote/?theme=light&desktop=pc-1");
    expect(new URL(url, "https://example.com/").searchParams.has("embed")).toBe(false);
  });

  it("omits the target client until one is known, letting the app pick", () => {
    expect(buildRemoteWorkspaceUrl({ deviceId: null, theme: "dark", embedded: false }))
      .toBe("./remote/?theme=dark");
  });

  it("replaces the dialed client with the design preview in dev", () => {
    const url = buildRemoteWorkspaceUrl({
      deviceId: "pc-1",
      theme: "dark",
      embedded: true,
      preview: true,
    });
    expect(url).toBe("./remote/?embed=1&theme=dark&preview=chat");
  });

  it("escapes client ids rather than pasting them into the query", () => {
    const url = buildRemoteWorkspaceUrl({ deviceId: "a&b=c", theme: "dark", embedded: false });
    expect(url).toBe("./remote/?theme=dark&desktop=a%26b%3Dc");
    expect(new URL(url, "https://example.com/").searchParams.get("desktop")).toBe("a&b=c");
  });

  it("hands off at the console's own narrow breakpoint", () => {
    expect(FULL_SCREEN_REMOTE_QUERY).toContain("(max-width: 720px)");
  });

  it("also hands off for a phone held sideways, but not for a short desktop window", () => {
    // Landscape phones are wider than the narrow breakpoint yet have less
    // vertical room than the framed stage needs.
    expect(FULL_SCREEN_REMOTE_QUERY).toContain("(max-height: 560px) and (pointer: coarse)");
  });
});
