/** UI languages. Dependency-free so formatters and tests can import it without the store. */
export const LANGUAGES = ["cn", "en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** Each language's name in its own script, for language pickers. */
export const LANGUAGE_OPTIONS: ReadonlyArray<{ value: Language; label: string }> = [
  { value: "en", label: "English" },
  { value: "cn", label: "简体中文" },
  { value: "es", label: "Español" },
];

/** English name of the language, for model prompts that must name the output language. */
export function languagePromptName(language: Language): string {
  return language === "cn" ? "Simplified Chinese (zh-CN)" : language === "es" ? "Spanish (es-ES)" : "English";
}

/** BCP 47 tag for `<html lang>`, `Intl` formatters and `toLocale*String`. */
export function languageLocale(language: Language): string {
  return language === "cn" ? "zh-CN" : language === "es" ? "es-ES" : "en";
}

/**
 * Pick the copy for `language` from one value per language, in the fixed order
 * Chinese, English, Spanish. Use this instead of `language === "cn" ? a : b`,
 * which silently shows English to Spanish users.
 */
export function tr<T>(language: Language, cn: T, en: T, es: T): T {
  return language === "cn" ? cn : language === "es" ? es : en;
}
