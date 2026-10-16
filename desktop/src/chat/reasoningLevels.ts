// Keep the application default aligned with crates/executor/src/reasoning_effort.rs.
export const DEFAULT_REASONING_EFFORT = "high";

const LEVEL_NAMES: Record<string, { en: string; cn: string }> = {
  none: { en: "No thinking", cn: "不思考" },
  minimal: { en: "Minimal", cn: "最少" },
  low: { en: "Low", cn: "低" },
  medium: { en: "Medium", cn: "中" },
  high: { en: "High", cn: "高" },
  xhigh: { en: "Extra high", cn: "很高" },
  max: { en: "Max", cn: "最高" },
};

export function reasoningLevelName(level: string, language: "cn" | "en") {
  const name = LEVEL_NAMES[level];
  return name ? name[language] : level;
}
