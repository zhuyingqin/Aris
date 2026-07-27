import {
  base64UrlToBytes,
  bytesToBase64Url,
  RemoteProtocolError,
  uuidToBytes,
} from "./protocol";
import type { DeviceDescriptor, MobileSigningIdentity } from "./types";

const SESSION_KEY_LABEL = "somniq-remote/session-key/v1";
const IDENTITY_WRAP_LABEL = "somniq-remote/mobile-identity/v2";
const IDENTITY_RECORD_KEY = "current";
const IDENTITY_METADATA_RECORD_KEY = "current-metadata";
const IDENTITY_WRAPPING_KEY_RECORD_KEY = "current-wrapping-key";
const IDENTITY_STORE_NAME = "identities";
const IDENTITY_DATABASE_NAME = "somniq-remote-mobile-v2";
const IDENTITY_DATABASE_VERSION = 1;
const IDENTITY_WRAP_IV_BYTES = 12;
const IDENTITY_PUBLIC_KEY_BYTES = 32;
const MAX_WRAPPED_PRIVATE_KEY_BYTES = 512;

interface StoredWebCryptoIdentity {
  version: 1;
  deviceId: string;
  displayName: string;
  signing: CryptoKeyPair;
  agreement: CryptoKeyPair;
}

interface PersistedWrappedPrivateKey {
  publicKey: ArrayBuffer;
  iv: ArrayBuffer;
  wrappedPrivateKey: ArrayBuffer;
}

interface PersistedWebCryptoIdentity {
  version: 2;
  deviceId: string;
  displayName: string;
  signing: PersistedWrappedPrivateKey;
  agreement: PersistedWrappedPrivateKey;
}

interface WrappedIdentityForPersistence {
  record: PersistedWebCryptoIdentity;
  wrappingKey: CryptoKey;
}

interface PersistedIdentityMetadata {
  version: 2;
  deviceId: string;
}

/**
 * Small persistence boundary for long-lived device keys. Implement native
 * keystore storage in a Capacitor/React Native wrapper; never serialize raw
 * private bytes into localStorage, JSON, query strings, or logs.
 */
export interface MobileIdentityStore {
  load(): Promise<StoredWebCryptoIdentity | null>;
  save(record: StoredWebCryptoIdentity): Promise<boolean>;
  clear(): Promise<void>;
}

/** Safe default for tests and ephemeral browser sessions. */
export class InMemoryIdentityStore implements MobileIdentityStore {
  private record: StoredWebCryptoIdentity | null = null;

  async load(): Promise<StoredWebCryptoIdentity | null> {
    return this.record;
  }

  async save(record: StoredWebCryptoIdentity): Promise<boolean> {
    if (this.record) {
      return false;
    }
    this.record = record;
    return true;
  }

  async clear(): Promise<void> {
    this.record = null;
  }
}

/**
 * Browser-only store that persists one non-extractable AES-GCM wrapping key
 * and wrapped PKCS8 blobs. WebKit cannot reliably restore a non-extractable
 * X25519 CryptoKey directly from IndexedDB, while its AES keys are durable.
 * This protects private bytes at rest, but same-origin script still operates
 * inside the PWA credential boundary and can ask Web Crypto to unwrap them.
 * A native wrapper should still replace this with iOS Keychain or Android
 * Keystore storage.
 */
export class IndexedDbIdentityStore implements MobileIdentityStore {
  constructor(private readonly desktopDeviceId: string | null = null) {}

  async load(): Promise<StoredWebCryptoIdentity | null> {
    const keys = identityRecordKeys(this.desktopDeviceId);
    const database = await openIdentityDatabase();
    try {
      const transaction = database.transaction(IDENTITY_STORE_NAME, "readonly");
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(IDENTITY_STORE_NAME);
      const [record, metadata, wrappingKey, recordKey] = await Promise.all([
        requestResult<PersistedWebCryptoIdentity | null | undefined>(
          store.get(keys.record),
        ),
        requestResult<PersistedIdentityMetadata | undefined>(
          store.get(keys.metadata),
        ),
        requestResult<CryptoKey | null | undefined>(store.get(keys.wrappingKey)),
        requestResult<IDBValidKey | undefined>(
          store.getKey(keys.record),
        ),
        completion,
      ]);
      if (record === undefined && metadata === undefined && wrappingKey === undefined && recordKey === undefined) {
        return null;
      }
      if (
        !record ||
        !metadata ||
        !wrappingKey ||
        metadata.version !== 2 ||
        typeof metadata.deviceId !== "string" ||
        recordKey !== keys.record ||
        metadata.deviceId !== record.deviceId
      ) {
        throw new RemoteProtocolError(
          "The saved mobile identity cannot be restored. Reset this app's local pairing and pair once more.",
        );
      }
      return await unwrapPersistedIdentity(record, wrappingKey);
    } finally {
      database.close();
    }
  }

