import { describe, expect, it } from "vitest";

import {
  bytesToBase64Url,
  createSignedPairingRequest,
  parsePairingInvitation,
} from "./protocol";
import type { DeviceDescriptor, MobileSigningIdentity, PairingInvitation } from "./types";

const DESKTOP: DeviceDescriptor = {
  device_id: "11111111-1111-4111-8111-111111111111",
  kind: "desktop",
  display_name: "Research desktop",
  signing_public_key: bytesToBase64Url(new Uint8Array(32).fill(1)),
  key_agreement_public_key: bytesToBase64Url(new Uint8Array(32).fill(2)),
};
const MOBILE: DeviceDescriptor = {
  device_id: "22222222-2222-4222-8222-222222222222",
  kind: "mobile",
  display_name: "My phone",
  signing_public_key: bytesToBase64Url(new Uint8Array(32).fill(3)),
  key_agreement_public_key: bytesToBase64Url(new Uint8Array(32).fill(4)),
};

function invitation(): PairingInvitation {
  return {
    protocol_version: 1,
    pairing_id: "33333333-3333-4333-8333-333333333333",
    desktop: DESKTOP,
    gateway_url: "https://remote.example.test",
    pairing_secret: bytesToBase64Url(new Uint8Array(32).fill(5)),
    expires_at_unix_ms: 10_000,
  };
}

describe("QR pairing protocol", () => {
  it("uses stable protocol scope order and signs the canonical request", async () => {
    const signedTranscripts: Uint8Array[] = [];
    let signatureCalls = 0;
    const signPairingTranscript = async (transcript: Uint8Array): Promise<Uint8Array> => {
      signatureCalls += 1;
      signedTranscripts.push(transcript);
      return new Uint8Array(64).fill(9);
    };
    const identity: MobileSigningIdentity = { descriptor: MOBILE, signPairingTranscript };
    const request = await createSignedPairingRequest(
      invitation(),
      identity,
      ["read_review_conclusions", "read_project_state", "read_project_state"],
      1_000,
    );

    expect(request.requested_scopes).toEqual(["read_project_state", "read_review_conclusions"]);
    expect(request.proof).toBe(bytesToBase64Url(new Uint8Array(64).fill(9)));
    expect(signatureCalls).toBe(1);
    expect(signedTranscripts).toHaveLength(1);
    const transcript = signedTranscripts[0];
    if (!transcript) {
      throw new Error("The signing callback did not receive a transcript.");
    }
    expect(new TextDecoder().decode(transcript.slice(0, 33))).toBe("somniq-remote/pairing-request/v1\0");
  });

  it("rejects a lookalike non-TLS gateway host", () => {
    const unsafe = { ...invitation(), gateway_url: "http://localhost.evil.test" };
    expect(() => parsePairingInvitation(JSON.stringify(unsafe), 1_000)).toThrow("HTTPS/WSS");
  });
});
