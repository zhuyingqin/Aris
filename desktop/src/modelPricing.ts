import { languageLocale, tr, type Language } from "./language";
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

function tierLabel(tier: string | null, language: Language): string {
  if (!tier) return tr(language, "标准", "Standard", "Estándar");
  if (language === "cn") return ({ peak: "高峰", off_peak: "低峰", standard: "标准", base: "基础" } as Record<string, string>)[tier] ?? tier;
  if (language === "es") return ({ peak: "pico", off_peak: "valle", standard: "estándar", base: "base" } as Record<string, string>)[tier] ?? tier;
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

export function modelPricingSummary(state: ModelPricingState, language: Language): string {
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const baseline = state.catalog?.peakBaseline;
  const ready = tokenPrice(baseline) && baseline.inputRate + baseline.outputRate > 0;
  const basis = ready ? `${DEEPSEEK_PRICE_BASELINE} ${t("高峰", "peak", "pico")} = 1×` : t("DeepSeek 高峰基准价格不可用", "DeepSeek peak baseline price unavailable", "Precio base de DeepSeek en hora pico no disponible");
  const cache = state.stale ? t(" · 缓存价格", " · Cached prices", " · Precios en caché") : "";
  return `${basis} · ${t("输入:输出 1:1", "Input:output 1:1", "Entrada:salida 1:1")}${cache}`;
}

export function modelPriceView(model: string, state: ModelPricingState | null | undefined, language: Language): ModelPriceView | null {
  if (!state) return null;
  const t = (cn: string, en: string, es: string) => tr(language, cn, en, es);
  const unknown = (label: string, explanation = label): ModelPriceView => ({ label, title: explanation, kind: "unknown" });
  if (!state.catalog) return unknown(state.loading ? t("价格加载中", "Loading price", "Cargando precio")
    : t("价格暂不可用", "Price unavailable", "Precio no disponible"));
  const price = state.catalog.models.find((item) => item.model === model);
  const updated = `${t("更新于", "Updated", "Actualizado")} ${new Date(state.catalog.fetchedAt).toLocaleString(languageLocale(language))}`;
  const cached = state.stale ? `\n${state.failed ? t("刷新失败，显示缓存价格", "Refresh failed; showing cached prices", "Error al actualizar; se muestran precios en caché")
    : t("显示缓存价格，待刷新", "Showing cached prices; refresh pending", "Se muestran precios en caché; actualización pendiente")}` : "";
  const detail = (text: string) => `${text}\n${updated}${cached}`;
  if (price?.billing === "per_request") return { label: "0.1", kind: "per-request", sortValue: 0.1,
    title: detail(t("按次计费，无法与 DeepSeek 的 Token 单价比较", "Per-request billing cannot be compared with DeepSeek token rates.", "La facturación por solicitud no se puede comparar con las tarifas por token de DeepSeek.")) };
  if (price?.billing === "tiered") return unknown(t("阶梯计费", "Tiered pricing", "Precio escalonado"),
    detail(t("价格随用量或计费档位变化，暂无统一倍率", "Pricing varies by usage or billing tier; no single multiplier is available.", "El precio varía según el uso o el nivel de facturación; no hay un multiplicador único.")));
  if (!tokenPrice(price)) return unknown(t("价格未知", "Price unknown", "Precio desconocido"), detail(t("当前账号分组的有效价格尚未确认", "The effective price for this account group is not available.", "El precio efectivo para el grupo de esta cuenta no está disponible.")));
  if (price.inputRate === 0 && price.outputRate === 0) {
    return { label: t("免费", "Free", "Gratis"), title: detail(t("当前分组的输入、输出费率均为零", "Input and output rates are both zero for this group.", "Las tarifas de entrada y salida de este grupo son cero.")), kind: "free", sortValue: 0 };
  }
  const baseline = state.catalog.peakBaseline;
  if (!tokenPrice(baseline) || baseline.inputRate + baseline.outputRate <= 0) {
    return unknown(t("基准不可用", "Baseline unavailable", "Referencia no disponible"), detail(modelPricingSummary(state, language)));
  }
  const ratio = (price.inputRate + price.outputRate) / (baseline.inputRate + baseline.outputRate);
  if (!Number.isFinite(ratio)) return unknown(t("价格未知", "Price unknown", "Precio desconocido"));
  const label = ratioLabel(ratio);
  const lines = [
    `${DEEPSEEK_PRICE_BASELINE} ${t("高峰", "peak", "pico")} = 1×`,
    t(`参考倍率 ${label}（输入:输出 Token 数量 1:1，不含缓存命中）`, `Reference ${label} (input:output tokens 1:1, excluding cache hits)`, `Referencia ${label} (tokens de entrada:salida 1:1, sin aciertos de caché)`),
    `${t("输入", "Input", "Entrada")} ${relativeRate(price.inputRate, baseline.inputRate)} · ${t("输出", "Output", "Salida")} ${relativeRate(price.outputRate, baseline.outputRate)}`,
    t(`参考上下文 ${state.catalog.referenceInputTokens} 个输入 Token；当前档位 ${tierLabel(price.tier, language)}；DeepSeek 高峰基准`,
      `Reference context: ${state.catalog.referenceInputTokens} input tokens; model tier: ${tierLabel(price.tier, language)}; DeepSeek peak baseline`,
      `Contexto de referencia: ${state.catalog.referenceInputTokens} tokens de entrada; nivel del modelo: ${tierLabel(price.tier, language)}; referencia de DeepSeek en hora pico`),
  ];
  if (price.cacheReadRate !== null && baseline.cacheReadRate !== null) lines.push(`${t("缓存读取", "Cache read", "Lectura de caché")} ${relativeRate(price.cacheReadRate, baseline.cacheReadRate)}`);
  if (price.cacheCreationRate !== null && baseline.cacheCreationRate !== null) lines.push(`${t("缓存写入", "Cache write", "Escritura de caché")} ${relativeRate(price.cacheCreationRate, baseline.cacheCreationRate)}`);
  return { label, title: detail(lines.join("\n")), kind: "ratio", sortValue: ratio };
}
