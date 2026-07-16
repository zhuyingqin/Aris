import { describe, expect, it } from "vitest";

import {
  isStandalonePairingContainer,
  pairingBrowserContext,
  pairingBrowserContextLabel,
} from "./pairingContext";

describe("pairing browser context", () => {
  it("blocks known in-app browsers for a first pairing", () => {
    expect(pairingBrowserContext("Mozilla/5.0 MicroMessenger/8.0", false)).toBe("wechat");
    expect(pairingBrowserContext("Mozilla/5.0 QQ/9.1", false)).toBe("qq");
    expect(pairingBrowserContext("Mozilla/5.0 DingTalk/7.0", false)).toBe("dingtalk");
  });

  it("blocks an embedded frame before inspecting the user agent", () => {
    expect(pairingBrowserContext("Mozilla/5.0", true)).toBe("embedded");
  });

  it("allows a normal browser and provides the user-facing context label", () => {
    expect(pairingBrowserContext("Mozilla/5.0 Chrome/126.0 Mobile Safari/537.36", false)).toBeNull();
    expect(pairingBrowserContextLabel("wechat")).toBe("微信内置浏览器");
  });

  it("recognizes the iOS home-screen container", () => {
    expect(isStandalonePairingContainer(true, false)).toBe(true);
    expect(isStandalonePairingContainer(false, true)).toBe(true);
    expect(isStandalonePairingContainer(false, false)).toBe(false);
  });
});
