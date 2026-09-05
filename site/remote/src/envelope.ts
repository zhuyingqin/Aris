import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  RemoteProtocolError,
  uuidToBytes,
} from "./protocol";
import type { EncryptedFrameCodec } from "./types";

const ENVELOPE_AAD_LABEL = "somniq-remote/envelope/v1\0";
const PROTOCOL_VERSION = 1;
const KEY_LENGTH = 32;
const NONCE_LENGTH = 24;
const AEAD_TAG_LENGTH = 16;
const DEFAULT_SEQUENCE_WINDOW_SIZE = 1_024;
const DEFAULT_MAX_MESSAGE_AGE_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_FUTURE_SKEW_MS = 30_000;

export interface SessionRoute {
  session_id: string;
  sender_device_id: string;
  recipient_device_id: string;
}

export interface SecureEnvelope {
  protocol_version: number;
  route: SessionRoute;
  sequence: number;
  sent_at_unix_ms: number;
  nonce: string;
  ciphertext: string;
}

export interface SecureEnvelopeCodecInput {
  sessionKey: Uint8Array;
  sessionId: string;
  localDeviceId: string;
  peerDeviceId: string;
  sequenceWindowSize?: number;
  maxMessageAgeMs?: number;
  maxFutureSkewMs?: number;
  now?: () => number;
}

/**
 * Browser implementation of the Rust `SecureEnvelope` + `ReplayWindow`.
 * It serializes exactly the JSON envelope the desktop already accepts and
 * uses XChaCha20-Poly1305 with the same binary AAD construction.
 */
export class SecureEnvelopeCodec implements EncryptedFrameCodec {
  private readonly sessionKey: Uint8Array;
  private readonly outgoingRoute: SessionRoute;
  private readonly incomingRoute: SessionRoute;
  private readonly replay: ReplayWindow;
  private readonly now: () => number;
  private nextSequence = 1;

  constructor(input: SecureEnvelopeCodecInput) {
    if (input.sessionKey.byteLength !== KEY_LENGTH) {
      throw new RemoteProtocolError("A remote session key must be exactly 32 bytes.");
    }
    validateUuid(input.sessionId, "session ID");
    validateUuid(input.localDeviceId, "local device ID");
    validateUuid(input.peerDeviceId, "peer device ID");
    if (input.localDeviceId.toLowerCase() === input.peerDeviceId.toLowerCase()) {
      throw new RemoteProtocolError("A secure envelope route requires two distinct devices.");
    }
    this.sessionKey = input.sessionKey.slice();
    this.outgoingRoute = {
      session_id: input.sessionId.toLowerCase(),
      sender_device_id: input.localDeviceId.toLowerCase(),
      recipient_device_id: input.peerDeviceId.toLowerCase(),
    };
    this.incomingRoute = {
      session_id: this.outgoingRoute.session_id,
      sender_device_id: this.outgoingRoute.recipient_device_id,
      recipient_device_id: this.outgoingRoute.sender_device_id,
    };
    this.replay = new ReplayWindow({
      route: this.incomingRoute,
      sequenceWindowSize: input.sequenceWindowSize ?? DEFAULT_SEQUENCE_WINDOW_SIZE,
      maxMessageAgeMs: input.maxMessageAgeMs ?? DEFAULT_MAX_MESSAGE_AGE_MS,
      maxFutureSkewMs: input.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS,
    });
    this.now = input.now ?? Date.now;
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.nextSequence > Number.MAX_SAFE_INTEGER) {
      throw new RemoteProtocolError("The remote session sequence is exhausted; reconnect before sending more data.");
    }
    const sentAtUnixMs = validUnixMs(this.now(), "outgoing envelope timestamp");
    const nonce = randomNonce();
    const sequence = this.nextSequence;
    const header: Omit<SecureEnvelope, "ciphertext"> = {
      protocol_version: PROTOCOL_VERSION,
      route: this.outgoingRoute,
      sequence,
      sent_at_unix_ms: sentAtUnixMs,
      nonce: bytesToBase64Url(nonce),
    };
    const ciphertext = xchacha20poly1305(this.sessionKey, nonce, authenticatedData(header)).encrypt(plaintext);
    const envelope: SecureEnvelope = {
      ...header,
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    };
    this.nextSequence += 1;
    return new TextEncoder().encode(JSON.stringify(envelope));
  }

  async open(frame: Uint8Array): Promise<Uint8Array> {
    const envelope = parseSecureEnvelope(frame);
    this.replay.preflight(envelope, validUnixMs(this.now(), "incoming envelope timestamp"));
    try {
      const nonce = base64UrlToBytes(envelope.nonce);
      const ciphertext = base64UrlToBytes(envelope.ciphertext);
      const plaintext = xchacha20poly1305(
        this.sessionKey,
        nonce,
        authenticatedData(envelope),
      ).decrypt(ciphertext);
      this.replay.record(envelope);
      return new Uint8Array(plaintext);
    } catch (error) {
      // Do not consume a sequence/nonce after malformed ciphertext and do not
      // pass implementation details or encrypted bytes to any UI/logging path.
      if (error instanceof RemoteProtocolError) {
        throw error;
      }
      throw new RemoteProtocolError("The encrypted remote frame could not be authenticated.");
    }
  }
}

