import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectLang, persistLang, resolveGeoLang, updateUrlLang, withLangParam, STORAGE_KEY } from "./i18n";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

describe("i18n region and language detection", () => {
  const originalWindow = globalThis.window;
  let mockStorage: MemoryStorage;
  let historyMock: { replaceState: ReturnType<typeof vi.fn>; state: any };

  beforeEach(() => {
    mockStorage = new MemoryStorage();
    historyMock = {
      replaceState: vi.fn(),
      state: null,
    };
    (globalThis as any).window = {
      localStorage: mockStorage,
      location: {
        search: "",
        pathname: "/",
        hash: "",
      },
      history: historyMock,
    };
    Object.defineProperty(globalThis, "navigator", {
      value: {
        language: "en-US",
        languages: ["en-US", "en"],
      },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).window = originalWindow;
  });

  it("prioritizes ?lang=en URL query parameter and persists it", () => {
    window.location.search = "?lang=en";
    const lang = detectLang();
    expect(lang).toBe("en");
    expect(mockStorage.getItem(STORAGE_KEY)).toBe("en");
  });

  it("prioritizes ?lang=zh URL query parameter and persists it", () => {
    window.location.search = "?lang=zh-CN";
    const lang = detectLang();
    expect(lang).toBe("zh");
    expect(mockStorage.getItem(STORAGE_KEY)).toBe("zh");
  });

  it("supports ?locale=en and ?hl=zh aliases", () => {
    window.location.search = "?locale=en-US";
    expect(detectLang()).toBe("en");

    window.location.search = "?hl=zh_CN";
    expect(detectLang()).toBe("zh");
  });

  it("respects user explicit choice in localStorage", () => {
    persistLang("en");
    expect(detectLang()).toBe("en");

    persistLang("zh");
    expect(detectLang()).toBe("zh");

    persistLang("es");
    expect(detectLang()).toBe("es");
  });

  it("prioritizes ?lang=es URL query parameter and persists it", () => {
    window.location.search = "?lang=es";
    const lang = detectLang();
    expect(lang).toBe("es");
    expect(mockStorage.getItem(STORAGE_KEY)).toBe("es");
  });

  it("supports ?locale=es and ?hl=es aliases", () => {
    window.location.search = "?locale=es-ES";
    expect(detectLang()).toBe("es");

    window.location.search = "?hl=es_MX";
    expect(detectLang()).toBe("es");
  });

  it("detects Spanish from Spanish timezones when no manual preference exists", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () =>
        ({
          resolvedOptions: () => ({ timeZone: "Europe/Madrid" }),
        }) as any,
    );

    const lang = detectLang();
    expect(lang).toBe("es");
  });

  it("detects Chinese from China timezones when no manual preference exists", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () =>
        ({
          resolvedOptions: () => ({ timeZone: "Asia/Shanghai" }),
        }) as any,
    );

    const lang = detectLang();
    expect(lang).toBe("zh");
  });

  it("detects English from overseas timezones when primary browser language is English", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () =>
        ({
          resolvedOptions: () => ({ timeZone: "America/New_York" }),
        }) as any,
    );

    Object.defineProperty(globalThis, "navigator", {
      value: {
        language: "en-US",
        languages: ["en-US", "en"],
      },
      configurable: true,
      writable: true,
    });

    const lang = detectLang();
    expect(lang).toBe("en");
  });

  it("resolveGeoLang fetches /v1/geo and triggers callback with resolved lang", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ country: "US", is_china: false, lang: "en" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    let callbackLang: string | null = null;
    const resolved = await resolveGeoLang((lang) => {
      callbackLang = lang;
    });

    expect(resolved).toBe("en");
    expect(callbackLang).toBe("en");
  });

  it("resolveGeoLang recognizes CN as zh", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ country: "CN", is_china: true, lang: "zh" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    let callbackLang: string | null = null;
    const resolved = await resolveGeoLang((lang) => {
      callbackLang = lang;
    });

    expect(resolved).toBe("zh");
    expect(callbackLang).toBe("zh");
  });

  it("resolveGeoLang recognizes ES and MX as es", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ country: "ES", is_china: false, lang: "es" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    let callbackLang: string | null = null;
    const resolved = await resolveGeoLang((lang) => {
      callbackLang = lang;
    });

    expect(resolved).toBe("es");
    expect(callbackLang).toBe("es");
  });

  it("resolveGeoLang skips resolution if user already has an explicit choice in localStorage", async () => {
    persistLang("zh");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolveGeoLang();
    expect(resolved).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("updateUrlLang sets ?lang=en when query is empty and updates history", () => {
    window.location.pathname = "/";
    window.location.search = "";
    window.location.hash = "";

    updateUrlLang("en");

    expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/?lang=en");
  });

  it("updateUrlLang preserves other query params and hash when switching to zh", () => {
    window.location.pathname = "/pricing.html";
    window.location.search = "?theme=dark&preview=1";
    window.location.hash = "#faq";

    updateUrlLang("zh");

    expect(window.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/pricing.html?theme=dark&preview=1&lang=zh#faq",
    );
  });

  it("updateUrlLang handles es properly", () => {
    window.location.pathname = "/";
    window.location.search = "?lang=en";
    window.location.hash = "";

    updateUrlLang("es");

    expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/?lang=es");
  });

  it("updateUrlLang replaces existing lang, locale, and hl params", () => {
    window.location.pathname = "/";
    window.location.search = "?locale=en_US&hl=en&lang=en";
    window.location.hash = "";

    updateUrlLang("zh");

    expect(window.history.replaceState).toHaveBeenCalledWith(null, "", "/?lang=zh");
  });

  it("withLangParam correctly formats internal URLs with lang param", () => {
    expect(withLangParam("./", "en")).toBe("./?lang=en");
    expect(withLangParam("./pricing.html", "zh")).toBe("./pricing.html?lang=zh");
    expect(withLangParam("./pricing.html", "es")).toBe("./pricing.html?lang=es");
    expect(withLangParam("./#review", "en")).toBe("./?lang=en#review");
    expect(withLangParam("./pricing.html?theme=dark#plans", "en")).toBe("./pricing.html?theme=dark&lang=en#plans");
    expect(withLangParam("#does", "en")).toBe("#does");
    expect(withLangParam("https://somni.chat/releases/app.exe", "en")).toBe("https://somni.chat/releases/app.exe");
  });
});
