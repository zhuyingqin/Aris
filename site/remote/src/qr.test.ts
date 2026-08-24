import { describe, expect, it } from "vitest";

import { bytesToBase64Url, RemoteProtocolError } from "./protocol";
import {
  normalizePastedPairingCode,
  pairingDeepLinkFragment,
  pairingDeepLinkFragmentFromPastedCode,
  pairingPayloadFromDeepLinkFragment,
  pairingPayloadFromQrContent,
} from "./qr";

describe("SomniQ pairing QR links", () => {
  it("decodes the desktop deep link while retaining legacy raw JSON QR content", () => {
    const legacyInvitation = JSON.stringify({ pairing_id: "one-time-secret-is-not-logged" });
    const encoded = bytesToBase64Url(new TextEncoder().encode(legacyInvitation));
    const deepLink = `https://remote.example.test/remote/pair#p=${encoded}`;

    expect(pairingPayloadFromDeepLinkFragment(`#p=${encoded}`)).toBe(legacyInvitation);
    expect(pairingPayloadFromQrContent(deepLink)).toBe(legacyInvitation);
    expect(pairingPayloadFromQrContent(legacyInvitation)).toBe(legacyInvitation);
  });

  it("rejects malformed deep-link payloads rather than treating them as legacy JSON", () => {
    expect(() => pairingPayloadFromDeepLinkFragment("#p=not-valid-json")).toThrow("配对链接");
  });

  it("survives a connection code that picked up line breaks on its way through the clipboard", () => {
    const invitation = JSON.stringify({ pairing_id: "one-time-secret-is-not-logged" });
    const encoded = bytesToBase64Url(new TextEncoder().encode(invitation));
    const deepLink = `https://remote.example.test/remote/pair#p=${encoded}`;
    const wrapped = `  ${deepLink.slice(0, 20)}\n${deepLink.slice(20, 40)}\r\n  ${deepLink.slice(40)}  `;

    expect(normalizePastedPairingCode(wrapped)).toBe(deepLink);
    expect(pairingPayloadFromQrContent(normalizePastedPairingCode(wrapped))).toBe(invitation);
  });

  it("keeps real spaces inside a legacy raw-JSON invitation", () => {
    // Collapsing whitespace here would corrupt desktop display names.
    const legacy = '{"pairing_id":"x","desktop":{"display_name":"My Mac Studio"}}';

    expect(normalizePastedPairingCode(`\n  ${legacy}\n`)).toBe(legacy);
  });
});

describe("pasted connection codes", () => {
  const payload = JSON.stringify({ pairing_id: "p-1", gateway_url: "https://somni.chat" });
  const fragment = pairingDeepLinkFragment(payload);

  it("round-trips a payload through the fragment the PWA reads", () => {
    expect(pairingPayloadFromDeepLinkFragment(fragment)).toBe(payload);
  });

  it("survives a payload carrying non-ASCII device names", () => {
    const chinese = JSON.stringify({ desktop: { display_name: "我的研究工作站" } });
    expect(pairingPayloadFromDeepLinkFragment(pairingDeepLinkFragment(chinese))).toBe(chinese);
  });

  it("accepts every shape a connection code arrives in", () => {
    // The desktop's copy button hands over a full deep link.
    expect(pairingDeepLinkFragmentFromPastedCode(`https://somni.chat/remote/pair${fragment}`)).toBe(fragment);
    // Chat clients readily wrap it, and a code can arrive as the bare parts.
    expect(pairingDeepLinkFragmentFromPastedCode(`  ${fragment}  `)).toBe(fragment);
    expect(pairingDeepLinkFragmentFromPastedCode(fragment.slice("#p=".length))).toBe(fragment);
    expect(pairingPayloadFromDeepLinkFragment(pairingDeepLinkFragmentFromPastedCode(payload))).toBe(payload);
  });

  it("repairs a code broken across lines instead of rejecting it", () => {
    const wrapped = `${fragment.slice(0, 12)}\n   ${fragment.slice(12)}`;
    expect(pairingDeepLinkFragmentFromPastedCode(wrapped)).toBe(fragment);
  });

  it("refuses a link that carries no pairing payload rather than dropping it", () => {
    // The website used to fall back to an empty /remote/ here, losing the code
    // with no error at all.
    expect(() => pairingDeepLinkFragmentFromPastedCode("https://somni.chat/remote/?desktop=abc"))
      .toThrow(RemoteProtocolError);
    expect(() => pairingDeepLinkFragmentFromPastedCode("#p=")).toThrow(RemoteProtocolError);
    expect(() => pairingDeepLinkFragmentFromPastedCode("   ")).toThrow(RemoteProtocolError);
  });
});