/** Creates the fixed binary AAD required by Rust `SecureEnvelope`. */
export function authenticatedData(envelope: Pick<SecureEnvelope, "protocol_version" | "route" | "sequence" | "sent_at_unix_ms">): Uint8Array {
  validateEnvelopeHeader(envelope, false);
  return concatBytes(
    utf8(ENVELOPE_AAD_LABEL),
    uint16Bytes(envelope.protocol_version),
    uuidToBytes(envelope.route.session_id),
    uuidToBytes(envelope.route.sender_device_id),
    uuidToBytes(envelope.route.recipient_device_id),
    uint64Bytes(envelope.sequence),
    int64Bytes(envelope.sent_at_unix_ms),
  );
}

/** Strictly parses the JSON binary envelope accepted by the Rust endpoint. */
export function parseSecureEnvelope(frame: Uint8Array): SecureEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
  } catch {
    throw new RemoteProtocolError("The remote frame is not a valid encrypted envelope.");
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["protocol_version", "route", "sequence", "sent_at_unix_ms", "nonce", "ciphertext"])) {
    throw new RemoteProtocolError("The remote frame is not a valid encrypted envelope.");
  }
  if (!isRecord(parsed.route) || !hasOnlyKeys(parsed.route, ["session_id", "sender_device_id", "recipient_device_id"])) {
    throw new RemoteProtocolError("The encrypted envelope route is invalid.");
  }
  const envelope: SecureEnvelope = {
    protocol_version: parsed.protocol_version as number,
    route: {
      session_id: parsed.route.session_id as string,
      sender_device_id: parsed.route.sender_device_id as string,
      recipient_device_id: parsed.route.recipient_device_id as string,
    },
    sequence: parsed.sequence as number,
    sent_at_unix_ms: parsed.sent_at_unix_ms as number,
    nonce: parsed.nonce as string,
    ciphertext: parsed.ciphertext as string,
  };
  validateEnvelopeHeader(envelope, true);
  return envelope;
}

class ReplayWindow {
  private highestSequence: number | null = null;
  private readonly acceptedSequences = new Map<number, string>();
  private readonly acceptedNonces = new Set<string>();

  constructor(private readonly policy: ReplayWindowPolicy) {
    if (!Number.isSafeInteger(policy.sequenceWindowSize) || policy.sequenceWindowSize < 1) {
      throw new RemoteProtocolError("The replay sequence window must contain at least one message.");
    }
    if (!Number.isSafeInteger(policy.maxMessageAgeMs) || policy.maxMessageAgeMs < 0) {
      throw new RemoteProtocolError("The replay maximum message age is invalid.");
    }
    if (!Number.isSafeInteger(policy.maxFutureSkewMs) || policy.maxFutureSkewMs < 0) {
      throw new RemoteProtocolError("The replay future clock skew is invalid.");
    }
  }

  preflight(envelope: SecureEnvelope, nowUnixMs: number): void {
    validateEnvelopeHeader(envelope, true);
    if (!routesEqual(envelope.route, this.policy.route)) {
      throw new RemoteProtocolError("The encrypted envelope belongs to a different route.");
    }
    if (envelope.sent_at_unix_ms < nowUnixMs - this.policy.maxMessageAgeMs) {
      throw new RemoteProtocolError("The encrypted envelope has expired.");
    }
    if (envelope.sent_at_unix_ms > nowUnixMs + this.policy.maxFutureSkewMs) {
      throw new RemoteProtocolError("The encrypted envelope timestamp is too far in the future.");
    }
    const nonce = canonicalBase64Url(envelope.nonce, NONCE_LENGTH, "envelope nonce");
    if (this.acceptedNonces.has(nonce)) {
      throw new RemoteProtocolError("The encrypted envelope nonce was already accepted.");
    }
    if (this.acceptedSequences.has(envelope.sequence)) {
      throw new RemoteProtocolError("The encrypted envelope sequence was already accepted.");
    }
    if (this.highestSequence !== null) {
      const minimum = Math.max(1, this.highestSequence - (this.policy.sequenceWindowSize - 1));
      if (envelope.sequence < minimum) {
        throw new RemoteProtocolError("The encrypted envelope sequence is outside the replay window.");
      }
    }
  }

