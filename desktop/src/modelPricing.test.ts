import { describe, expect, it } from "vitest";
import { DEEPSEEK_PRICE_BASELINE, modelPriceView, modelPricingSummary, parseModelPricingCatalog } from "./modelPricing";
import { priceFixture, pricingCatalog, pricingState } from "./tests/modelPricingFixture";

describe("DeepSeek relative prices", () => {
  it("compares equal input/output workloads and explains their distinct ratios", () => {
    const state = pricingState();
    expect(modelPriceView(DEEPSEEK_PRICE_BASELINE, state, "cn")?.label).toBe("1×");
    const view = modelPriceView("gpt-6.1-sol", state, "cn")!;
    expect(view.label).toBe("18×");
    expect(view.title).toContain("输入 10× · 输出 20×");
    expect(view.title).toContain("1:1，不含缓存命中");
    expect(view.title).toContain("缓存读取 10×");
    expect(modelPricingSummary(state, "en")).toContain(`${DEEPSEEK_PRICE_BASELINE} peak = 1×`);
  });

  it("distinguishes verified free rates, missing prices, per-request and variable billing", () => {
    const state = pricingState({ catalog: pricingCatalog({ models: [
      ...pricingCatalog().models,
      { ...priceFixture("image", 0, 0), billing: "per_request" },
      { ...priceFixture("tiered", 0, 0), billing: "tiered" },
    ] }) });
    expect(modelPriceView("longcat-2.5-preview-free", state, "cn")?.label).toBe("免费");
    expect(modelPriceView("unknown", state, "cn")?.label).toBe("价格未知");
    expect(modelPriceView("image", state, "cn")?.label).toBe("0.1");
    expect(modelPriceView("image", state, "cn")?.title).toContain("按次计费");
    expect(modelPriceView("image", state, "en")?.label).toBe("0.1");
    expect(modelPriceView("tiered", state, "en")?.label).toBe("Variable pricing");
    expect(modelPriceView("model", null, "cn")).toBeNull();
  });

  it("does not silently switch DeepSeek versions or divide by a free baseline", () => {
    for (const baseline of [priceFixture("deepseek-v4-pro", 1, 4), priceFixture(DEEPSEEK_PRICE_BASELINE, 0, 0)]) {
      const state = pricingState({ catalog: pricingCatalog({ peakBaseline: baseline.model === DEEPSEEK_PRICE_BASELINE ? { ...baseline, tier: "peak" } : null,
        models: [baseline, priceFixture("model", 2, 8)] }) });
      expect(modelPriceView("model", state, "cn")?.label).toBe("基准不可用");
      expect(modelPricingSummary(state, "cn")).toContain("基准价格不可用");
    }
  });

  it("keeps small positive prices visibly distinct from free and explains stale data", () => {
    const state = pricingState({ stale: true, failed: true, catalog: pricingCatalog({ models: [
      priceFixture(DEEPSEEK_PRICE_BASELINE, 1, 4), priceFixture("cheap", 0.00001, 0.00004),
    ] }) });
    const view = modelPriceView("cheap", state, "cn")!;
    expect(view.label).toBe("<0.01×");
    expect(view.title).toContain("刷新失败，显示缓存价格");
    expect(view.title).toContain("更新于");
    expect(modelPriceView("model", pricingState({ catalog: null, loading: true }), "en")?.label).toBe("Loading price");
  });

  it("explains time and context tiers used for a variable price", () => {
    const peakBaseline = { ...priceFixture(DEEPSEEK_PRICE_BASELINE, 2, 8), tier: "peak" };
    const state = pricingState({ catalog: pricingCatalog({ peakBaseline, models: [
      peakBaseline,
      { ...priceFixture("gpt-6.1-sol", 2, 10), tier: "上下文≤272k" },
    ] }) });
    expect(modelPriceView("gpt-6.1-sol", state, "cn")).toMatchObject({ label: "1.2×" });
    expect(modelPriceView("gpt-6.1-sol", state, "cn")?.title).toContain("参考上下文 1000 个输入 Token；当前档位 上下文≤272k；DeepSeek 高峰");
    expect(modelPricingSummary(state, "cn")).toContain("高峰");
  });

  it("keeps every comparison anchored to peak prices when DeepSeek enters off peak", () => {
    const peakBaseline = { ...priceFixture(DEEPSEEK_PRICE_BASELINE, 2, 8), tier: "peak" };
    const other = { ...priceFixture("gpt-6.1-sol", 2, 10), tier: "上下文≤272k" };
    const stateFor = (offPeak: boolean) => pricingState({ catalog: pricingCatalog({ peakBaseline, models: [
      offPeak ? { ...priceFixture(DEEPSEEK_PRICE_BASELINE, 1, 4), tier: "off_peak" } : peakBaseline, other,
    ] }) });
    const peak = stateFor(false);
    const offPeak = stateFor(true);
    expect(modelPriceView(DEEPSEEK_PRICE_BASELINE, peak, "cn")?.label).toBe("1×");
    expect(modelPriceView(DEEPSEEK_PRICE_BASELINE, offPeak, "cn")?.label).toBe("0.5×");
    for (const state of [peak, offPeak]) {
      expect(modelPriceView(other.model, state, "cn")).toMatchObject({ label: "1.2×" });
      expect(modelPriceView(other.model, state, "cn")?.title).toContain("输入 1× · 输出 1.25×");
    }
    expect(modelPriceView(DEEPSEEK_PRICE_BASELINE, offPeak, "cn")?.title).toContain("当前档位 低峰");
    expect(modelPricingSummary(offPeak, "cn")).toBe(modelPricingSummary(peak, "cn"));
    expect(modelPricingSummary(offPeak, "cn")).toContain("高峰 = 1×");
  });

  it("rejects malformed cached rates and only retains safe catalogue fields", () => {
    const catalog = pricingCatalog();
    expect(parseModelPricingCatalog({ ...catalog, secret: "never persist" })).toEqual(catalog);
    expect(parseModelPricingCatalog({ ...catalog, models: [{ ...catalog.models[0], inputRate: NaN }] })).toBeNull();
    expect(parseModelPricingCatalog({ ...catalog, models: [{ ...catalog.models[0], outputRate: null }] })).toBeNull();
    expect(parseModelPricingCatalog({ ...catalog, models: [catalog.models[0], catalog.models[0]] })).toBeNull();
    const { peakBaseline, ...oldCatalog } = catalog;
    expect(parseModelPricingCatalog(oldCatalog)).toBeNull();
    expect(parseModelPricingCatalog({ ...catalog, peakBaseline: { ...peakBaseline, tier: "off_peak" } })).toBeNull();
    expect(parseModelPricingCatalog({ ...catalog, peakBaseline: { ...peakBaseline, model: "deepseek-v4-pro" } })).toBeNull();
  });
});
