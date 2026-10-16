// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  configGet: vi.fn(),
  configSet: vi.fn(),
  newapiLogin: vi.fn(),
}));

vi.mock("./api/tauri", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api/tauri")>(),
  ...authMocks,
}));

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

  it("restores the manual UI font preference before the next workspace render", async () => {
    const { useStore } = await import("./store");
    useStore.getState().setUiFontSize(18);
    vi.resetModules();
    const restored = (await import("./store")).useStore.getState();
    expect(restored.uiFontMode).toBe("manual");
    expect(restored.uiFontSize).toBe(18);
    expect(document.documentElement.dataset.uiFontSize).toBe("18");
  });
});

describe("model preference on login", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
    authMocks.configGet.mockReset().mockResolvedValue({ executorModel: null });
    authMocks.configSet.mockReset().mockResolvedValue(undefined);
    authMocks.newapiLogin.mockReset().mockImplementation(async (_server: string, model: string) => ({
      model, baseUrl: "https://model-gateway.example/v1", token: "test-token",
    }));
  });

  it("reuses the saved model when the user signs in again", async () => {
    authMocks.configGet.mockResolvedValue({ executorModel: " gpt-6.1-sol " });
    const { DEFAULT_AUTH_SERVER, useStore } = await import("./store");

    await useStore.getState().login(DEFAULT_AUTH_SERVER, "reader", "test-password");

    expect(authMocks.newapiLogin).toHaveBeenCalledWith(DEFAULT_AUTH_SERVER, "gpt-6.1-sol", "reader", "test-password", undefined);
    expect(authMocks.configSet).toHaveBeenCalledWith(expect.objectContaining({ executorModel: "gpt-6.1-sol" }));
  });

  it("uses the initial model only when no previous model has been saved", async () => {
    const { DEFAULT_AUTH_SERVER, useStore } = await import("./store");

    await useStore.getState().login(DEFAULT_AUTH_SERVER, "reader", "test-password");

    expect(authMocks.newapiLogin).toHaveBeenCalledWith(DEFAULT_AUTH_SERVER, "MiniMax-M3", "reader", "test-password", undefined);
  });

  it("does not replace the model with a default when the saved configuration cannot be read", async () => {
    authMocks.configGet.mockRejectedValue(new Error("Configuration is unavailable"));
    const { DEFAULT_AUTH_SERVER, useStore } = await import("./store");

    await expect(useStore.getState().login(DEFAULT_AUTH_SERVER, "reader", "test-password"))
      .rejects.toThrow("Configuration is unavailable");

    expect(authMocks.newapiLogin).not.toHaveBeenCalled();
    expect(authMocks.configSet).not.toHaveBeenCalled();
  });

  it("keeps the previous configuration if login fails", async () => {
    authMocks.configGet.mockResolvedValue({ executorModel: "gpt-6.1-sol" });
    authMocks.newapiLogin.mockRejectedValue(new Error("Login failed"));
    const { DEFAULT_AUTH_SERVER, useStore } = await import("./store");

    await expect(useStore.getState().login(DEFAULT_AUTH_SERVER, "reader", "test-password"))
      .rejects.toThrow("Login failed");

    expect(authMocks.configSet).not.toHaveBeenCalled();
  });
});
