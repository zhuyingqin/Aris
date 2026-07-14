import {
  createSignedPairingRequest,
  gatewayEndpoint,
  parsePairingInvitation,
  RemoteProtocolError,
} from "./protocol";
import type {
  ClaimPairingResponse,
  CompletePairingResponse,
  MeResponse,
  MobileSigningIdentity,
  PairingInvitation,
  PairingRequest,
} from "./types";
import type { DeviceScope } from "./types";

export class GatewayApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayApiError";
  }

  get isAwaitingDesktopApproval(): boolean {
    return this.status === 409 || this.status === 423;
  }
}

export interface ClaimedPairing {
  invitation: PairingInvitation;
  request: PairingRequest;
  claim: ClaimPairingResponse;
}

/**
 * Browser adapter for the deliberately small gateway HTTP API. It never
 * serializes bearer or activation credentials to localStorage; the caller
 * chooses an explicit native secure-store integration after completion.
 */
export class GatewayApi {
  async claimInvitation(
    invitationPayload: string,
    identity: MobileSigningIdentity,
    requestedScopes: readonly DeviceScope[],
    requestedAtUnixMs = Date.now(),
  ): Promise<ClaimedPairing> {
    const invitation = parsePairingInvitation(invitationPayload, requestedAtUnixMs);
    const request = await createSignedPairingRequest(
      invitation,
      identity,
      requestedScopes,
      requestedAtUnixMs,
    );
    const claim = await this.request<ClaimPairingResponse>(
      invitation.gateway_url,
      `/v1/pairings/${encodeURIComponent(invitation.pairing_id)}/claims`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    validateClaimResponse(claim, invitation, requestedAtUnixMs);
    return { invitation, request, claim };
  }

  async completePairing(claimed: ClaimedPairing, nowUnixMs = Date.now()): Promise<CompletePairingResponse> {
    const { invitation, claim } = claimed;
    if (nowUnixMs >= claim.completion_expires_at_unix_ms) {
      throw new RemoteProtocolError("Desktop approval took too long. Scan a new QR code and pair again.");
    }
    const response = await this.request<CompletePairingResponse>(
      invitation.gateway_url,
      `/v1/pairings/${encodeURIComponent(invitation.pairing_id)}/claims/${encodeURIComponent(claim.claim_id)}/complete`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${claim.activation_token}`,
        },
      },
    );
    if (response.status !== "completed" || response.credential_kind !== "activation_token") {
      throw new GatewayApiError("The gateway returned an invalid pairing completion response.", 502);
    }
    return response;
  }

  async currentDevice(gatewayUrl: string, credential: string): Promise<MeResponse> {
    const response = await this.request<MeResponse>(gatewayUrl, "/v1/me", {
      headers: { authorization: `Bearer ${credential}` },
    });
    validateMeResponse(response);
    return response;
  }

  /**
   * A mobile credential has no authority to choose a target device. The
   * gateway resolves the authenticated bearer to its own mobile record and
   * revokes only that record, keeping the desktop's ID-based revoke route
   * intentionally desktop-only.
   */
  async revokeThisDevice(gatewayUrl: string, credential: string): Promise<void> {
    await this.request<unknown>(gatewayUrl, "/v1/devices/self", {
      method: "DELETE",
      headers: { authorization: `Bearer ${credential}` },
    });
  }

  private async request<T>(gatewayUrl: string, path: string, init: RequestInit): Promise<T> {
    const endpoint = gatewayEndpoint(gatewayUrl, path);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        ...init,
        cache: "no-store",
        credentials: "omit",
      });
    } catch {
      throw new GatewayApiError("Cannot reach the SomniQ remote gateway.", 0);
    }
    if (!response.ok) {
      throw new GatewayApiError(await safeGatewayError(response), response.status);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new GatewayApiError("The SomniQ remote gateway returned malformed JSON.", 502);
    }
  }

}

function validateClaimResponse(
  claim: ClaimPairingResponse,
  invitation: PairingInvitation,
  nowUnixMs: number,
): void {
  if (
    typeof claim.claim_id !== "string" ||
    claim.claim_id.length === 0 ||
    typeof claim.activation_token !== "string" ||
    claim.activation_token.length < 32 ||
    !Number.isSafeInteger(claim.completion_expires_at_unix_ms) ||
    !Number.isSafeInteger(claim.expires_at_unix_ms) ||
    claim.expires_at_unix_ms !== invitation.expires_at_unix_ms ||
    claim.completion_expires_at_unix_ms <= nowUnixMs
  ) {
    throw new GatewayApiError("The gateway returned an invalid pairing claim response.", 502);
  }
  claim.ice_servers = validateIceServers(claim.ice_servers);
}

async function safeGatewayError(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (
      typeof value === "object" &&
      value !== null &&
      "message" in value &&
      typeof value.message === "string" &&
      value.message.length > 0 &&
      value.message.length <= 256
    ) {
      return value.message;
    }
  } catch {
    // The status code is sufficient and avoids surfacing a potentially large
    // proxy response to the UI or any diagnostic logs.
  }
  return `SomniQ remote gateway request failed (${response.status}).`;
}

function validateIceServers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new GatewayApiError("SomniQ 网关返回了无效网络配置。", 502);
  }
  const servers = value.map((item) => {
    if (typeof item !== "string") {
      throw new GatewayApiError("SomniQ 网关返回了无效网络配置。", 502);
    }
    return item.trim();
  });
  if (servers.some((server) => !isStunServerUrl(server))) {
    throw new GatewayApiError("SomniQ 网关返回了无效网络配置。", 502);
  }
  return servers;
}

function validateMeResponse(value: MeResponse): void {
  if (!isDeviceSummary(value.device) || !Array.isArray(value.paired_devices) || !value.paired_devices.every(isDeviceSummary)) {
    throw new GatewayApiError("The SomniQ remote gateway returned an invalid device record.", 502);
  }
}

function isDeviceSummary(value: unknown): value is MeResponse["device"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const device = value as Record<string, unknown>;
  return typeof device.id === "string" &&
    device.id.length > 0 &&
    typeof device.name === "string" &&
    (device.role === "desktop" || device.role === "mobile") &&
    Array.isArray(device.granted_scopes) &&
    device.granted_scopes.every(isDeviceScope) &&
    typeof device.active === "boolean";
}

function isDeviceScope(value: unknown): value is DeviceScope {
  return value === "read_project_state" ||
    value === "read_task_timeline" ||
    value === "send_chat_messages" ||
    value === "stop_runs" ||
    value === "read_review_conclusions";
}

function isStunServerUrl(value: string): boolean {
  return /^stuns?:[^/?#@\s]+$/i.test(value) && value.length <= 256;
}
