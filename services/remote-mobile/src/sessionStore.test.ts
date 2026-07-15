import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import { BrowserPairedSessionStore } from "./sessionStore";
import type { PairedMobileSession } from "./types";

const DATABASE_NAME = "somniq-remote-mobile-session-v1";

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

function putSessionRecord(key: IDBValidKey, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("secure-session", "readwrite");
      transaction.objectStore("secure-session").put(value, key);
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
