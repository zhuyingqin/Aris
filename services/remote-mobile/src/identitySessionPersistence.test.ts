import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexedDbIdentityStore, WebCryptoMobileIdentity } from "./crypto";
import { bytesToBase64Url } from "./protocol";
import { BrowserPairedSessionStore } from "./sessionStore";
import type { PairedMobileSession } from "./types";

const LEGACY_IDENTITY_DATABASE_NAME = "somniq-remote-mobile-v1";
const IDENTITY_DATABASE_NAME = "somniq-remote-mobile-v2";
const SESSION_DATABASE_NAME = "somniq-remote-mobile-session-v1";
const IDENTITY_STORE_NAME = "identities";
const IDENTITY_RECORD_KEY = "current";
const IDENTITY_WRAPPING_KEY_RECORD_KEY = "current-wrapping-key";

interface PersistedIdentityProbe {
  version: number;
  signing: {
    wrappedPrivateKey: ArrayBuffer;
    privateKey?: unknown;
  };
  agreement: {
    wrappedPrivateKey: ArrayBuffer;
    privateKey?: unknown;
  };
}

beforeEach(async () => {
  vi.stubGlobal("isSecureContext", true);
  await Promise.all([
    deleteDatabase(LEGACY_IDENTITY_DATABASE_NAME),
    deleteDatabase(IDENTITY_DATABASE_NAME),
    deleteDatabase(SESSION_DATABASE_NAME),
  ]);
});

afterEach(() => vi.unstubAllGlobals());

describe("mobile identity and session persistence", () => {
  it("reopens the committed identity and encrypted pairing in a new app instance", async () => {
    const firstIdentity = await WebCryptoMobileIdentity.loadOrCreate(
      new IndexedDbIdentityStore(),
      "Research iPhone",
    );
    const session: PairedMobileSession = {
      invitation: {
        gateway_url: "https://remote.example.test",
        desktop: {
          device_id: "11111111-1111-4111-8111-111111111111",
          kind: "desktop",
          display_name: "Research workstation",
          signing_public_key: "desktop-signing-key",
          key_agreement_public_key: "desktop-agreement-key",
        },
      },
      mobile: firstIdentity.descriptor,
      credential: "mobile-credential-that-must-survive-a-browser-reopen",
      granted_scopes: ["read_project_state", "send_chat_messages"],
      ice_servers: ["stun:stun.example.test:3478"],
    };

    await new BrowserPairedSessionStore().save(session);

    const reopenedIdentity = await WebCryptoMobileIdentity.loadOrCreate(
      new IndexedDbIdentityStore(),
      "Research iPhone",
    );
    const reopenedSession = await new BrowserPairedSessionStore().load();

    expect(reopenedIdentity.descriptor).toEqual(firstIdentity.descriptor);
    expect(reopenedSession).toEqual(session);

    const signature = await reopenedIdentity.signPairingTranscript(new TextEncoder().encode("reopen-self-test"));
    expect(signature.byteLength).toBeGreaterThan(0);
    const peer = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    if (!("privateKey" in peer)) {
      throw new Error("X25519 self-test returned an invalid key pair");
    }
    const peerPublicKey = await crypto.subtle.exportKey("raw", peer.publicKey);
    const keyMaterial = await reopenedIdentity.deriveSessionKeyMaterial(
      bytesToBase64Url(new Uint8Array(peerPublicKey)),
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    );
    expect(keyMaterial.byteLength).toBe(32);

    const persisted = await readIdentityRecord();
    const wrappingKey = await readIdentityWrappingKey();
    expect(persisted.version).toBe(2);
    expect(wrappingKey.algorithm.name).toBe("AES-GCM");
    expect(wrappingKey.extractable).toBe(false);
    expect(wrappingKey.usages).toEqual(["wrapKey", "unwrapKey"]);
    expect(persisted.signing.wrappedPrivateKey).toBeInstanceOf(ArrayBuffer);
    expect(persisted.agreement.wrappedPrivateKey).toBeInstanceOf(ArrayBuffer);
    expect(persisted.signing.privateKey).toBeUndefined();
    expect(persisted.agreement.privateKey).toBeUndefined();
  });

  it("does not mint a replacement identity when committed storage is incomplete", async () => {
    const store = new IndexedDbIdentityStore();
    const original = await WebCryptoMobileIdentity.loadOrCreate(store, "Research iPhone");

    await deleteIdentityRecordOnly();

    await expect(WebCryptoMobileIdentity.loadOrCreate(
      new IndexedDbIdentityStore(),
      "Research iPhone",
    )).rejects.toThrow("cannot be restored");
    expect(original.descriptor.device_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("converges concurrent first-use creators on one committed identity", async () => {
    const [first, second] = await Promise.all([
      WebCryptoMobileIdentity.loadOrCreate(new IndexedDbIdentityStore(), "Research iPhone"),
      WebCryptoMobileIdentity.loadOrCreate(new IndexedDbIdentityStore(), "Research iPhone"),
    ]);

    expect(second.descriptor).toEqual(first.descriptor);
    await expect(WebCryptoMobileIdentity.load(new IndexedDbIdentityStore())).resolves.not.toBeNull();
  });

  it("keeps desktop-scoped identities independent when one pairing is removed", async () => {
    const firstStore = new IndexedDbIdentityStore("11111111-1111-4111-8111-111111111111");
    const secondStore = new IndexedDbIdentityStore("33333333-3333-4333-8333-333333333333");
    const first = await WebCryptoMobileIdentity.loadOrCreate(firstStore, "Research iPhone");
    const second = await WebCryptoMobileIdentity.loadOrCreate(secondStore, "Research iPhone");

    expect(second.descriptor.device_id).not.toBe(first.descriptor.device_id);

    await firstStore.clear();

    await expect(WebCryptoMobileIdentity.load(firstStore)).resolves.toBeNull();
    await expect(WebCryptoMobileIdentity.load(secondStore)).resolves.toMatchObject({
      descriptor: second.descriptor,
    });

    await new IndexedDbIdentityStore().clearAll();
    await expect(WebCryptoMobileIdentity.load(secondStore)).resolves.toBeNull();
  });
});

function readIdentityRecord(): Promise<PersistedIdentityProbe> {
  return withIdentityStore("readonly", (store) => requestResult<PersistedIdentityProbe>(store.get(IDENTITY_RECORD_KEY)));
}

function readIdentityWrappingKey(): Promise<CryptoKey> {
  return withIdentityStore("readonly", (store) => requestResult<CryptoKey>(store.get(IDENTITY_WRAPPING_KEY_RECORD_KEY)));
}

function deleteIdentityRecordOnly(): Promise<void> {
  return withIdentityStore("readwrite", async (store, transaction) => {
    store.delete(IDENTITY_RECORD_KEY);
    await transactionComplete(transaction);
  });
}

function withIdentityStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDENTITY_DATABASE_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(IDENTITY_STORE_NAME, mode);
      action(transaction.objectStore(IDENTITY_STORE_NAME), transaction)
        .then(resolve, reject)
        .finally(() => database.close());
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB ${name} is unexpectedly blocked`));
  });
}
