import type { Language } from "../store";
// Keep the application default aligned with crates/executor/src/reasoning_effort.rs.
export const DEFAULT_REASONING_EFFORT = "high";

const LEVEL_NAMES: Record<string, Record<Language, string>> = {
  none: { en: "No thinking", cn: "不思考", es: "Sin razonamiento" },
  minimal: { en: "Minimal", cn: "最少", es: "Mínimo" },
  low: { en: "Low", cn: "低", es: "Bajo" },
  medium: { en: "Medium", cn: "中", es: "Medio" },
  high: { en: "High", cn: "高", es: "Alto" },
  xhigh: { en: "Extra high", cn: "很高", es: "Muy alto" },
  max: { en: "Max", cn: "最高", es: "Máximo" },
};

export function reasoningLevelName(level: string, language: Language) {
  const name = LEVEL_NAMES[level];
  return name ? name[language] : level;
}
