import {
  CURRENT_PROTOCOL_VERSION,
  type DeviceDescriptor,
  type DeviceScope,
  type MobileSigningIdentity,
  type PairingInvitation,
  type PairingRequest,
} from "./types";

const PAIRING_REQUEST_LABEL = "somniq-remote/pairing-request/v1\0";
const MAX_QR_PAYLOAD_BYTES = 16 * 1024;
const MAX_DEVICE_NAME_BYTES = 128;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

const SCOPE_CODES: Readonly<Record<DeviceScope, number>> = {
  read_project_state: 1,
  read_task_timeline: 2,
  send_chat_messages: 3,
  stop_runs: 4,
  read_review_conclusions: 5,
};

export class RemoteProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteProtocolError";
  }
}

/**
 * Parses the exact JSON currently encoded by the desktop QR generator. It
 * intentionally does not retain or log the raw QR payload because it carries
 * a single-use pairing secret.
 */
export function parsePairingInvitation(payload: string, nowUnixMs = Date.now()): PairingInvitation {
  if (new TextEncoder().encode(payload).byteLength > MAX_QR_PAYLOAD_BYTES) {
    throw new RemoteProtocolError("The pairing QR payload is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new RemoteProtocolError("The scanned QR code is not a SomniQ pairing invitation.");
  }
  if (!isRecord(parsed)) {
    throw new RemoteProtocolError("The scanned QR code has an invalid pairing invitation shape.");
  }

  const invitation: PairingInvitation = {
    protocol_version: expectProtocolVersion(parsed.protocol_version),
    pairing_id: expectUuid(parsed.pairing_id, "pairing ID"),
    desktop: parseDeviceDescriptor(parsed.desktop, "desktop"),
    gateway_url: expectGatewayUrl(parsed.gateway_url),
    pairing_secret: expectBase64Url(parsed.pairing_secret, 32, "pairing secret"),
    expires_at_unix_ms: expectUnixMs(parsed.expires_at_unix_ms, "invitation expiry"),
  };

  if (invitation.desktop.kind !== "desktop") {
    throw new RemoteProtocolError("The pairing invitation does not identify a desktop.");
  }
  if (invitation.expires_at_unix_ms <= nowUnixMs) {
    throw new RemoteProtocolError("This pairing QR code has expired. Generate a new one on the desktop.");
  }
  return invitation;
}

/** Returns the byte-for-byte transcript required by Rust PairingRequest::signed. */
export async function pairingRequestTranscript(
  invitation: PairingInvitation,
  mobile: DeviceDescriptor,
  requestedScopes: readonly DeviceScope[],
  requestedAtUnixMs: number,
): Promise<Uint8Array> {
  validateInvitationForUse(invitation, requestedAtUnixMs);
  validateDeviceDescriptor(mobile, "mobile");
  if (mobile.kind !== "mobile") {
    throw new RemoteProtocolError("A pairing request must identify a mobile device.");
  }
  if (mobile.device_id.toLowerCase() === invitation.desktop.device_id.toLowerCase()) {
    throw new RemoteProtocolError("A device cannot pair with itself.");
  }

  const normalizedScopes = normalizeScopes(requestedScopes);
  const secret = base64UrlToBytes(invitation.pairing_secret);
  const digest = new Uint8Array(await requireWebCrypto().subtle.digest("SHA-256", toArrayBuffer(secret)));
  const version = uint16Bytes(invitation.protocol_version);
  const timestamp = int64Bytes(requestedAtUnixMs);
  const descriptorBytes = descriptorTranscriptBytes(mobile);
  const scopeBytes = new Uint8Array([
    normalizedScopes.length,
    ...normalizedScopes.map((scope) => SCOPE_CODES[scope]),
  ]);

  return concatBytes(
    utf8(PAIRING_REQUEST_LABEL),
    version,
    uuidToBytes(invitation.pairing_id),
    digest,
    descriptorBytes,
    scopeBytes,
    timestamp,
  );
}

/**
 * Creates the JSON body accepted by POST /v1/pairings/{pairing_id}/claims.
 * The private signing key stays inside the supplied identity implementation.
 */
export async function createSignedPairingRequest(
  invitation: PairingInvitation,
  identity: MobileSigningIdentity,
  requestedScopes: readonly DeviceScope[],
  requestedAtUnixMs = Date.now(),
): Promise<PairingRequest> {
  const normalizedScopes = normalizeScopes(requestedScopes);
  const transcript = await pairingRequestTranscript(
    invitation,
    identity.descriptor,
    normalizedScopes,
    requestedAtUnixMs,
  );
  const proof = await identity.signPairingTranscript(transcript);
  if (proof.byteLength !== 64) {
    throw new RemoteProtocolError("The mobile signing provider returned an invalid Ed25519 proof.");
  }
  return {
    protocol_version: CURRENT_PROTOCOL_VERSION,
    pairing_id: invitation.pairing_id,
    pairing_secret: invitation.pairing_secret,
    mobile: identity.descriptor,
    requested_scopes: normalizedScopes,
    requested_at_unix_ms: requestedAtUnixMs,
    proof: bytesToBase64Url(proof),
  };
}

/** Converts a verified invitation endpoint to an HTTPS endpoint base. */
export function gatewayHttpBase(gatewayUrl: string): string {
  const url = parseAndValidateGatewayUrl(gatewayUrl);
  if (url.protocol === "wss:") {
    url.protocol = "https:";
  } else if (url.protocol === "ws:") {
    url.protocol = "http:";
  }
  return url.toString().replace(/\/$/, "");
}

/** Converts a verified invitation endpoint to the matching WSS/WS endpoint base. */
export function gatewayWebSocketBase(gatewayUrl: string): string {
  const url = parseAndValidateGatewayUrl(gatewayUrl);
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString().replace(/\/$/, "");
}

export function gatewayEndpoint(gatewayUrl: string, path: string, websocket = false): string {
  const base = new URL(websocket ? gatewayWebSocketBase(gatewayUrl) : gatewayHttpBase(gatewayUrl));
  const suffix = path.replace(/^\/+/, "");
  const prefix = base.pathname.replace(/\/$/, "");
  base.pathname = `${prefix}/${suffix}`.replace(/\/\/+/g, "/");
  return base.toString();
}

export function normalizeScopes(scopes: readonly DeviceScope[]): DeviceScope[] {
  const unique = new Set<DeviceScope>();
  for (const scope of scopes) {
    if (!(scope in SCOPE_CODES)) {
      throw new RemoteProtocolError("The pairing request includes an unsupported permission.");
    }
    unique.add(scope);
  }
  return [...unique].sort((left, right) => SCOPE_CODES[left] - SCOPE_CODES[right]);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new RemoteProtocolError("A pairing field is not valid base64url.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new RemoteProtocolError("A pairing field is not valid base64url.");
  }
}

export function uuidToBytes(value: string): Uint8Array {
  const uuid = expectUuid(value, "UUID");
  const hexadecimal = uuid.replaceAll("-", "");
  const output = new Uint8Array(16);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Number.parseInt(hexadecimal.slice(index * 2, index * 2 + 2), 16);
  }
  return output;
}

