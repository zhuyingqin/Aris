import type { ModelPrice, ModelPricingCatalog } from "../types";
import type { ModelPricingState } from "../modelPricing";

export const priceFixture = (model: string, inputRate: number, outputRate: number): ModelPrice => ({
  model, billing: "tokens", inputRate, outputRate, cacheReadRate: inputRate / 10, cacheCreationRate: inputRate, tier: null,
});

export function pricingCatalog(overrides: Partial<ModelPricingCatalog> = {}): ModelPricingCatalog {
  const peakBaseline = { ...priceFixture("deepseek-v4.1-flash", 1, 4), tier: "peak" };
  return { username: "researcher", group: "go", fetchedAt: Date.now(), validUntil: Date.now() + 5 * 60_000, referenceInputTokens: 1000, peakBaseline, models: [
    peakBaseline,
    priceFixture("gpt-6.1-sol", 10, 80),
    priceFixture("longcat-2.5-preview-free", 0, 0),
  ], ...overrides };
}

export const pricingState = (overrides: Partial<ModelPricingState> = {}): ModelPricingState => ({
  catalog: pricingCatalog(), loading: false, stale: false, failed: false, ...overrides,
});
