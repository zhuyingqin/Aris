// @vitest-environment jsdom
//
// Runs Settings against a mocked native backend, which is where the two
// defects covered here are reachable: the browser-preview path short-circuits
// `save()` before it reloads the config, and never signs anybody out.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configGet, configSet, newapiBootstrap, newapiModels } from "../api/tauri";
import { readCachedUsageLogPages, writeCachedUsageLogPages } from "../accountCache";
import { useStore } from "../store";
import { SETTINGS_TAB_REQUEST_EVENT } from "../settingsTabRequest";
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

vi.mock("../api/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/transport")>()),
  hasNativeBackend: () => true,
}));

const preview = PREVIEW_SETTINGS_DATA.cn;

describe("Settings against a native backend", () => {
  beforeEach(() => {
    vi.mocked(configGet).mockResolvedValue(preview.configView);
    vi.mocked(configSet).mockImplementation(async (patch) => ({ ...preview.configView, ...patch }));
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

  it("clears API-key drafts after saving the connection configuration", async () => {
    render(<Settings />);

    const scopusInput = await screen.findByPlaceholderText("粘贴 Elsevier 密钥");
    fireEvent.change(scopusInput, { target: { value: "scopus-draft" } });

    fireEvent.click(screen.getByRole("button", { name: "保存连接配置" }));

    await waitFor(() => {
      expect(vi.mocked(configSet)).toHaveBeenCalledWith(
        expect.objectContaining({ scopusApiKey: "scopus-draft" }),
      );
    });
    await waitFor(() => {
      expect((scopusInput as HTMLInputElement).value).toBe("");
    });
  });

  it("drops cached usage-log pages on sign-out so the next account cannot see them", () => {
    writeCachedUsageLogPages({ 1: { page: 1, pageSize: 12, total: 1, items: [] } });
    expect(readCachedUsageLogPages()).toHaveProperty("1");

    useStore.getState().logout();

    expect(readCachedUsageLogPages()).toEqual({});
  });

  it("keeps the confirmed memory policy on failure and retries without losing model drafts", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByPlaceholderText("粘贴 Elsevier 密钥"), { target: { value: "unsaved-key" } });
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    const group = within(screen.getByRole("radiogroup", { name: "记忆策略" }));
    const previous = group.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")!;
    const target = group.getAllByRole("radio").find((radio) => radio !== previous)!;
    vi.mocked(configSet).mockRejectedValueOnce(new Error("Disk is read-only"));
    fireEvent.click(target);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("已保留原设置"));
    expect(previous.getAttribute("aria-checked")).toBe("true");
    expect(target.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("记忆策略已保存");
    expect(target.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    expect(screen.getByPlaceholderText("粘贴 Elsevier 密钥")).toHaveProperty("value", "unsaved-key");
    fireEvent.click(screen.getByRole("button", { name: "保存连接配置" }));
    await waitFor(() => expect(vi.mocked(configSet)).toHaveBeenLastCalledWith(expect.objectContaining({ scopusApiKey: "unsaved-key" })));
    expect(vi.mocked(configSet).mock.calls.find(([patch]) => patch.scopusApiKey === "unsaved-key")?.[0]).not.toHaveProperty("memoryWriteApproval");
  });

  it("prevents duplicate writes and retains an in-flight policy change across tab switches", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "general");
    render(<Settings />);
    const group = within(await screen.findByRole("radiogroup", { name: "记忆策略" }));
    const target = group.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "false")!;
    const next = target.textContent === "写入前确认";
    let finish!: (view: typeof preview.configView) => void;
    vi.mocked(configSet).mockClear();
    vi.mocked(configSet).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(target);
    fireEvent.click(target);
    expect(target).toHaveProperty("disabled", true);
    expect(vi.mocked(configSet)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    finish({ ...preview.configView, memoryWriteApproval: next });
    await waitFor(() => expect(vi.mocked(configSet)).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    await screen.findByText("记忆策略已保存");
    expect(screen.getByRole("radio", { name: target.textContent! }).getAttribute("aria-checked")).toBe("true");
  });

  it("reports language failures locally and only applies a confirmed language without clearing connection drafts", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByPlaceholderText("粘贴 Elsevier 密钥"), { target: { value: "keep-this-draft" } });
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    vi.mocked(configSet).mockClear();
    vi.mocked(configSet).mockRejectedValueOnce(new Error("Disk is read-only"));
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(screen.getByRole("radio", { name: "English" })).toHaveProperty("disabled", true);
    await screen.findByRole("alert");
    expect(useStore.getState().language).toBe("cn");
    expect(screen.queryByText("已保存")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("Saved");
    expect(useStore.getState().language).toBe("en");
    expect(vi.mocked(configSet).mock.calls).toEqual([[{ language: "en" }], [{ language: "en" }]]);
    // Use the stable category request contract so translations do not couple this test to nav copy.
    fireEvent(window, new CustomEvent(SETTINGS_TAB_REQUEST_EVENT, { detail: "models" }));
    await waitFor(() => expect(screen.queryByText("Saved")).toBeNull());
    expect(screen.getByDisplayValue("keep-this-draft")).toBeTruthy();
  });
});
