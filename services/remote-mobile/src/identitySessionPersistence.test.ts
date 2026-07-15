import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexedDbIdentityStore, WebCryptoMobileIdentity } from "./crypto";
import { BrowserPairedSessionStore } from "./sessionStore";
import type { PairedMobileSession } from "./types";

const IDENTITY_DATABASE_NAME = "somniq-remote-mobile-v1";
const SESSION_DATABASE_NAME = "somniq-remote-mobile-session-v1";

beforeEach(async () => {
  vi.stubGlobal("isSecureContext", true);
  await Promise.all([
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
  });
});

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`IndexedDB ${name} is unexpectedly blocked`));
  });
}