function validateInvitationForUse(invitation: PairingInvitation, nowUnixMs: number): void {
  if (invitation.protocol_version !== CURRENT_PROTOCOL_VERSION) {
    throw new RemoteProtocolError("This mobile client does not support the invitation protocol version.");
  }
  expectUuid(invitation.pairing_id, "pairing ID");
  validateDeviceDescriptor(invitation.desktop, "desktop");
  if (invitation.desktop.kind !== "desktop") {
    throw new RemoteProtocolError("The pairing invitation does not identify a desktop.");
  }
  expectGatewayUrl(invitation.gateway_url);
  expectBase64Url(invitation.pairing_secret, 32, "pairing secret");
  if (expectUnixMs(invitation.expires_at_unix_ms, "invitation expiry") <= nowUnixMs) {
    throw new RemoteProtocolError("This pairing QR code has expired. Generate a new one on the desktop.");
  }
}

function parseDeviceDescriptor(value: unknown, label: string): DeviceDescriptor {
  if (!isRecord(value)) {
    throw new RemoteProtocolError(`The ${label} device descriptor is invalid.`);
  }
  const kind = value.kind;
  if (kind !== "desktop" && kind !== "mobile") {
    throw new RemoteProtocolError(`The ${label} device kind is invalid.`);
  }
  const descriptor: DeviceDescriptor = {
    device_id: expectUuid(value.device_id, `${label} device ID`),
    kind,
    display_name: expectDisplayName(value.display_name, label),
    signing_public_key: expectBase64Url(value.signing_public_key, 32, `${label} signing key`),
    key_agreement_public_key: expectBase64Url(value.key_agreement_public_key, 32, `${label} agreement key`),
  };
  return descriptor;
}