  async save(record: StoredWebCryptoIdentity): Promise<boolean> {
    const keys = identityRecordKeys(this.desktopDeviceId);
    const persisted = await wrapIdentityForPersistence(record);
    const database = await openIdentityDatabase();
    try {
      const transaction = durableIdentityWriteTransaction(database);
      const completion = identityCreationCommitted(transaction);
      const store = transaction.objectStore(IDENTITY_STORE_NAME);
      store.add(persisted.record, keys.record);
      store.add(persisted.wrappingKey, keys.wrappingKey);
      store.add(
        { version: 2, deviceId: record.deviceId } satisfies PersistedIdentityMetadata,
        keys.metadata,
      );
      return await completion;
    } finally {
      database.close();
    }
  }

  async clear(): Promise<void> {
    const keys = identityRecordKeys(this.desktopDeviceId);
    const database = await openIdentityDatabase();
    try {
      const transaction = database.transaction(IDENTITY_STORE_NAME, "readwrite");
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(IDENTITY_STORE_NAME);
      store.delete(keys.record);
      store.delete(keys.metadata);
      store.delete(keys.wrappingKey);
      await completion;
    } finally {
      database.close();
    }
  }

  async clearAll(): Promise<void> {
    const database = await openIdentityDatabase();
    try {
      const transaction = database.transaction(IDENTITY_STORE_NAME, "readwrite");
      const completion = transactionComplete(transaction);
      transaction.objectStore(IDENTITY_STORE_NAME).clear();
      await completion;
    } finally {
      database.close();
    }
  }
}

function identityRecordKeys(desktopDeviceId: string | null): {
  record: string;
  metadata: string;
  wrappingKey: string;
} {
  if (desktopDeviceId === null) {
    return {
      record: IDENTITY_RECORD_KEY,
      metadata: IDENTITY_METADATA_RECORD_KEY,
      wrappingKey: IDENTITY_WRAPPING_KEY_RECORD_KEY,
    };
  }
  const prefix = `desktop:${desktopDeviceId.toLowerCase()}`;
  return {
    record: `${prefix}:identity`,
    metadata: `${prefix}:metadata`,
    wrappingKey: `${prefix}:wrapping-key`,
  };
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
    const existing = await WebCryptoMobileIdentity.load(store);
    if (existing) {
      return existing;
    }
    const record = await createRecord(displayName);
    const created = await store.save(record);
    const committed = await WebCryptoMobileIdentity.load(store);
    if (!committed || (created && committed.descriptor.device_id !== record.deviceId)) {
      throw new RemoteProtocolError("The protected mobile identity was not committed. Pairing was not started.");
    }
    return committed;
  }

  static async load(store: MobileIdentityStore): Promise<WebCryptoMobileIdentity | null> {
    assertSecureWebCrypto();
    const stored = await store.load();
    if (!stored) {
      return null;
    }
    validateStoredRecord(stored);
    await selfTestIdentityRecord(stored);
    return WebCryptoMobileIdentity.fromRecord(stored);
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
      crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]),
      crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]),
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

