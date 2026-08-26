// @vitest-environment jsdom
//
// Runs Settings against a mocked native backend, which is where the two
// defects covered here are reachable: the browser-preview path short-circuits
// `save()` before it reloads the config, and never signs anybody out.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configGet, configSet, newapiBootstrap, newapiModels } from "../api/tauri";
import { readCachedUsageLogPages, writeCachedUsageLogPages } from "../accountCache";
import { useStore } from "../store";
import Settings from "./Settings";
import { PREVIEW_SETTINGS_DATA } from "./settingsPreviewData";

vi.mock("../api/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/tauri")>()),
  isTauri: () => true,
  configGet: vi.fn(),
  configSet: vi.fn(),
  newapiBootstrap: vi.fn(),
  newapiModels: vi.fn(),
  newapiLogout: vi.fn(async () => undefined),
}));

const preview = PREVIEW_SETTINGS_DATA.cn;

describe("Settings against a native backend", () => {
  beforeEach(() => {
    vi.mocked(configGet).mockResolvedValue(preview.configView);
    vi.mocked(configSet).mockResolvedValue(preview.configView);
    vi.mocked(newapiBootstrap).mockResolvedValue(preview.account);
    vi.mocked(newapiModels).mockResolvedValue(preview.configView.managedModels ?? []);
    sessionStorage.setItem("somniq-settings-tab-request", "models");
    useStore.setState({ language: "cn" });
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    writeCachedUsageLogPages({});
    vi.clearAllMocks();
  });

  it("clears every API-key draft after a save, the OpenAlex one included", async () => {
    render(<Settings />);

    const scopusInput = await screen.findByPlaceholderText("粘贴 Elsevier 密钥");
    const openalexInput = screen.getByPlaceholderText("粘贴 OpenAlex API 密钥");
    fireEvent.change(scopusInput, { target: { value: "scopus-draft" } });
    fireEvent.change(openalexInput, { target: { value: "openalex-draft" } });
    expect((openalexInput as HTMLInputElement).value).toBe("openalex-draft");

    fireEvent.click(screen.getByRole("button", { name: "保存连接配置" }));

    await waitFor(() => {
      expect(vi.mocked(configSet)).toHaveBeenCalledWith(
        expect.objectContaining({ openalexApiKey: "openalex-draft" }),
      );
    });
    await waitFor(() => {
      expect((openalexInput as HTMLInputElement).value).toBe("");
    });
    expect((scopusInput as HTMLInputElement).value).toBe("");
  });

  it("drops cached usage-log pages on sign-out so the next account cannot see them", () => {
    writeCachedUsageLogPages({ 1: { page: 1, pageSize: 12, total: 1, items: [] } });
    expect(readCachedUsageLogPages()).toHaveProperty("1");

    useStore.getState().logout();

    expect(readCachedUsageLogPages()).toEqual({});
  });
});
