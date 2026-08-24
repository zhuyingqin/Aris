import { describe, expect, it } from "vitest";

import { SecureEnvelopeCodec } from "./envelope";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PHONE_ID = "22222222-2222-4222-8222-222222222222";
const DESKTOP_ID = "33333333-3333-4333-8333-333333333333";
const KEY = new Uint8Array(32).fill(7);

describe("SecureEnvelopeCodec", () => {
  it("round-trips an XChaCha20-Poly1305 envelope in the opposite direction", async () => {
    const phone = new SecureEnvelopeCodec({
      sessionKey: KEY,
      sessionId: SESSION_ID,
      localDeviceId: PHONE_ID,
      peerDeviceId: DESKTOP_ID,
      now: () => 1_000,
    });
    const desktop = new SecureEnvelopeCodec({
      sessionKey: KEY,
      sessionId: SESSION_ID,
      localDeviceId: DESKTOP_ID,
      peerDeviceId: PHONE_ID,
      now: () => 1_000,
    });

    const encrypted = await phone.seal(new Uint8Array([1, 2, 3, 4]));
    expect(await desktop.open(encrypted)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("rejects replayed and tampered ciphertext without accepting either", async () => {
    const phone = new SecureEnvelopeCodec({
      sessionKey: KEY,
      sessionId: SESSION_ID,
      localDeviceId: PHONE_ID,
      peerDeviceId: DESKTOP_ID,
      now: () => 1_000,
    });
    const desktop = new SecureEnvelopeCodec({
      sessionKey: KEY,
      sessionId: SESSION_ID,
      localDeviceId: DESKTOP_ID,
      peerDeviceId: PHONE_ID,
      now: () => 1_000,
    });
    const encrypted = await phone.seal(new Uint8Array([9]));
    const tampered = JSON.parse(new TextDecoder().decode(encrypted)) as { ciphertext: string };
    // Mutate a leading base64url character. Replacing the final character
    // could accidentally preserve the decoded bytes when its unused padding
    // bits differ, making this authentication test flaky.
    tampered.ciphertext = `${tampered.ciphertext[0] === "A" ? "B" : "A"}${tampered.ciphertext.slice(1)}`;

    await expect(desktop.open(new TextEncoder().encode(JSON.stringify(tampered)))).rejects.toThrow("authenticated");
    expect(await desktop.open(encrypted)).toEqual(new Uint8Array([9]));
    await expect(desktop.open(encrypted)).rejects.toThrow("already accepted");
  });
});
