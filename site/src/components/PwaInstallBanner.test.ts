import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPwaStorageKey,
  isPwaPromptHandled,
  setPwaPromptHandled,
  PWA_STORAGE_KEY_PREFIX,
} from "./PwaInstallBanner";

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

describe("PwaInstallBanner storage and user-binding helper functions", () => {
  const originalWindow = globalThis.window;
  let mockStorage: MemoryStorage;

  beforeEach(() => {
    mockStorage = new MemoryStorage();
    (globalThis as any).window = {
      localStorage: mockStorage,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).window = originalWindow;
  });

  it("generates correct storage key with prefix and user id", () => {
    expect(getPwaStorageKey(101)).toBe(`${PWA_STORAGE_KEY_PREFIX}101`);
    expect(getPwaStorageKey(101)).toBe("somniq_pwa_installed_or_dismissed_101");
    expect(getPwaStorageKey("user-xyz")).toBe("somniq_pwa_installed_or_dismissed_user-xyz");
  });

  it("returns false for unhandled user or when user id is undefined", () => {
    expect(isPwaPromptHandled(undefined)).toBe(false);
    expect(isPwaPromptHandled(0)).toBe(false);
    expect(isPwaPromptHandled(101)).toBe(false);
  });

  it("sets and gets handled status correctly for a specific user id", () => {
    const userId = 42;
    expect(isPwaPromptHandled(userId)).toBe(false);

    setPwaPromptHandled(userId);
    expect(mockStorage.getItem(`somniq_pwa_installed_or_dismissed_${userId}`)).toBe("true");
    expect(isPwaPromptHandled(userId)).toBe(true);

    // Another user should still be unhandled
    const anotherUser = 99;
    expect(isPwaPromptHandled(anotherUser)).toBe(false);
  });

  it("handles storage exceptions gracefully when localStorage is unavailable", () => {
    (globalThis as any).window = {
      get localStorage() {
        throw new Error("SecurityError: Access is denied");
      },
    };

    expect(() => setPwaPromptHandled(101)).not.toThrow();
    expect(isPwaPromptHandled(101)).toBe(false);
  });
});