function validateDeviceDescriptor(value: DeviceDescriptor, label: string): void {
  parseDeviceDescriptor(value, label);
}

function expectProtocolVersion(value: unknown): number {
  if (value !== CURRENT_PROTOCOL_VERSION) {
    throw new RemoteProtocolError("This mobile client does not support the invitation protocol version.");
  }
  return value;
}

function expectUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RemoteProtocolError(`The ${label} is invalid.`);
  }
  return value.toLowerCase();
}

function expectDisplayName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RemoteProtocolError(`The ${label} display name is invalid.`);
  }
  if (utf8(value).byteLength > MAX_DEVICE_NAME_BYTES) {
    throw new RemoteProtocolError(`The ${label} display name is too long.`);
  }
  return value;
}

function expectBase64Url(value: unknown, expectedBytes: number, label: string): string {
  if (typeof value !== "string") {
    throw new RemoteProtocolError(`The ${label} is invalid.`);
  }
  const decoded = base64UrlToBytes(value);
  if (decoded.byteLength !== expectedBytes) {
    throw new RemoteProtocolError(`The ${label} is invalid.`);
  }
  return value;
}

function expectGatewayUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new RemoteProtocolError("The pairing gateway URL is invalid.");
  }
  parseAndValidateGatewayUrl(value);
  return value;
}

function parseAndValidateGatewayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteProtocolError("The pairing gateway URL is invalid.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RemoteProtocolError("The pairing gateway URL is invalid.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)]$/, "$1");
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const usesTls = url.protocol === "https:" || url.protocol === "wss:";
  const isLoopbackDevelopment = isLoopback && (url.protocol === "http:" || url.protocol === "ws:");
  if (!usesTls && !isLoopbackDevelopment) {
    throw new RemoteProtocolError("The pairing gateway must use HTTPS/WSS outside local development.");
  }
  return url;
}

function expectUnixMs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RemoteProtocolError(`The ${label} is invalid.`);
  }
  return value;
}

function descriptorTranscriptBytes(descriptor: DeviceDescriptor): Uint8Array {
  const kindCode = descriptor.kind === "desktop" ? 1 : 2;
  const displayName = utf8(descriptor.display_name);
  if (displayName.byteLength > 0xffff) {
    throw new RemoteProtocolError("The device name is too long for a pairing transcript.");
  }
  return concatBytes(
    uuidToBytes(descriptor.device_id),
    new Uint8Array([kindCode]),
    uint16Bytes(displayName.byteLength),
    displayName,
    base64UrlToBytes(descriptor.signing_public_key),
    base64UrlToBytes(descriptor.key_agreement_public_key),
  );
}

function uint16Bytes(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RemoteProtocolError("A pairing transcript field is out of range.");
  }
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value, false);
  return output;
}

function int64Bytes(value: number): Uint8Array {
  if (!Number.isSafeInteger(value)) {
    throw new RemoteProtocolError("The pairing timestamp is invalid.");
  }
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigInt64(0, BigInt(value), false);
  return output;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function requireWebCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new RemoteProtocolError("This browser does not provide the Web Crypto API required for secure pairing.");
  }
  return globalThis.crypto;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
