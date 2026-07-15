import {
  base64UrlToBytes,
  bytesToBase64Url,
  RemoteProtocolError,
  uuidToBytes,
} from "./protocol";
import type { DeviceDescriptor, MobileSigningIdentity } from "./types";

const SESSION_KEY_LABEL = "somniq-remote/session-key/v1";
const IDENTITY_RECORD_KEY = "current";
const IDENTITY_STORE_NAME = "identities";
const IDENTITY_DATABASE_NAME = "somniq-remote-mobile-v1";
const IDENTITY_DATABASE_VERSION = 1;

interface StoredWebCryptoIdentity {
  version: 1;
  deviceId: string;
  displayName: string;
  signing: CryptoKeyPair;
  agreement: CryptoKeyPair;
}

/**
 * Small persistence boundary for long-lived device keys. Implement native
 * keystore storage in a Capacitor/React Native wrapper; never serialize raw
 * private bytes into localStorage, JSON, query strings, or logs.
 */
export interface MobileIdentityStore {
  load(): Promise<StoredWebCryptoIdentity | null>;
  save(record: StoredWebCryptoIdentity): Promise<void>;
  clear(): Promise<void>;
}

/** Safe default for tests and ephemeral browser sessions. */
export class InMemoryIdentityStore implements MobileIdentityStore {
  private record: StoredWebCryptoIdentity | null = null;

  async load(): Promise<StoredWebCryptoIdentity | null> {
    return this.record;
  }

  async save(record: StoredWebCryptoIdentity): Promise<void> {
    this.record = record;
  }

  async clear(): Promise<void> {
    this.record = null;
  }
}

/**
 * Browser-only store for non-extractable Web Crypto keys. IndexedDB clones
 * `CryptoKey` values without exporting their private material. It is not a
 * replacement for Android Keystore / iOS Keychain in a production wrapper.
 */
export class IndexedDbIdentityStore implements MobileIdentityStore {
  async load(): Promise<StoredWebCryptoIdentity | null> {
    const database = await openIdentityDatabase();
    try {
      const transaction = database.transaction(IDENTITY_STORE_NAME, "readonly");
      const completion = transactionComplete(transaction);
      const [record] = await Promise.all([
        requestResult<StoredWebCryptoIdentity | undefined>(
          transaction.objectStore(IDENTITY_STORE_NAME).get(IDENTITY_RECORD_KEY),
        ),
        completion,
      ]);
      return record ?? null;
    } finally {
      database.close();
    }
  }

  async save(record: StoredWebCryptoIdentity): Promise<void> {
    const database = await openIdentityDatabase();
    try {
      const transaction = database.transaction(IDENTITY_STORE_NAME, "readwrite");
      const completion = transactionComplete(transaction);
      transaction.objectStore(IDENTITY_STORE_NAME).put(record, IDENTITY_RECORD_KEY);
      await completion;
    } finally {
      database.close();
    }
  }

  async clear(): Promise<void> {
    const database = await openIdentityDatabase();
    try {
      const transaction = database.transaction(IDENTITY_STORE_NAME, "readwrite");
      const completion = transactionComplete(transaction);
      transaction.objectStore(IDENTITY_STORE_NAME).delete(IDENTITY_RECORD_KEY);
      await completion;
    } finally {
      database.close();
    }
  }
}

/**
 * A non-extractable browser identity with separate Ed25519 signing and X25519
 * agreement keys. Its public descriptor is signed during QR pairing.
 */
export class WebCryptoMobileIdentity implements MobileSigningIdentity {
  readonly descriptor: DeviceDescriptor;

  private constructor(
    private readonly record: StoredWebCryptoIdentity,
    descriptor: DeviceDescriptor,
  ) {
    this.descriptor = descriptor;
  }

  static async loadOrCreate(store: MobileIdentityStore, displayName: string): Promise<WebCryptoMobileIdentity> {
    assertSecureWebCrypto();
    const stored = await store.load();
    if (stored) {
      validateStoredRecord(stored);
      return WebCryptoMobileIdentity.fromRecord(stored);
    }
    const record = await createRecord(displayName);
    await store.save(record);
    return WebCryptoMobileIdentity.fromRecord(record);
  }

  async signPairingTranscript(transcript: Uint8Array): Promise<Uint8Array> {
    const signature = await requireCrypto().subtle.sign(
      { name: "Ed25519" },
      this.record.signing.privateKey,
      toArrayBuffer(transcript),
    );
    return new Uint8Array(signature);
  }

