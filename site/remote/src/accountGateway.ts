import { accountHeadersForGateway } from "./account";
import type { AccountTokenManager } from "./accountToken";
import { GatewayApiError, safeGatewayError } from "./gateway";
import { gatewayEndpoint, parsePairingInvitation } from "./protocol";
import type { PairingInvitation } from "./types";

/**
 * The account plane of the gateway: which desktops belong to this sign-in, and
 * the connect request that asks one of them for a one-time invitation.
 *
 * It lives apart from `GatewayApi` because these are the only calls carrying a
 * *website account* credential rather than a paired-device bearer, so they are
 * also the only ones that must renew a rejected credential and replay. The
 * dashboard and the PWA both go through this one implementation: the dashboard
 * previously hand-rolled the same request with looser validation, which is how
 * the two surfaces drifted apart on what counts as a device.
 */

export interface AccountDeviceSummary {
  id: string;
  name: string;
  online: boolean;
}

export interface AccountConnectResponse {
  request_id: string;
  status: "pending_desktop" | "invitation_ready";
  expires_at_unix_ms: number;
  invitation?: PairingInvitation;
}

export class AccountGatewayApi {
  constructor(
    private readonly tokens: AccountTokenManager,
    /** Defaults to this document's origin; explicit only in tests. */
    private readonly siteOrigin?: string,
  ) {}

  async devices(gatewayUrl: string): Promise<AccountDeviceSummary[]> {
    const response = await this.request<unknown>(gatewayUrl, "/v1/account/devices", {});
    if (!Array.isArray(response) || !response.every(isAccountDeviceSummary)) {
      throw new GatewayApiError("The gateway returned an invalid account device list.", 502);
    }
    return response;
  }

  async createConnectRequest(
    gatewayUrl: string,
    desktopDeviceId: string,
    clientLabel: string,
  ): Promise<AccountConnectResponse> {
    const response = await this.request<unknown>(gatewayUrl, "/v1/account/connect-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desktop_device_id: desktopDeviceId, client_label: clientLabel }),
    });
    return validateAccountConnectResponse(response);
  }

  async connectRequest(gatewayUrl: string, requestId: string): Promise<AccountConnectResponse> {
    const response = await this.request<unknown>(
      gatewayUrl,
      `/v1/account/connect-requests/${encodeURIComponent(requestId)}`,
      {},
    );
    return validateAccountConnectResponse(response);
  }

  /**
   * Renewal lives here rather than at each call site: a desktop-approval poll
   * can easily outlive a 15-minute access token, and every caller would
   * otherwise have to remember to refresh before each pass.
   */
  private async request<T>(gatewayUrl: string, path: string, init: RequestInit): Promise<T> {
    const endpoint = gatewayEndpoint(gatewayUrl, path);
    const response = await this.tokens.fetchWithSession(async (session) => {
      const headers = accountHeadersForGateway(
        gatewayUrl,
        session,
        this.siteOrigin ?? window.location.origin,
      );
      if (!("X-Somniq-Account-User" in headers)) {
        // A QR-selected foreign gateway must never receive the website token.
        throw new GatewayApiError(
          "Account discovery is available only on the SomniQ website gateway.",
          403,
        );
      }
      return fetch(endpoint, {
        ...init,
        cache: "no-store",
        credentials: "omit",
        headers: { ...(init.headers as Record<string, string> | undefined), ...headers },
      });
    });
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

function isAccountDeviceSummary(value: unknown): value is AccountDeviceSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  return typeof device.id === "string" && device.id.length > 0 && device.id.length <= 128 &&
    typeof device.name === "string" && device.name.length > 0 && device.name.length <= 128 &&
    typeof device.online === "boolean";
}

function validateAccountConnectResponse(value: unknown): AccountConnectResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GatewayApiError("The gateway returned an invalid account connection response.", 502);
  }
  const response = value as Record<string, unknown>;
  if (
    typeof response.request_id !== "string" ||
    response.request_id.length === 0 ||
    (response.status !== "pending_desktop" && response.status !== "invitation_ready") ||
    !Number.isSafeInteger(response.expires_at_unix_ms)
  ) {
    throw new GatewayApiError("The gateway returned an invalid account connection response.", 502);
  }
  const invitation = response.invitation === undefined
    ? undefined
    : parsePairingInvitation(JSON.stringify(response.invitation));
  if (response.status === "invitation_ready" && !invitation) {
    throw new GatewayApiError("The desktop connection invitation is missing.", 502);
  }
  return {
    request_id: response.request_id,
    status: response.status,
    expires_at_unix_ms: response.expires_at_unix_ms as number,
    invitation,
  };
}
