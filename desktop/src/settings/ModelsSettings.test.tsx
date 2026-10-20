// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModelPricing } from "../useModelPricing";
import { priceFixture, pricingCatalog, pricingState } from "../tests/modelPricingFixture";
import { PREVIEW_SETTINGS_DATA } from "./settingsPreviewData";
import type { SettingsConnectionState } from "./useSettingsConnectionState";
import ModelsSettings from "./ModelsSettings";

vi.mock("../useModelPricing", () => ({ useModelPricing: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderModels() {
  const connection = {
    advForm: {}, setAdvForm: vi.fn(), modelAutoSave: { error: "" },
    applyManagedModel: vi.fn(), applyManagedReviewerModel: vi.fn(), applyReviewMode: vi.fn(), loadManagedModels: vi.fn(),
  } as unknown as SettingsConnectionState;
  render(<ModelsSettings language="cn" configView={{ ...PREVIEW_SETTINGS_DATA.cn.configView,
    executorModel: "gpt-6.1-sol", reviewerModel: "deepseek-v4.1-flash" }} account={null}
    managedModels={["gpt-6.1-sol", "deepseek-v4.1-flash"]} connection={connection} />);
  return connection;
}

describe("model settings prices", () => {
  it("prices both roles and keeps their model selections independent", () => {
    vi.mocked(useModelPricing).mockReturnValue(pricingState());
    const connection = renderModels();
    const executor = screen.getByRole("combobox", { name: "执行模型" });
    const reviewer = screen.getByRole("combobox", { name: "Reviewer 模型" });
    expect(within(executor).getByRole("option", { name: "gpt-6.1-sol · 18×" })).toBeTruthy();
    expect(within(reviewer).getByRole("option", { name: "deepseek-v4.1-flash · 1×" })).toBeTruthy();
    expect(executor.title).toContain("输入 10× · 输出 20×");
    fireEvent.change(executor, { target: { value: "deepseek-v4.1-flash" } });
    fireEvent.change(reviewer, { target: { value: "gpt-6.1-sol" } });
    expect(connection.applyManagedModel).toHaveBeenCalledWith("deepseek-v4.1-flash");
    expect(connection.applyManagedReviewerModel).toHaveBeenCalledWith("gpt-6.1-sol");
  });

  it("keeps model selection and sync available after a price error", () => {
    vi.mocked(useModelPricing).mockReturnValue(pricingState({ catalog: null, failed: true }));
    const connection = renderModels();
    expect((screen.getByRole("combobox", { name: "执行模型" }) as HTMLSelectElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "同步模型" }));
    expect(connection.loadManagedModels).toHaveBeenCalledOnce();
  });

  it("shows the off-peak discount for DeepSeek while keeping the other model's multiplier", () => {
    const catalog = pricingCatalog();
    catalog.models[0] = { ...priceFixture("deepseek-v4.1-flash", 0.5, 2), tier: "off_peak" };
    vi.mocked(useModelPricing).mockReturnValue(pricingState({ catalog }));
    renderModels();
    const executor = screen.getByRole("combobox", { name: "执行模型" });
    const reviewer = screen.getByRole("combobox", { name: "Reviewer 模型" });
    expect(within(executor).getByRole("option", { name: "gpt-6.1-sol · 18×" })).toBeTruthy();
    expect(within(reviewer).getByRole("option", { name: "deepseek-v4.1-flash · 0.5×" })).toBeTruthy();
    expect(screen.getByText(/deepseek-v4.1-flash 高峰 = 1×/)).toBeTruthy();
  });
});
