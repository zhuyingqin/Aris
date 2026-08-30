import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const REMOTE_PUBLIC_DIR = fileURLToPath(new URL("./remote/public", import.meta.url));

const REMOTE_PUBLIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

/**
 * `remote/` is a nested Vite root with its own `public/` directory. This dev
 * server only knows about `site/public`, so the PWA's icons, manifest and
 * service worker would 404 when the dashboard embeds it from `/remote/` — and
 * an SPA-fallback HTML body in place of `sw.js` fails registration outright.
 * The production tree has no such gap: `build:remote` emits `public/` into
 * `dist/remote/` alongside the hashed assets.
 */
function remotePublicAssets(): Plugin {
  return {
    name: "somniq-remote-public-assets",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split(/[?#]/)[0];
        if (!pathname.startsWith("/remote/")) return next();

        let relative: string;
        try {
          relative = decodeURIComponent(pathname.slice("/remote/".length));
        } catch {
          return next();
        }
        if (!relative) return next();

        const file = path.resolve(REMOTE_PUBLIC_DIR, relative);
        if (!file.startsWith(REMOTE_PUBLIC_DIR + path.sep)) return next();
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next();

        res.setHeader(
          "Content-Type",
          REMOTE_PUBLIC_CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        );
        // The service worker treats the shell as network-first; dev must never
        // hand it a stale copy of a file it is about to cache.
        res.setHeader("Cache-Control", "no-store");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

// Standalone marketing site. It shares no code with `desktop/` on purpose: the
// landing page must build and deploy without a Rust toolchain or Tauri runtime.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  // Every API call in the dashboard and the PWA is same-origin (`./v1/...`),
  // because in production Caddy fronts the remote gateway, the account backend
  // and the static tree under one host. Nothing sends CORS headers, so a
  // browser on 127.0.0.1 cannot reach them directly — without this proxy the
  // dev server answers `/v1/*` with its SPA fallback HTML and every caller
  // fails on the first `response.json()`.
  //
  // The default upstream is the same gateway the desktop registers with
  // (`MANAGED_REMOTE_GATEWAY_URL` in desktop/src-tauri/src/remote.rs), so the
  // account clients listed here are the real ones. Point it at a local
  // `site/server` run when working on the gateway itself.
  const apiUpstream = env.SOMNIQ_DEV_API_UPSTREAM || "https://somni.chat";

  return {
    plugins: [react(), remotePublicAssets()],
    // Relative base so the built bundle works from a subpath (GitHub Pages) as
    // well as from a domain root.
    base: "./",
    cacheDir: "../.vite-cache/site",
    server: {
      host: "127.0.0.1",
      port: 5180,
      strictPort: true,
      proxy: {
        // `ws` also covers /v1/signal, /v1/relay and the two /v1/browser-*
        // sockets the PWA upgrades to after claiming a ticket.
        "^/(v1|healthz)(/|$)": {
          target: apiUpstream,
          changeOrigin: true,
          ws: true,
        },
        // Session renewal keeps new-api's own path because the HttpOnly
        // refresh cookie is scoped to it. Deliberately narrow: everything
        // else under /api belongs to the account backend's admin surface.
        "^/api/user/auth/(refresh|logout)$": {
          target: apiUpstream,
          changeOrigin: true,
        },
      },
    },
    build: {
      target: "es2020",
      outDir: "dist",
      rollupOptions: {
        input: {
          main: "index.html",
          pricing: "pricing.html",
          dashboard: "dashboard.html",
          network: "network.html",
        },
      },
    },
  };
});
