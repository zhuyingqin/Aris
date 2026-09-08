import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../i18n";

describe("LanguageSelector and LANGUAGES configuration", () => {
  it("includes options for zh, en, and es", () => {
    const codes = LANGUAGES.map((l) => l.code);
    expect(codes).toContain("zh");
    expect(codes).toContain("en");
    expect(codes).toContain("es");
  });

  it("has valid flags and native labels for all languages", () => {
    for (const lang of LANGUAGES) {
      expect(lang.code).toBeTruthy();
      expect(lang.nativeLabel).toBeTruthy();
      expect(lang.flag).toBeTruthy();
    }

    const zh = LANGUAGES.find((l) => l.code === "zh");
    expect(zh?.nativeLabel).toBe("简体中文");
    expect(zh?.flag).toBe("🇨🇳");

    const en = LANGUAGES.find((l) => l.code === "en");
    expect(en?.nativeLabel).toBe("English");
    expect(en?.flag).toBe("🇺🇸");

    const es = LANGUAGES.find((l) => l.code === "es");
    expect(es?.nativeLabel).toBe("Español");
    expect(es?.flag).toBe("🇪🇸");
  });
});
