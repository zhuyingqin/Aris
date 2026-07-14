import { describe, expect, it } from "vitest";

import { bytesToBase64Url } from "./protocol";
import { pairingPayloadFromDeepLinkFragment, pairingPayloadFromQrContent } from "./qr";

describe("SomniQ pairing QR links", () => {
  it("decodes the desktop deep link while retaining legacy raw JSON QR content", () => {
    const legacyInvitation = JSON.stringify({ pairing_id: "one-time-secret-is-not-logged" });
    const encoded = bytesToBase64Url(new TextEncoder().encode(legacyInvitation));
    const deepLink = `https://remote.example.test/pair#p=${encoded}`;

    expect(pairingPayloadFromDeepLinkFragment(`#p=${encoded}`)).toBe(legacyInvitation);
    expect(pairingPayloadFromQrContent(deepLink)).toBe(legacyInvitation);
    expect(pairingPayloadFromQrContent(legacyInvitation)).toBe(legacyInvitation);
  });

  it("rejects malformed deep-link payloads rather than treating them as legacy JSON", () => {
    expect(() => pairingPayloadFromDeepLinkFragment("#p=not-valid-json")).toThrow("配对链接");
  });
});
