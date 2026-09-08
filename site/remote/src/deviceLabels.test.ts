import { describe, expect, it } from "vitest";

import {
  androidModelFromUserAgent,
  defaultClientDeviceName,
  desktopDisplayLabel,
  desktopShortCode,
  resolveClientDeviceName,
} from "./deviceLabels";
import type { DeviceDescriptor } from "./types";

const first: DeviceDescriptor = {
  device_id: "11111111-1111-4111-8111-111111abcdef",
  kind: "desktop",
  display_name: "SomniQ Desktop",
  signing_public_key: "first-signing-key",
  key_agreement_public_key: "first-agreement-key",
};

const second: DeviceDescriptor = {
  ...first,
  device_id: "22222222-2222-4222-8222-222222123456",
  signing_public_key: "second-signing-key",
  key_agreement_public_key: "second-agreement-key",
};

describe("desktop device labels", () => {
  it("keeps a unique desktop name unchanged", () => {
    expect(desktopDisplayLabel(first, [first])).toBe("SomniQ Desktop");
  });

  it("adds stable short codes when paired desktops have the same name", () => {
    expect(desktopDisplayLabel(first, [first, second])).toBe("SomniQ Desktop · ABCDEF");
    expect(desktopDisplayLabel(second, [first, second])).toBe("SomniQ Desktop · 123456");
  });

  it("normalizes UUID separators and casing for the short code", () => {
    expect(desktopShortCode("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEfedcba")).toBe("FEDCBA");
  });
});

describe("naming the browser that is doing the pairing", () => {
  const CHROME_WINDOWS =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const EDGE_WINDOWS = `${CHROME_WINDOWS} Edg/131.0.0.0`;
  const SAFARI_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const ANDROID_PHONE =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

  it("never files a computer browser as a phone", () => {
    // The connection code exists so a camera-less computer can pair; calling
    // it 「我的手机」 would make the owner's device list unreadable.
    expect(defaultClientDeviceName(CHROME_WINDOWS)).toBe("Windows · Chrome");
    expect(defaultClientDeviceName(EDGE_WINDOWS)).toBe("Windows · Edge");
    expect(defaultClientDeviceName(SAFARI_MAC)).toBe("Mac · Safari");
  });

  it("uses the Android model when the user agent still carries one", () => {
    expect(defaultClientDeviceName(ANDROID_PHONE)).toBe("Pixel 8");
    expect(androidModelFromUserAgent(
      "Mozilla/5.0 (Linux; Android 13; M2102J2SC Build/TKQ1.220829.002) AppleWebKit/537.36",
    )).toBe("M2102J2SC");
  });

  it("does not label every modern Android phone \"K\"", () => {
    // Chrome 110+ reduces the Android user agent and substitutes this exact
    // placeholder for the real model, so it is the most common value there.
    const REDUCED =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    expect(androidModelFromUserAgent(REDUCED)).toBeNull();
    expect(defaultClientDeviceName(REDUCED)).toBe("Android 手机");
    // Firefox puts a form factor where the model would be.
    expect(androidModelFromUserAgent("Mozilla/5.0 (Android 14; Mobile; rv:131.0) Firefox/131.0"))
      .toBeNull();
  });

  it("recovers the model from client hints once the string stops carrying it", async () => {
    const REDUCED =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
    await expect(resolveClientDeviceName(REDUCED, {
      getHighEntropyValues: async () => ({ model: "Pixel 8" }),
    })).resolves.toBe("Pixel 8");

    // Refused or empty hints must fall back rather than throw.
    await expect(resolveClientDeviceName(REDUCED, {
      getHighEntropyValues: async () => { throw new Error("declined"); },
    })).resolves.toBe("Android 手机");
    await expect(resolveClientDeviceName(REDUCED, {
      getHighEntropyValues: async () => ({ model: "K" }),
    })).resolves.toBe("Android 手机");
  });

  it("cannot invent an iPhone model, and does not try", async () => {
    // Apple ships the same user agent for every iPhone and exposes no client
    // hints, so anything more specific here would be a guess.
    expect(defaultClientDeviceName(IPHONE)).toBe("iPhone");
    await expect(resolveClientDeviceName(IPHONE, null)).resolves.toBe("iPhone");
  });

  it("degrades to something honest rather than guessing", () => {
    expect(defaultClientDeviceName("")).toBe("网页浏览器");
    expect(defaultClientDeviceName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux 浏览器");
  });
});
