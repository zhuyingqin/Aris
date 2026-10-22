import type { ChatModelOption } from "../types";

const MODEL_SERIES = [
  "GPT", "Claude", "Gemini", "DeepSeek", "MiniMax", "Qwen", "GLM",
  "Kimi", "Laya", "LongCat", "MiMo", "Mistral", "Llama", "Gemma",
];

export interface ChatModelGroup {
  series: string;
  label: string;
  options: ChatModelOption[];
}

/** Retain category order, optionally sorting each category by numeric price. */
export function groupChatModels(
  options: readonly ChatModelOption[],
  otherLabel: string,
  priceSortValues?: ReadonlyMap<string, number>,
): ChatModelGroup[] {
  const groups = new Map<string, ChatModelGroup>();
  for (const option of options) {
    // Also recognize IDs routed through a provider prefix, such as openai/gpt-6.1-sol.
    const name = (option.value.split("/").pop() ?? option.value).toLowerCase();
    const series = MODEL_SERIES.find((candidate) => {
      const prefix = candidate.toLowerCase();
      return name.startsWith(prefix) && /^(?:$|[-_.\s\d])/.test(name.slice(prefix.length));
    }) ?? "other";
    let group = groups.get(series);
    if (!group) {
      group = { series, label: series === "other" ? otherLabel : series, options: [] };
      groups.set(series, group);
    }
    group.options.push(option);
  }
  return Array.from(groups.values(), (group) => {
    if (priceSortValues) group.options.sort((a, b) => {
      const left = priceSortValues.get(a.value) ?? Infinity;
      const right = priceSortValues.get(b.value) ?? Infinity;
      return left === right ? 0 : left - right;
    });
    return group;
  });
}
