// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";
import { SETTINGS_TAB_REQUEST_EVENT } from "../settingsTabRequest";
import Settings from "./Settings";

describe("Settings account and usage", () => {
  beforeEach(() => {
    sessionStorage.setItem("somniq-settings-tab-request", "account");
    useStore.setState({ language: "cn" });
    useStore.getState().setUiColor("default");
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("merges identity, quota summaries, and call details without duplicate quota content", () => {
    const { container } = render(<Settings />);
    const section = container.querySelector(".sp-account-section.sp-account-usage-section");

    expect(section).not.toBeNull();
    const accountSection = within(section as HTMLElement);

    expect(screen.getByRole("heading", { level: 1, name: "账户管理" })).toBeTruthy();
    expect(accountSection.getByText("账户概览")).toBeTruthy();
    expect(accountSection.queryByText("使用统计")).toBeNull();
    expect(accountSection.getAllByRole("button", { name: "刷新" })).toHaveLength(1);
    expect(accountSection.getAllByText("账户余额")).toHaveLength(1);
    expect(accountSection.getAllByText("订阅余额")).toHaveLength(1);
    expect(accountSection.getByText("调用明细")).toBeTruthy();
    expect(section?.querySelector(".sp-account-summary")).toBeNull();
  });

  it("exposes the optional research proxy and search-provider keys", () => {
    sessionStorage.setItem("somniq-settings-tab-request", "models");
    render(<Settings />);

    expect(screen.getByRole("heading", { level: 1, name: "模型与审阅" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "辅助模型" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "网络与社区搜索" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("粘贴 Bocha API Key")).toBeNull();
    expect(screen.getByText("Brave Search 密钥")).toBeTruthy();
    expect(screen.getByText("Exa 密钥")).toBeTruthy();
    const proxyInput = screen.getByPlaceholderText("例如 http://127.0.0.1:10808");
    const braveInput = screen.getByPlaceholderText("粘贴 Brave Search API 密钥");
    const exaInput = screen.getByPlaceholderText("粘贴 Exa API 密钥");
    fireEvent.change(proxyInput, { target: { value: "http://127.0.0.1:10808" } });
    fireEvent.change(braveInput, { target: { value: "brave-test-key" } });
    fireEvent.change(exaInput, { target: { value: "exa-test-key" } });
    expect((proxyInput as HTMLInputElement).value).toBe("http://127.0.0.1:10808");
    expect((braveInput as HTMLInputElement).value).toBe("brave-test-key");
    expect((exaInput as HTMLInputElement).value).toBe("exa-test-key");
  });

  it("opens the dedicated Update category and keeps About focused on diagnostics", async () => {
    sessionStorage.setItem("somniq-settings-tab-request", "update");
    render(<Settings />);
    expect(screen.getByRole("tab", { name: "更新" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { level: 1, name: "应用更新" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();
    expect(await screen.findByText("Oracle Web")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "关于与环境" }));
    expect(screen.queryByRole("button", { name: "检查更新" })).toBeNull();
    expect(screen.getByPlaceholderText("例如 C:\\Users\\name\\anaconda3 或环境中的 python.exe")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "更新" }));
    expect(screen.getByRole("button", { name: "检查更新" })).toBeTruthy();
  });

  it("changes overall type from Appearance, saves immediately, and restores automatic sizing", () => {
    sessionStorage.setItem("somniq-settings-tab-request", "general");
    useStore.getState().setUiFontMode("auto");
    const { container } = render(<Settings />);
    const input = screen.getByRole("slider", { name: "整体字体大小" }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(container.querySelector(".settings-advanced")).toHaveProperty("open", false);
    fireEvent.change(screen.getByRole("combobox", { name: "字号模式" }), { target: { value: "manual" } });
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "18" } });
    expect(document.documentElement.dataset.uiFontSize).toBe("18");
    expect(JSON.parse(localStorage.getItem("somniq-ui-typography-v1")!)).toEqual({ mode: "manual", fontSize: 18 });
    fireEvent.change(screen.getByRole("combobox", { name: "字号模式" }), { target: { value: "auto" } });
    expect(input.disabled).toBe(true);
    expect(document.documentElement.dataset.uiFontSize).toBe(String(useStore.getState().uiRecommendedFontSize));
    fireEvent.click(screen.getByText("高级"));
    expect(container.querySelector(".settings-advanced")).toHaveProperty("open", true);
    expect(screen.getByRole("group", { name: "文字预览" })).toBeTruthy();
  });

  it("supports keyboard theme selection and keeps advanced prompts collapsed initially", () => {
    sessionStorage.setItem("somniq-settings-tab-request", "general");
    useStore.getState().setTheme("light");
    const { container } = render(<Settings />);
    const light = screen.getByRole("radio", { name: "浅色" });
    fireEvent.keyDown(light, { key: "ArrowRight" });
    expect(useStore.getState().theme).toBe("dark");
    expect(screen.getByRole("radio", { name: "深色" })).toBe(document.activeElement);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByRole("heading", { name: "外观与语言" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "邮箱 (Mail)" }));
    expect(screen.getByRole("switch", { name: "邮箱 (Mail)" }).getAttribute("aria-checked")).toBe(String(!useStore.getState().hideMail));
  });

  it("keeps the applied theme when persistence fails and retains retry after switching categories", () => {
    sessionStorage.setItem("somniq-settings-tab-request", "general");
    useStore.getState().setTheme("light");
    render(<Settings />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("Storage full"); });
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    expect(screen.getByRole("alert").textContent).toContain("已保留原设置");
    expect(screen.queryByText("已保存")).toBeNull();
    expect(useStore.getState().theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(useStore.getState().theme).toBe("dark");
    expect(localStorage.getItem("somniq-theme")).toBe("dark");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("已保存")).toBeTruthy();
  });

  it("keeps font size and module visibility unchanged when local storage fails", () => {
    sessionStorage.setItem("somniq-settings-tab-request", "general");
    useStore.getState().setUiFontSize(14);
    useStore.getState().setHideMail(true);
    render(<Settings />);
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    const input = screen.getByRole("slider", { name: "整体字体大小" });
    fireEvent.change(input, { target: { value: "20" } });
    expect(useStore.getState().uiFontSize).toBe(14);
    expect(document.documentElement.dataset.uiFontSize).toBe("14");
    expect(input).toHaveProperty("value", "14");
    fireEvent.click(screen.getByRole("switch", { name: "邮箱 (Mail)" }));
    expect(useStore.getState().hideMail).toBe(true);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.queryByText("已保存")).toBeNull();
    storage.mockRestore();
  });

  it("saves consecutive slider changes and remembers the chosen size after automatic mode", () => {
    sessionStorage.setItem("somniq-settings-tab-request", "general");
    useStore.getState().setUiFontSize(14);
    render(<Settings />);
    const input = screen.getByRole("slider", { name: "整体字体大小" });
    for (const size of [15, 16, 17, 18, 19, 20]) fireEvent.change(input, { target: { value: String(size) } });
    expect(input).toHaveProperty("value", "20");
    expect(useStore.getState().uiFontSize).toBe(20);
    expect(JSON.parse(localStorage.getItem("somniq-ui-typography-v1")!).fontSize).toBe(20);
    fireEvent.change(screen.getByRole("combobox", { name: "字号模式" }), { target: { value: "auto" } });
    fireEvent.change(screen.getByRole("combobox", { name: "字号模式" }), { target: { value: "manual" } });
    expect(input).toHaveProperty("value", "20");
  });

  it("saves a global color with keyboard navigation and keeps the choice across categories", () => {
    sessionStorage.setItem("somniq-settings-tab-request", "general");
    render(<Settings />);
    const group = within(screen.getByRole("radiogroup", { name: "主题色" }));
    fireEvent.keyDown(group.getByRole("radio", { name: "默认蓝" }), { key: "ArrowRight" });
    expect(useStore.getState().uiColor).toBe("purple");
    expect(document.documentElement.dataset.uiColor).toBe("purple");
    expect(localStorage.getItem("somniq-ui-color-v1")).toBe("purple");
    expect(group.getByRole("radio", { name: "紫色" })).toBe(document.activeElement);
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    fireEvent.click(screen.getByRole("tab", { name: "常规" }));
    expect(screen.getByRole("radio", { name: "紫色" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the previous global color on storage failure and retries the requested color", () => {
    sessionStorage.setItem("somniq-settings-tab-request", "general");
    render(<Settings />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("Storage full"); });
    fireEvent.click(screen.getByRole("radio", { name: "紫色" }));
    expect(screen.getByRole("alert").textContent).toContain("已保留原设置");
    expect(screen.queryByText("已保存")).toBeNull();
    expect(useStore.getState().uiColor).toBe("default");
    expect(document.documentElement.dataset.uiColor).toBe("default");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(useStore.getState().uiColor).toBe("purple");
    expect(document.documentElement.dataset.uiColor).toBe("purple");
    expect(localStorage.getItem("somniq-ui-color-v1")).toBe("purple");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps legacy environment requests and category handoffs working", () => {
    sessionStorage.setItem("somniq-settings-tab-request", "environment");
    render(<Settings />);
    expect(screen.getByRole("tab", { name: "关于与环境" }).getAttribute("aria-selected")).toBe("true");
    fireEvent(window, new CustomEvent(SETTINGS_TAB_REQUEST_EVENT, { detail: "general" }));
    expect(screen.getByRole("heading", { name: "通用与外观" })).toBeTruthy();
    fireEvent(window, new CustomEvent(SETTINGS_TAB_REQUEST_EVENT, { detail: "environment" }));
    expect(screen.getByRole("tab", { name: "关于与环境" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps mail, environment, and memory drafts when changing categories", () => {
    useStore.getState().setHideMail(false);
    sessionStorage.setItem("somniq-settings-tab-request", "models");
    const { container } = render(<Settings />);
    fireEvent.change(screen.getByPlaceholderText("粘贴 Elsevier 密钥"), { target: { value: "pending-key" } });

    fireEvent.click(screen.getByRole("tab", { name: "邮箱" }));
    fireEvent.change(screen.getByPlaceholderText("name@example.com"), { target: { value: "draft@example.com" } });
    fireEvent.change(screen.getByPlaceholderText("imap.example.com"), { target: { value: "imap.draft.test" } });
    const smtp = container.querySelector(".settings-mail-advanced") as HTMLDetailsElement;
    expect(smtp.open).toBe(false);
    fireEvent.click(within(smtp).getByText("发件 SMTP"));
    fireEvent.change(screen.getByPlaceholderText("smtp.example.com"), { target: { value: "smtp.draft.test" } });

    fireEvent.click(screen.getByRole("tab", { name: "关于与环境" }));
    const python = screen.getByPlaceholderText("例如 C:\\Users\\name\\anaconda3 或环境中的 python.exe");
    fireEvent.change(python, { target: { value: "C:\\research\\python" } });
    expect(screen.queryByRole("heading", { level: 1, name: "邮箱连接" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    expect(screen.getByPlaceholderText("粘贴 Elsevier 密钥")).toHaveProperty("value", "pending-key");
    fireEvent.click(screen.getByRole("tab", { name: "邮箱" }));
    expect(screen.getByPlaceholderText("name@example.com")).toHaveProperty("value", "draft@example.com");
    expect(screen.getByPlaceholderText("imap.example.com")).toHaveProperty("value", "imap.draft.test");
    expect(smtp.open).toBe(true);
    expect(screen.getByPlaceholderText("smtp.example.com")).toHaveProperty("value", "smtp.draft.test");
    fireEvent.click(screen.getByRole("tab", { name: "关于与环境" }));
    expect(screen.getByPlaceholderText("例如 C:\\Users\\name\\anaconda3 或环境中的 python.exe")).toHaveProperty("value", "C:\\research\\python");
    fireEvent.click(screen.getByRole("tab", { name: "智能记忆" }));
    fireEvent.change(screen.getByRole("combobox", { name: "构建模型" }), { target: { value: "gpt-5.6-luna" } });
    fireEvent.click(screen.getByRole("tab", { name: "模型服务" }));
    fireEvent.click(screen.getByRole("tab", { name: "智能记忆" }));
    expect(screen.getByRole("combobox", { name: "构建模型" })).toHaveProperty("value", "gpt-5.6-luna");
  });
});
