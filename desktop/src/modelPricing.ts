import type { ModelPrice, ModelPricingCatalog } from "./types";

export const DEEPSEEK_PRICE_BASELINE = "deepseek-v4.1-flash";
export const MODEL_PRICING_TTL_MS = 5 * 60_000;

export interface ModelPricingState {
  catalog: ModelPricingCatalog | null;
  loading: boolean;
  stale: boolean;
  failed: boolean;
}

export interface ModelPriceView {
  label: string;
  title: string;
  kind: "ratio" | "per-request" | "free" | "unknown";
  /** Unrounded numeric badge value; absent when the price is unconfirmed. */
  sortValue?: number;
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseModelPrice(value: unknown): ModelPrice | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as ModelPrice;
  if (typeof raw.model !== "string" || !raw.model
    || !["tokens", "per_request", "tiered", "unknown"].includes(raw.billing)
    || (raw.tier !== null && typeof raw.tier !== "string")
    || [raw.inputRate, raw.outputRate, raw.cacheReadRate, raw.cacheCreationRate]
      .some((rate) => rate !== null && !validRate(rate))
    || (raw.billing === "tokens" && (!validRate(raw.inputRate) || !validRate(raw.outputRate)))) return null;
  return { model: raw.model, billing: raw.billing, inputRate: raw.inputRate, outputRate: raw.outputRate,
    cacheReadRate: raw.cacheReadRate, cacheCreationRate: raw.cacheCreationRate, tier: raw.tier };
}

/** Validate and project disk/IPC data: never persist unrecognised response fields. */
export function parseModelPricingCatalog(value: unknown): ModelPricingCatalog | null {
  if (!value || typeof value !== "object") return null;
  const catalog = value as Partial<ModelPricingCatalog>;
  if (typeof catalog.username !== "string" || !catalog.username
    || typeof catalog.group !== "string" || !catalog.group
    || !validRate(catalog.fetchedAt) || !validRate(catalog.validUntil) || catalog.validUntil <= catalog.fetchedAt
    || !validRate(catalog.referenceInputTokens) || catalog.referenceInputTokens <= 0 || !Array.isArray(catalog.models)) return null;
  const peakBaseline = parseModelPrice(catalog.peakBaseline);
  // Old snapshots used the current off-peak rate as the denominator. Refetch
  // them instead of reusing that meaning after the comparison basis changes.
  if (catalog.peakBaseline !== null && (!tokenPrice(peakBaseline) || peakBaseline.model !== DEEPSEEK_PRICE_BASELINE || peakBaseline.tier !== "peak")) return null;
  const models: ModelPrice[] = [];
  const seen = new Set<string>();
  for (const raw of catalog.models) {
    const price = parseModelPrice(raw);
    if (!price || seen.has(price.model)) return null;
    seen.add(price.model);
    models.push(price);
  }
  return { username: catalog.username, group: catalog.group, fetchedAt: catalog.fetchedAt,
    validUntil: catalog.validUntil, referenceInputTokens: catalog.referenceInputTokens, peakBaseline, models };
}

export const modelPricingExpiresAt = (catalog: ModelPricingCatalog) => Math.min(catalog.validUntil, catalog.fetchedAt + MODEL_PRICING_TTL_MS);

function tierLabel(tier: string | null, cn: boolean): string {
  if (!tier) return cn ? "标准" : "Standard";
  if (cn) return ({ peak: "高峰", off_peak: "低峰", standard: "标准", base: "基础" } as Record<string, string>)[tier] ?? tier;
  return tier;
}

function tokenPrice(price: ModelPrice | null | undefined): price is ModelPrice & { inputRate: number; outputRate: number } {
  return price?.billing === "tokens" && validRate(price.inputRate) && validRate(price.outputRate);
}

function ratioLabel(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  if (ratio > 0 && ratio < 0.01) return "<0.01×";
  return `${ratio.toLocaleString("en-US", { maximumFractionDigits: 2 })}×`;
}

function relativeRate(rate: number | null, baseline: number | null): string {
  return rate !== null && baseline !== null && baseline > 0 ? ratioLabel(rate / baseline) : "—";
}