async function wrapIdentityForPersistence(
  record: StoredWebCryptoIdentity,
): Promise<WrappedIdentityForPersistence> {
  validateStoredRecord(record);
  const crypto = requireCrypto();
  try {
    const wrappingKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["wrapKey", "unwrapKey"],
    );
    if ("privateKey" in wrappingKey) {
      throw new RemoteProtocolError("The browser returned an invalid identity wrapping key.");
    }
    const signingIv = randomBytes(IDENTITY_WRAP_IV_BYTES);
    const agreementIv = randomBytes(IDENTITY_WRAP_IV_BYTES);
    const [signingPublicKey, agreementPublicKey, wrappedSigningPrivateKey, wrappedAgreementPrivateKey] = await Promise.all([
      crypto.subtle.exportKey("raw", record.signing.publicKey),
      crypto.subtle.exportKey("raw", record.agreement.publicKey),
      crypto.subtle.wrapKey(
        "pkcs8",
        record.signing.privateKey,
        wrappingKey,
        identityWrapParams(record.deviceId, "signing", signingIv),
      ),
      crypto.subtle.wrapKey(
        "pkcs8",
        record.agreement.privateKey,
        wrappingKey,
        identityWrapParams(record.deviceId, "agreement", agreementIv),
      ),
    ]);
    return {
      wrappingKey,
      record: {
        version: 2,
        deviceId: record.deviceId,
        displayName: record.displayName,
        signing: {
          publicKey: signingPublicKey,
          iv: toArrayBuffer(signingIv),
          wrappedPrivateKey: wrappedSigningPrivateKey,
        },
        agreement: {
          publicKey: agreementPublicKey,
          iv: toArrayBuffer(agreementIv),
          wrappedPrivateKey: wrappedAgreementPrivateKey,
        },
      },
    };
  } catch (error) {
    if (error instanceof RemoteProtocolError) {
      throw error;
    }
    throw new RemoteProtocolError("This browser cannot seal the mobile identity for durable storage.");
  }
}

async function unwrapPersistedIdentity(
  persisted: PersistedWebCryptoIdentity,
  wrappingKey: CryptoKey,
): Promise<StoredWebCryptoIdentity> {
  validatePersistedIdentity(persisted, wrappingKey);
  const crypto = requireCrypto();
  try {
    const [signingPrivateKey, signingPublicKey, agreementPrivateKey, agreementPublicKey] = await Promise.all([
      crypto.subtle.unwrapKey(
        "pkcs8",
        persisted.signing.wrappedPrivateKey,
        wrappingKey,
        identityWrapParams(persisted.deviceId, "signing", new Uint8Array(persisted.signing.iv)),
        { name: "Ed25519" },
        false,
        ["sign"],
      ),
      crypto.subtle.importKey("raw", persisted.signing.publicKey, { name: "Ed25519" }, true, ["verify"]),
      crypto.subtle.unwrapKey(
        "pkcs8",
        persisted.agreement.wrappedPrivateKey,
        wrappingKey,
        identityWrapParams(persisted.deviceId, "agreement", new Uint8Array(persisted.agreement.iv)),
        { name: "X25519" },
        false,
        ["deriveBits"],
      ),
      crypto.subtle.importKey("raw", persisted.agreement.publicKey, { name: "X25519" }, true, []),
    ]);
    return {
      version: 1,
      deviceId: persisted.deviceId,
      displayName: persisted.displayName,
      signing: { privateKey: signingPrivateKey, publicKey: signingPublicKey },
      agreement: { privateKey: agreementPrivateKey, publicKey: agreementPublicKey },
    };
  } catch (error) {
    if (error instanceof RemoteProtocolError) {
      throw error;
    }
    throw new RemoteProtocolError(
      "The saved mobile identity cannot be unsealed. Reset this app's local pairing and pair once more.",
    );
  }
}

function validatePersistedIdentity(record: PersistedWebCryptoIdentity, wrappingKey: CryptoKey): void {
  if (record.version !== 2 || typeof record.deviceId !== "string" || typeof record.displayName !== "string") {
    throw new RemoteProtocolError("The saved mobile identity is invalid.");
  }
  uuidToBytes(record.deviceId);
  validateIdentityDisplayName(record.displayName);
  if (
    !wrappingKey ||
    wrappingKey.type !== "secret" ||
    wrappingKey.extractable ||
    wrappingKey.algorithm.name !== "AES-GCM" ||
    !wrappingKey.usages.includes("unwrapKey")
  ) {
    throw new RemoteProtocolError("The saved mobile identity wrapping key is invalid.");
  }
  validatePersistedWrappedKey(record.signing, "signing");
  validatePersistedWrappedKey(record.agreement, "agreement");
}

function validatePersistedWrappedKey(record: PersistedWrappedPrivateKey, label: string): void {
  if (
    !record ||
    !(record.publicKey instanceof ArrayBuffer) ||
    record.publicKey.byteLength !== IDENTITY_PUBLIC_KEY_BYTES ||
    !(record.iv instanceof ArrayBuffer) ||
    record.iv.byteLength !== IDENTITY_WRAP_IV_BYTES ||
    !(record.wrappedPrivateKey instanceof ArrayBuffer) ||
    record.wrappedPrivateKey.byteLength <= 16 ||
    record.wrappedPrivateKey.byteLength > MAX_WRAPPED_PRIVATE_KEY_BYTES
  ) {
    throw new RemoteProtocolError(`The saved mobile ${label} key is invalid.`);
  }
}

