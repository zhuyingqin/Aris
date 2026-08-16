// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../store";
import Settings from "./Settings";

describe("Settings account and usage", () => {
  beforeEach(() => {
    sessionStorage.setItem("somniq-settings-tab-request", "account");
    useStore.setState({ language: "cn" });
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("merges identity, quota summaries, and call details without duplicate quota content", () => {
    const { container } = render(<Settings />);
    const section = container.querySelector(".sp-account-section.sp-account-usage-section");

    expect(section).not.toBeNull();
    const accountSection = within(section as HTMLElement);

    expect(accountSection.getByText("账户与用量")).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: /摘要与研究服务/ }));

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
});
