// Runs before the bundled workbench initializes its Workspace Trust service.
// Only the explicit trust model is mirrored; no workspace is trusted by default.
const channel = "somniq-workspace-trust/v1";
const key = "content.trust.model.key";
const host = new URLSearchParams(location.search).get("somniqTrustHost");
let sequence = 0;

function rpc(type, model) {
  if (!host || parent === window) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = `${Date.now()}-${++sequence}`;
    const receive = (event) => {
      if (event.source !== parent || event.origin !== host || event.data?.channel !== channel
          || event.data.type !== "reply" || event.data.id !== id) return;
      clearTimeout(timer);
      removeEventListener("message", receive);
      resolve(event.data);
    };
    const timer = setTimeout(() => { removeEventListener("message", receive); resolve(null); }, 1500);
    addEventListener("message", receive);
    parent.postMessage({ channel, type, id, model }, host);
  });
}

function currentAuthority(model) {
  const state = JSON.parse(model);
  for (const entry of state.uriTrustInfo || []) {
    const uri = entry.uri;
    // These are local server addresses for the same filesystem, not SSH hosts.
    if (uri?.scheme === "vscode-remote"
        && /^(?:127\.0\.0\.1|localhost|code\.[\w.-]+\.localhost):\d+$/.test(uri.authority || "")) {
      uri.authority = location.host;
    }
  }
  return JSON.stringify(state);
}

function trustDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("vscode-web-state-db-global-shared");
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("ItemTable")) request.result.createObjectStore("ItemTable");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

globalThis.somniqSaveWorkspaceTrust = (model) => rpc("save", model);
globalThis.somniqWorkspaceTrustReady = (async () => {
  if (!host || parent === window) return;
  const reply = await rpc("load");
  if (!reply) return;
  let db;
  try {
    db = await trustDatabase();
    if (typeof reply.model === "string") {
      // Commit before the workbench reads its application-shared trust model.
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("ItemTable", "readwrite");
        transaction.objectStore("ItemTable").put(currentAuthority(reply.model), key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } else {
      // Adopt an existing explicit choice on this origin, without inventing one.
      const existing = await new Promise((resolve, reject) => {
        const request = db.transaction("ItemTable", "readonly").objectStore("ItemTable").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (typeof existing === "string") await rpc("save", existing);
    }
  } catch (error) {
    console.warn("SomniQ could not restore Workspace Trust; using the editor's own storage.", error);
  } finally { db?.close(); }
})();
