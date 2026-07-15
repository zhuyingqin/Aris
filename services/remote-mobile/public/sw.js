const CACHE_PREFIX = "somniq-remote-shell-";
const CACHE_NAME = "somniq-remote-shell-v19";
const APP_SCOPE = new URL(self.registration.scope);
const APP_SHELL_ASSETS = [
  "",
  "index.html",
  "manifest.webmanifest",
  "icon.svg",
  "icon.png",
  "icon-192.png",
  "apple-touch-icon.png",
]
  .map((path) => new URL(path, APP_SCOPE).toString());
const IMMUTABLE_ASSETS_PATH = new URL("assets/", APP_SCOPE).pathname;

self.addEventListener("install", (event) => {
  // Refresh the small offline shell during every worker update. The server
  // explicitly marks these URLs as no-store, while the reload mode also avoids
  // accepting a stale browser-cache response during installation.
  event.waitUntil(precacheAppShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(APP_SCOPE.pathname) ||
    url.pathname.includes("/v1/")
  ) {
    return;
  }
  // Navigation must see an updated shell as soon as the phone is online. The
  // cached shell remains the offline fallback, while hashed assets can stay
  // cache-friendly without trapping users on an earlier mobile UI.
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  // Only Vite's content-hashed assets are cache-first. In particular, never
  // trap index.html, sw.js, or the manifest behind a previous app shell.
  if (url.pathname.startsWith(IMMUTABLE_ASSETS_PATH)) {
    event.respondWith(cacheFirstImmutableAsset(request));
  }
});

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(APP_SHELL_ASSETS.map(async (asset) => {
    const request = new Request(asset, { cache: "reload" });
    const response = await fetch(request);
    if (!response.ok || response.type !== "basic") {
      throw new Error(`Unable to cache mobile app shell: ${response.status}`);
    }
    await cache.put(request, response);
  }));
}

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request)) ?? caches.match(new URL("index.html", APP_SCOPE));
  }
}

async function cacheFirstImmutableAsset(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}
