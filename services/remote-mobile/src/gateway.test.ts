import { afterEach, describe, expect, it, vi } from "vitest";

import { bytesToBase64Url } from "./protocol";
import { GatewayApi, type ClaimedPairing } from "./gateway";

const claimed: ClaimedPairing = {
  invitation: {
    protocol_version: 1,
    pairing_id: "11111111-1111-4111-8111-111111111111",
    desktop: {
      device_id: "22222222-2222-4222-8222-222222222222",
      kind: "desktop",
      display_name: "Desktop",
      signing_public_key: bytesToBase64Url(new Uint8Array(32)),
      key_agreement_public_key: bytesToBase64Url(new Uint8Array(32)),
    },
    gateway_url: "https://remote.example.test",
    pairing_secret: bytesToBase64Url(new Uint8Array(32).fill(1)),
    expires_at_unix_ms: 10_000,
  },
  request: {
    protocol_version: 1,
    pairing_id: "11111111-1111-4111-8111-111111111111",
    pairing_secret: bytesToBase64Url(new Uint8Array(32).fill(1)),
    mobile: {
      device_id: "33333333-3333-4333-8333-333333333333",
      kind: "mobile",
      display_name: "Phone",
      signing_public_key: bytesToBase64Url(new Uint8Array(32)),
      key_agreement_public_key: bytesToBase64Url(new Uint8Array(32)),
    },
    requested_scopes: ["read_project_state"],
    requested_at_unix_ms: 1_000,
    proof: bytesToBase64Url(new Uint8Array(64)),
  },
  claim: {
    claim_id: "claim-1",
    activation_token: "a-long-activation-token-for-the-paired-mobile-device",
    status: "awaiting_approval",
    completion_expires_at_unix_ms: 9_000,
    expires_at_unix_ms: 10_000,
    ice_servers: ["stun:stun.example.test:3478"],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("GatewayApi pairing completion", () => {
  it("accepts the gateway's activation_token credential marker as the resulting bearer credential", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      device: {
        id: claimed.request.mobile.device_id,
        name: "Phone",
        role: "mobile",
        granted_scopes: ["read_project_state"],
        active: true,
      },
      credential_kind: "activation_token",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const completed = await new GatewayApi().completePairing(claimed, 2_000);
    expect(completed.credential_kind).toBe("activation_token");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the mobile-only self-revoke endpoint instead of choosing a device ID", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      revoked_device_id: claimed.request.mobile.device_id,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await new GatewayApi().revokeThisDevice(
      claimed.invitation.gateway_url,
      "paired-mobile-bearer-credential-that-is-long-enough",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, options] = call!;
    expect(new URL(String(url)).pathname).toBe("/v1/devices/self");
    expect(options).toMatchObject({
      method: "DELETE",
      headers: {
        authorization: "Bearer paired-mobile-bearer-credential-that-is-long-enough",
      },
    });
  });

  it("validates the authenticated device record before the PWA uses it", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      device: {
        id: claimed.request.mobile.device_id,
        name: "Phone",
        role: "mobile",
        granted_scopes: ["read_project_state", "send_chat_messages"],
        active: true,
      },
      paired_devices: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new GatewayApi().currentDevice(
      claimed.invitation.gateway_url,
      "paired-mobile-bearer-credential-that-is-long-enough",
    )).resolves.toMatchObject({ device: { role: "mobile" } });
  });

  it("rejects malformed scope records from the gateway", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      device: {
        id: claimed.request.mobile.device_id,
        name: "Phone",
        role: "mobile",
        granted_scopes: ["filesystem_access"],
        active: true,
      },
      paired_devices: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(new GatewayApi().currentDevice(
      claimed.invitation.gateway_url,
      "paired-mobile-bearer-credential-that-is-long-enough",
    )).rejects.toThrow("invalid device record");
  });
});
