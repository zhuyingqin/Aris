import { describe, expect, it } from "vitest";

import {
  isEphemeralEmbedding,
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

describe("embedding that actually threatens a pairing", () => {
  it("does not treat a same-origin frame as ephemeral", () => {
    // The account console embeds this app in an iframe on its own origin, so
    // blocking there made the connect flow a guaranteed dead end: the request
    // reached the desktop but the signed claim could never be submitted.
    expect(isEphemeralEmbedding("https://somni.chat", "https://somni.chat")).toBe(false);
  });

  it("still refuses a cross-origin or unreadable parent", () => {
    expect(isEphemeralEmbedding("https://elsewhere.example", "https://somni.chat")).toBe(true);
    expect(isEphemeralEmbedding(null, "https://somni.chat")).toBe(true);
  });
});