export function modelPricingSummary(state: ModelPricingState, language: "cn" | "en"): string {
  const cn = language === "cn";
  const baseline = state.catalog?.peakBaseline;
  const ready = tokenPrice(baseline) && baseline.inputRate + baseline.outputRate > 0;
  const basis = ready ? `${DEEPSEEK_PRICE_BASELINE} ${cn ? "高峰" : "peak"} = 1×` : cn ? "DeepSeek 高峰基准价格不可用" : "DeepSeek peak baseline price unavailable";
  const cache = state.stale ? cn ? " · 缓存价格" : " · Cached prices" : "";
  return `${basis} · ${cn ? "输入:输出 1:1" : "Input:output 1:1"}${cache}`;
}

export function modelPriceView(model: string, state: ModelPricingState | null | undefined, language: "cn" | "en"): ModelPriceView | null {
  if (!state) return null;
  const cn = language === "cn";
  const unknown = (label: string, explanation = label): ModelPriceView => ({ label, title: explanation, kind: "unknown" });
  if (!state.catalog) return unknown(state.loading ? cn ? "价格加载中" : "Loading price"
    : cn ? "价格暂不可用" : "Price unavailable");
  const price = state.catalog.models.find((item) => item.model === model);
  const updated = `${cn ? "更新于" : "Updated"} ${new Date(state.catalog.fetchedAt).toLocaleString(cn ? "zh-CN" : "en-US")}`;
  const cached = state.stale ? `\n${state.failed ? cn ? "刷新失败，显示缓存价格" : "Refresh failed; showing cached prices"
    : cn ? "显示缓存价格，待刷新" : "Showing cached prices; refresh pending"}` : "";
  const detail = (text: string) => `${text}\n${updated}${cached}`;
  if (price?.billing === "per_request") return { label: "0.1", kind: "per-request", sortValue: 0.1,
    title: detail(cn ? "按次计费，无法与 DeepSeek 的 Token 单价比较" : "Per-request billing cannot be compared with DeepSeek token rates.") };
  if (price?.billing === "tiered") return unknown(cn ? "阶梯计费" : "Variable pricing",
    detail(cn ? "价格随用量或计费档位变化，暂无统一倍率" : "Pricing varies by usage or billing tier; no single multiplier is available."));
  if (!tokenPrice(price)) return unknown(cn ? "价格未知" : "Price unknown", detail(cn ? "当前账号分组的有效价格尚未确认" : "The effective price for this account group is not available."));
  if (price.inputRate === 0 && price.outputRate === 0) {
    return { label: cn ? "免费" : "Free", title: detail(cn ? "当前分组的输入、输出费率均为零" : "Input and output rates are both zero for this group."), kind: "free", sortValue: 0 };
  }
  const baseline = state.catalog.peakBaseline;
  if (!tokenPrice(baseline) || baseline.inputRate + baseline.outputRate <= 0) {
    return unknown(cn ? "基准不可用" : "Baseline unavailable", detail(modelPricingSummary(state, language)));
  }
  const ratio = (price.inputRate + price.outputRate) / (baseline.inputRate + baseline.outputRate);
  if (!Number.isFinite(ratio)) return unknown(cn ? "价格未知" : "Price unknown");
  const label = ratioLabel(ratio);
  const lines = [
    `${DEEPSEEK_PRICE_BASELINE} ${cn ? "高峰" : "peak"} = 1×`,
    cn ? `参考倍率 ${label}（输入:输出 Token 数量 1:1，不含缓存命中）` : `Reference ${label} (input:output tokens 1:1, excluding cache hits)`,
    `${cn ? "输入" : "Input"} ${relativeRate(price.inputRate, baseline.inputRate)} · ${cn ? "输出" : "Output"} ${relativeRate(price.outputRate, baseline.outputRate)}`,
    cn ? `参考上下文 ${state.catalog.referenceInputTokens} 个输入 Token；当前档位 ${tierLabel(price.tier, cn)}；DeepSeek 高峰基准`
      : `Reference context: ${state.catalog.referenceInputTokens} input tokens; model tier: ${tierLabel(price.tier, cn)}; DeepSeek peak baseline`,
  ];
  if (price.cacheReadRate !== null && baseline.cacheReadRate !== null) lines.push(`${cn ? "缓存读取" : "Cache read"} ${relativeRate(price.cacheReadRate, baseline.cacheReadRate)}`);
  if (price.cacheCreationRate !== null && baseline.cacheCreationRate !== null) lines.push(`${cn ? "缓存写入" : "Cache write"} ${relativeRate(price.cacheCreationRate, baseline.cacheCreationRate)}`);
  return { label, title: detail(lines.join("\n")), kind: "ratio", sortValue: ratio };
}
