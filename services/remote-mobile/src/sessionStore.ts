import { RemoteProtocolError } from "./protocol";
import type { PairedMobileSession } from "./types";

const DATABASE_NAME = "somniq-remote-mobile-session-v1";
const DATABASE_VERSION = 1;
const STORE_NAME = "secure-session";
const KEY_RECORD = "credential-key";
const SESSION_RECORD = "paired-session";
const SESSION_AAD = new TextEncoder().encode("somniq-remote/mobile-session/v1\0");

interface StoredEncryptedSession {
  version: 1;
  nonce: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

/**
 * Persists a paired mobile credential encrypted with a non-extractable AES-GCM
 * CryptoKey held by IndexedDB. This is suitable for the browser PWA boundary;
 * a production native wrapper should replace it with Android Keystore/iOS
 * Keychain storage while preserving the same no-localStorage rule.
 */
export class BrowserPairedSessionStore {
  async load(): Promise<PairedMobileSession | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const [key, encrypted] = await Promise.all([
        requestResult<CryptoKey | undefined>(store.get(KEY_RECORD)),
        requestResult<StoredEncryptedSession | undefined>(store.get(SESSION_RECORD)),
        transactionComplete(transaction),
      ]);
      if (!key || !encrypted) {
        return null;
      }
      if (encrypted.version !== 1 || !(encrypted.nonce instanceof ArrayBuffer) || !(encrypted.ciphertext instanceof ArrayBuffer)) {
        throw new RemoteProtocolError("The saved mobile pairing is invalid. Revoke it from the desktop and pair again.");
      }
      try {
        const plaintext = await requireCrypto().subtle.decrypt(
          { name: "AES-GCM", iv: encrypted.nonce, additionalData: toArrayBuffer(SESSION_AAD) },
          key,
          encrypted.ciphertext,
        );
        return parsePairedSession(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      } catch (error) {
        if (error instanceof RemoteProtocolError) {
          throw error;
        }
        throw new RemoteProtocolError("The saved mobile pairing cannot be opened. Revoke it from the desktop and pair again.");
      }
    } finally {
      database.close();
    }
  }

  async save(session: PairedMobileSession): Promise<void> {
    // Validate before encrypting so a malformed peer response cannot become
    // durable state even though the browser credential is encrypted at rest.
    parsePairedSession(JSON.stringify(session));
    const database = await openDatabase();
    try {
      // IndexedDB transactions become inactive once awaited work yields back
      // to the event loop. Read the non-extractable key and perform WebCrypto
      // encryption before opening the short write transaction, then enqueue
      // every write synchronously and wait only for its completion.
      const key = (await readStorageKey(database)) ?? (await createStorageKey());
      const nonce = new Uint8Array(12);
      requireCrypto().getRandomValues(nonce);
      const plaintext = new TextEncoder().encode(JSON.stringify(session));
      const ciphertext = await requireCrypto().subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(SESSION_AAD) },
        key,
        toArrayBuffer(plaintext),
      );
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      // Always rewrite the key alongside the encrypted record. If two tabs
      // race during their first save, the final transaction leaves a matched
      // key/ciphertext pair rather than a key from one tab and data from
      // another.
      store.put(key, KEY_RECORD);
      store.put(
        {
          version: 1,
          nonce: toArrayBuffer(nonce),
          ciphertext,
        } satisfies StoredEncryptedSession,
        SESSION_RECORD,
      );
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }

  async clear(): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      store.delete(KEY_RECORD);
      store.delete(SESSION_RECORD);
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }
}

async function readStorageKey(database: IDBDatabase): Promise<CryptoKey | undefined> {
  const transaction = database.transaction(STORE_NAME, "readonly");
  const key = transaction.objectStore(STORE_NAME).get(KEY_RECORD);
  const [storedKey] = await Promise.all([
    requestResult<CryptoKey | undefined>(key),
    transactionComplete(transaction),
  ]);
  return storedKey;
}

function parsePairedSession(raw: string): PairedMobileSession {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RemoteProtocolError("The saved mobile pairing is invalid.");
  }
  if (!isRecord(value) || !isRecord(value.invitation) || !isRecord(value.mobile)) {
    throw new RemoteProtocolError("The saved mobile pairing is invalid.");
  }
  const invitation = value.invitation;
  const desktop = invitation.desktop;
  const mobile = value.mobile;
  // P2 sessions written before server-provisioned ICE existed remain valid:
  // they simply use host candidates and the encrypted relay fallback.
  const iceServers = value.ice_servers === undefined ? [] : value.ice_servers;
  if (!isDescriptor(desktop, "desktop") || !isDescriptor(mobile, "mobile") || typeof invitation.gateway_url !== "string" || invitation.gateway_url.length === 0 || typeof value.credential !== "string" || value.credential.length < 32 || !Array.isArray(value.granted_scopes) || !value.granted_scopes.every(isScope) || !isIceServerList(iceServers)) {
    throw new RemoteProtocolError("The saved mobile pairing is invalid.");
  }
  return {
    invitation: { gateway_url: invitation.gateway_url, desktop },
    mobile,
    credential: value.credential,
    granted_scopes: [...value.granted_scopes],
    ice_servers: iceServers.map((server) => server.trim()),
  };
}

function isDescriptor(value: unknown, expectedKind: "desktop" | "mobile"): value is PairedMobileSession["mobile"] {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.device_id === "string" &&
    value.kind === expectedKind &&
    typeof value.display_name === "string" &&
    typeof value.signing_public_key === "string" &&
    typeof value.key_agreement_public_key === "string"
  );
}

function isScope(value: unknown): value is PairedMobileSession["granted_scopes"][number] {
  return ["read_project_state", "read_task_timeline", "send_chat_messages", "stop_runs", "read_review_conclusions"].includes(value as string);
}

function isIceServerList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 8
    && value.every((server) => typeof server === "string" && /^stuns?:[^/?#@\s]+$/i.test(server.trim()) && server.trim().length <= 256);
}

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    return Promise.reject(new RemoteProtocolError("This browser does not provide protected IndexedDB storage."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new RemoteProtocolError("Unable to open protected mobile session storage."));
    request.onblocked = () => reject(new RemoteProtocolError("Protected mobile session storage is locked by another tab."));
  });
}

async function createStorageKey(): Promise<CryptoKey> {
  try {
    const key = await requireCrypto().subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    // AES-GCM can only generate a single CryptoKey; test by the structural
    // key-pair discriminator instead of `instanceof CryptoKey`, which is not
    // available as a global in every WebCrypto-capable test/runtime.
    if ("privateKey" in key || "publicKey" in key) {
      throw new RemoteProtocolError("The browser returned an invalid protected session key.");
    }
    return key;
  } catch (error) {
    if (error instanceof RemoteProtocolError) {
      throw error;
    }
    throw new RemoteProtocolError("This browser cannot create protected mobile credential storage.");
  }
}

function requireCrypto(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new RemoteProtocolError("This browser does not support the Web Crypto API required for protected storage.");
  }
  return globalThis.crypto;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new RemoteProtocolError("A protected mobile session storage request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new RemoteProtocolError("A protected mobile session storage update failed."));
    transaction.onabort = () => reject(new RemoteProtocolError("A protected mobile session storage update was aborted."));
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
