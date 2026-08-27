// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("optional navigation module visibility", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("hides Mail and Workflows for a fresh profile", async () => {
    const { useStore } = await import("./store");

    expect(useStore.getState().hideMail).toBe(true);
    expect(useStore.getState().hideWorkflows).toBe(true);
  });

  it("persists an explicit Visible choice instead of reverting to the default", async () => {
    const { useStore } = await import("./store");

    useStore.getState().setHideMail(false);
    useStore.getState().setHideWorkflows(false);

    expect(localStorage.getItem("somniq-hide-mail")).toBe("false");
    expect(localStorage.getItem("somniq-hide-workflows")).toBe("false");

    useStore.getState().setHideMail(true);
    useStore.getState().setHideWorkflows(true);

    expect(localStorage.getItem("somniq-hide-mail")).toBe("true");
    expect(localStorage.getItem("somniq-hide-workflows")).toBe("true");
  });

  it("does not persist the default dark preview before the user chooses a theme", async () => {
    const { useStore } = await import("./store");

    expect(useStore.getState().theme).toBe("dark");
    expect(useStore.getState().themePreferenceSet).toBe(false);
    expect(localStorage.getItem("somniq-theme")).toBeNull();

    useStore.getState().setTheme("dark");

    expect(useStore.getState().themePreferenceSet).toBe(true);
    expect(localStorage.getItem("somniq-theme")).toBe("dark");
  });
});