async function selfTestIdentityRecord(record: StoredWebCryptoIdentity): Promise<void> {
  const crypto = requireCrypto();
  const challenge = utf8("somniq-remote/mobile-identity-self-test/v1");
  try {
    const [signature, peerAgreement] = await Promise.all([
      crypto.subtle.sign({ name: "Ed25519" }, record.signing.privateKey, toArrayBuffer(challenge)),
      crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]),
    ]);
    if (!("privateKey" in peerAgreement)) {
      throw new RemoteProtocolError("The browser returned an invalid identity self-test key.");
    }
    const [verified, sharedSecret, reverseSharedSecret] = await Promise.all([
      crypto.subtle.verify(
        { name: "Ed25519" },
        record.signing.publicKey,
        signature,
        toArrayBuffer(challenge),
      ),
      crypto.subtle.deriveBits(
        { name: "X25519", public: peerAgreement.publicKey },
        record.agreement.privateKey,
        256,
      ),
      crypto.subtle.deriveBits(
        { name: "X25519", public: record.agreement.publicKey },
        peerAgreement.privateKey,
        256,
      ),
    ]);
    if (
      !verified ||
      sharedSecret.byteLength !== 32 ||
      !equalBytes(new Uint8Array(sharedSecret), new Uint8Array(reverseSharedSecret))
    ) {
      throw new RemoteProtocolError("The saved mobile identity failed its cryptographic self-test.");
    }
  } catch (error) {
    if (error instanceof RemoteProtocolError) {
      throw error;
    }
    throw new RemoteProtocolError("The saved mobile identity failed its cryptographic self-test.");
  }
}

function identityWrapParams(
  deviceId: string,
  purpose: "signing" | "agreement",
  iv: Uint8Array,
): AesGcmParams {
  return {
    name: "AES-GCM",
    iv: toArrayBuffer(iv),
    additionalData: toArrayBuffer(utf8(`${IDENTITY_WRAP_LABEL}\0${deviceId}\0${purpose}`)),
  };
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  requireCrypto().getRandomValues(bytes);
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function validateIdentityDisplayName(value: string): void {
  if (value.trim().length === 0 || utf8(value).byteLength > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RemoteProtocolError("The saved mobile identity display name is invalid.");
  }
}

function validateStoredRecord(record: StoredWebCryptoIdentity): void {
  if (record.version !== 1 || typeof record.deviceId !== "string" || typeof record.displayName !== "string") {
    throw new RemoteProtocolError("The stored mobile identity is invalid. Clear it and pair again.");
  }
  uuidToBytes(record.deviceId);
  validateIdentityDisplayName(record.displayName);
  if (!record.signing?.privateKey || !record.signing.publicKey || !record.agreement?.privateKey || !record.agreement.publicKey) {
    throw new RemoteProtocolError("The stored mobile identity is incomplete. Clear it and pair again.");
  }
  if (
    record.signing.privateKey.algorithm.name !== "Ed25519" ||
    !record.signing.privateKey.usages.includes("sign") ||
    record.signing.publicKey.algorithm.name !== "Ed25519" ||
    !record.signing.publicKey.usages.includes("verify") ||
    record.agreement.privateKey.algorithm.name !== "X25519" ||
    !record.agreement.privateKey.usages.includes("deriveBits") ||
    record.agreement.publicKey.algorithm.name !== "X25519"
  ) {
    throw new RemoteProtocolError("The stored mobile identity has invalid key algorithms.");
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

function durableIdentityWriteTransaction(database: IDBDatabase): IDBTransaction {
  try {
    return database.transaction(IDENTITY_STORE_NAME, "readwrite", { durability: "strict" });
  } catch {
    return database.transaction(IDENTITY_STORE_NAME, "readwrite");
  }
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

function identityCreationCommitted(transaction: IDBTransaction): Promise<boolean> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => {
      // A failed add aborts the transaction. The abort handler distinguishes
      // an expected concurrent creator from a real storage failure.
    };
    transaction.onabort = () => {
      if (transaction.error?.name === "ConstraintError") {
        resolve(false);
        return;
      }
      reject(new RemoteProtocolError("The protected mobile identity store transaction was aborted."));
    };
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