  /**
   * Derives the 32-byte session key material used by the shared protocol.
   * A separate audited XChaCha20-Poly1305 codec must consume it transiently;
   * this foundation deliberately does not send plaintext control messages.
   */
  async deriveSessionKeyMaterial(
    peerAgreementPublicKey: string,
    sessionId: string,
    peerDeviceId: string,
  ): Promise<Uint8Array> {
    const crypto = requireCrypto();
    const peerBytes = base64UrlToBytes(peerAgreementPublicKey);
    if (peerBytes.byteLength !== 32) {
      throw new RemoteProtocolError("The paired desktop agreement key is invalid.");
    }
    uuidToBytes(sessionId);
    uuidToBytes(peerDeviceId);
    const peer = await crypto.subtle.importKey("raw", toArrayBuffer(peerBytes), { name: "X25519" }, false, []);
    const sharedSecret = await crypto.subtle.deriveBits(
      { name: "X25519", public: peer },
      this.record.agreement.privateKey,
      256,
    );
    const sortedIds = [this.descriptor.device_id, peerDeviceId.toLowerCase()].sort();
    if (sortedIds[0] === sortedIds[1]) {
      throw new RemoteProtocolError("A session key requires two distinct devices.");
    }
    const info = concatBytes(
      utf8(SESSION_KEY_LABEL),
      new Uint8Array([0]),
      utf8("1"),
      new Uint8Array([0]),
      utf8(sessionId.toLowerCase()),
      new Uint8Array([0]),
      utf8(sortedIds[0]),
      new Uint8Array([0]),
      utf8(sortedIds[1]),
    );
    const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
    const output = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new ArrayBuffer(0), info: toArrayBuffer(info) },
      hkdfKey,
      256,
    );
    return new Uint8Array(output);
  }

  private static async fromRecord(record: StoredWebCryptoIdentity): Promise<WebCryptoMobileIdentity> {
    const crypto = requireCrypto();
    const [signingPublic, agreementPublic] = await Promise.all([
      crypto.subtle.exportKey("raw", record.signing.publicKey),
      crypto.subtle.exportKey("raw", record.agreement.publicKey),
    ]);
    return new WebCryptoMobileIdentity(record, {
      device_id: record.deviceId,
      kind: "mobile",
      display_name: record.displayName,
      signing_public_key: bytesToBase64Url(new Uint8Array(signingPublic)),
      key_agreement_public_key: bytesToBase64Url(new Uint8Array(agreementPublic)),
    });
  }
}

function assertSecureWebCrypto(): void {
  const crypto = requireCrypto();
  if (!globalThis.isSecureContext) {
    throw new RemoteProtocolError("SomniQ Remote requires a secure HTTPS context for key generation.");
  }
  if (!crypto.subtle) {
    throw new RemoteProtocolError("This browser does not support Web Crypto.");
  }
}

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) {
    throw new RemoteProtocolError("This browser does not support Web Crypto.");
  }
  return globalThis.crypto;
}

async function createRecord(displayName: string): Promise<StoredWebCryptoIdentity> {
  const normalizedName = displayName.trim();
  if (normalizedName.length === 0 || new TextEncoder().encode(normalizedName).byteLength > 128) {
    throw new RemoteProtocolError("Choose a device name between 1 and 128 bytes.");
  }
  if (/[\u0000-\u001f\u007f]/.test(normalizedName)) {
    throw new RemoteProtocolError("The device name contains a control character.");
  }
  try {
    const crypto = requireCrypto();
    const [signing, agreement] = await Promise.all([
      crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]),
      crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]),
    ]);
    if (!("privateKey" in signing) || !("privateKey" in agreement)) {
      throw new RemoteProtocolError("This browser returned an invalid asymmetric key pair.");
    }
    return {
      version: 1,
      deviceId: randomUuid(),
      displayName: normalizedName,
      signing,
      agreement,
    };
  } catch (error) {
    if (error instanceof RemoteProtocolError) {
      throw error;
    }
    throw new RemoteProtocolError(
      "This browser must support Web Crypto Ed25519 and X25519 to pair with SomniQ Remote.",
    );
  }
}

function validateStoredRecord(record: StoredWebCryptoIdentity): void {
  if (record.version !== 1 || typeof record.deviceId !== "string" || typeof record.displayName !== "string") {
    throw new RemoteProtocolError("The stored mobile identity is invalid. Clear it and pair again.");
  }
  uuidToBytes(record.deviceId);
  if (!record.signing?.privateKey || !record.signing.publicKey || !record.agreement?.privateKey || !record.agreement.publicKey) {
    throw new RemoteProtocolError("The stored mobile identity is incomplete. Clear it and pair again.");
  }
}

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  requireCrypto().getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function openIdentityDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    return Promise.reject(new RemoteProtocolError("This browser does not provide IndexedDB for protected key handles."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDENTITY_DATABASE_NAME, IDENTITY_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDENTITY_STORE_NAME)) {
        request.result.createObjectStore(IDENTITY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new RemoteProtocolError("Unable to open the protected mobile identity store."));
    request.onblocked = () => reject(new RemoteProtocolError("The protected mobile identity store is locked by another tab."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new RemoteProtocolError("The protected mobile identity store request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new RemoteProtocolError("The protected mobile identity store transaction failed."));
    transaction.onabort = () => reject(new RemoteProtocolError("The protected mobile identity store transaction was aborted."));
  });
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