  record(envelope: SecureEnvelope): void {
    const nonce = canonicalBase64Url(envelope.nonce, NONCE_LENGTH, "envelope nonce");
    this.highestSequence = Math.max(this.highestSequence ?? envelope.sequence, envelope.sequence);
    this.acceptedSequences.set(envelope.sequence, nonce);
    this.acceptedNonces.add(nonce);
    const minimum = Math.max(1, this.highestSequence - (this.policy.sequenceWindowSize - 1));
    for (const [sequence, acceptedNonce] of this.acceptedSequences) {
      if (sequence < minimum) {
        this.acceptedSequences.delete(sequence);
        this.acceptedNonces.delete(acceptedNonce);
      }
    }
  }
}

interface ReplayWindowPolicy {
  route: SessionRoute;
  sequenceWindowSize: number;
  maxMessageAgeMs: number;
  maxFutureSkewMs: number;
}

function validateEnvelopeHeader(
  envelope: Pick<SecureEnvelope, "protocol_version" | "route" | "sequence" | "sent_at_unix_ms"> & Partial<Pick<SecureEnvelope, "nonce" | "ciphertext">>,
  validatePayload: boolean,
): void {
  if (envelope.protocol_version !== PROTOCOL_VERSION) {
    throw new RemoteProtocolError("The encrypted envelope uses an unsupported protocol version.");
  }
  validateUuid(envelope.route.session_id, "envelope session ID");
  validateUuid(envelope.route.sender_device_id, "envelope sender ID");
  validateUuid(envelope.route.recipient_device_id, "envelope recipient ID");
  if (envelope.route.sender_device_id.toLowerCase() === envelope.route.recipient_device_id.toLowerCase()) {
    throw new RemoteProtocolError("The encrypted envelope route is invalid.");
  }
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) {
    throw new RemoteProtocolError("The encrypted envelope sequence is invalid.");
  }
  validUnixMs(envelope.sent_at_unix_ms, "envelope timestamp");
  if (validatePayload) {
    if (typeof envelope.nonce !== "string" || typeof envelope.ciphertext !== "string") {
      throw new RemoteProtocolError("The encrypted envelope payload is invalid.");
    }
    canonicalBase64Url(envelope.nonce, NONCE_LENGTH, "envelope nonce");
    const ciphertext = base64UrlToBytes(envelope.ciphertext);
    if (ciphertext.byteLength < AEAD_TAG_LENGTH) {
      throw new RemoteProtocolError("The encrypted envelope ciphertext is truncated.");
    }
  }
}

function randomNonce(): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new RemoteProtocolError("This mobile platform cannot generate secure envelope nonces.");
  }
  const nonce = new Uint8Array(NONCE_LENGTH);
  globalThis.crypto.getRandomValues(nonce);
  return nonce;
}

function canonicalBase64Url(value: string, expectedLength: number, label: string): string {
  const bytes = base64UrlToBytes(value);
  if (bytes.byteLength !== expectedLength) {
    throw new RemoteProtocolError(`The ${label} is invalid.`);
  }
  return bytesToBase64Url(bytes);
}

function validateUuid(value: string, label: string): void {
  try {
    uuidToBytes(value);
  } catch {
    throw new RemoteProtocolError(`The ${label} is invalid.`);
  }
}

function routesEqual(left: SessionRoute, right: SessionRoute): boolean {
  return (
    left.session_id.toLowerCase() === right.session_id.toLowerCase() &&
    left.sender_device_id.toLowerCase() === right.sender_device_id.toLowerCase() &&
    left.recipient_device_id.toLowerCase() === right.recipient_device_id.toLowerCase()
  );
}

function uint16Bytes(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RemoteProtocolError("The protocol version is invalid.");
  }
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value, false);
  return result;
}

function uint64Bytes(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RemoteProtocolError("The envelope sequence is invalid.");
  }
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, BigInt(value), false);
  return result;
}

function int64Bytes(value: number): Uint8Array {
  validUnixMs(value, "envelope timestamp");
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigInt64(0, BigInt(value), false);
  return result;
}

function validUnixMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RemoteProtocolError(`The ${label} is invalid.`);
  }
  return value;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
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

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
