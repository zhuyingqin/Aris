import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import { BrowserPairedSessionStore } from "./sessionStore";
import type { PairedMobileSession } from "./types";

const DATABASE_NAME = "somniq-remote-mobile-session-v1";
const SESSION_AAD = new TextEncoder().encode("somniq-remote/mobile-session/v1\0");

const pairedSession: PairedMobileSession = {
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
  mobile: {
    device_id: "22222222-2222-4222-8222-222222222222",
    kind: "mobile",
    display_name: "Research phone",
    signing_public_key: "mobile-signing-key",
    key_agreement_public_key: "mobile-agreement-key",
  },
  credential: "mobile-credential-that-must-never-be-written-to-local-storage",
  granted_scopes: ["read_project_state", "read_task_timeline"],
  ice_servers: ["stun:stun.example.test:3478"],
};

beforeEach(async () => {
  await deleteDatabase();
});

describe("BrowserPairedSessionStore", () => {
  it("restores the encrypted pairing after the PWA is reopened", async () => {
    const store = new BrowserPairedSessionStore();

    await store.save(pairedSession);

    const reopenedStore = new BrowserPairedSessionStore();
    await expect(reopenedStore.load()).resolves.toEqual(pairedSession);
  });

  it("restores a pre-ICE encrypted pairing with an empty server list", async () => {
    const store = new BrowserPairedSessionStore();
    const { ice_servers: _iceServers, ...legacySession } = pairedSession;

    await store.save(legacySession as PairedMobileSession);

    await expect(store.load()).resolves.toEqual({ ...legacySession, ice_servers: [] });
  });

  it("migrates a legacy single-session ciphertext into a collection", async () => {
    await putLegacyEncryptedSession(pairedSession);

    await expect(new BrowserPairedSessionStore().loadCollection()).resolves.toEqual({
      version: 2,
      activeDesktopDeviceId: pairedSession.invitation.desktop.device_id,
      sessions: [pairedSession],
    });
  });

  it("keeps multiple desktop credentials and restores the active selection", async () => {
    const store = new BrowserPairedSessionStore();
    const second = pairedSessionForDesktop(
      "33333333-3333-4333-8333-333333333333",
      "Lab workstation",
      "second-mobile-credential-that-stays-independent",
      "55555555-5555-4555-8555-555555555555",
    );

    await store.saveSession(pairedSession);
    await store.saveSession(second);
    await store.select(pairedSession.invitation.desktop.device_id);

    const reopenedStore = new BrowserPairedSessionStore();
    await expect(reopenedStore.load()).resolves.toEqual(pairedSession);
    await expect(reopenedStore.loadCollection()).resolves.toMatchObject({
      activeDesktopDeviceId: pairedSession.invitation.desktop.device_id,
      sessions: [pairedSession, second],
    });
  });

  it("updates an existing desktop credential without adding a duplicate", async () => {
    const store = new BrowserPairedSessionStore();
    const refreshed = {
      ...pairedSession,
      credential: "replacement-mobile-credential-for-the-same-desktop",
    };

    await store.saveSession(pairedSession);
    const collection = await store.saveSession(refreshed);

    expect(collection.sessions).toEqual([refreshed]);
    await expect(store.load()).resolves.toEqual(refreshed);
  });

  it("selects a remaining desktop after the active pairing is removed", async () => {
    const store = new BrowserPairedSessionStore();
    const second = pairedSessionForDesktop(
      "44444444-4444-4444-8444-444444444444",
      "Travel laptop",
      "travel-laptop-credential-that-stays-independent",
      "66666666-6666-4666-8666-666666666666",
    );

    await store.saveSession(pairedSession);
    await store.saveSession(second);
    const collection = await store.remove(second.invitation.desktop.device_id);

    expect(collection.activeDesktopDeviceId).toBe(pairedSession.invitation.desktop.device_id);
    expect(collection.sessions).toEqual([pairedSession]);
    await expect(store.load()).resolves.toEqual(pairedSession);
  });

  it("rejects a partially committed pairing instead of treating it as a new app", async () => {
    const store = new BrowserPairedSessionStore();
    await expect(store.load()).resolves.toBeNull();
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    if ("privateKey" in key) {
      throw new Error("AES-GCM returned an invalid key");
    }
    await putSessionRecord("credential-key", key);

    await expect(new BrowserPairedSessionStore().load()).rejects.toThrow("incomplete");
  });
});

function pairedSessionForDesktop(
  deviceId: string,
  displayName: string,
  credential: string,
  mobileDeviceId: string,
): PairedMobileSession {
  return {
    ...pairedSession,
    invitation: {
      ...pairedSession.invitation,
      desktop: {
        ...pairedSession.invitation.desktop,
        device_id: deviceId,
        display_name: displayName,
        signing_public_key: `${deviceId}-signing-key`,
        key_agreement_public_key: `${deviceId}-agreement-key`,
      },
    },
    mobile: {
      ...pairedSession.mobile,
      device_id: mobileDeviceId,
      signing_public_key: `${mobileDeviceId}-signing-key`,
      key_agreement_public_key: `${mobileDeviceId}-agreement-key`,
    },
    credential,
  };
}

async function putLegacyEncryptedSession(session: PairedMobileSession): Promise<void> {
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  if ("privateKey" in key) {
    throw new Error("AES-GCM returned an invalid key");
  }
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: SESSION_AAD },
    key,
    new TextEncoder().encode(JSON.stringify(session)),
  );
  await putSessionRecords([
    ["credential-key", key],
    ["paired-session", { version: 1, nonce: nonce.buffer, ciphertext }],
  ]);
}

function putSessionRecord(key: IDBValidKey, value: unknown): Promise<void> {
  return putSessionRecords([[key, value]]);
}

function putSessionRecords(entries: Array<[IDBValidKey, unknown]>): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("secure-session")) {
        request.result.createObjectStore("secure-session");
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("secure-session", "readwrite");
      const store = transaction.objectStore("secure-session");
      for (const [key, value] of entries) {
        store.put(value, key);
      }
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error);
      };
    };
  });
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("test IndexedDB is unexpectedly blocked"));
  });
}
