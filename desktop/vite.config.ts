import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port and quiet logging.
export default defineConfig({
  plugins: [react()],
  base: "./",
  cacheDir: "../.vite-cache/desktop",
  clearScreen: false,
  resolve: {
    // Dedupe CodeMirror too: multiple @codemirror/state or @codemirror/view
    // instances break decoration identity checks ("Block decorations may not be
    // specified via plugins"), which surfaced as flaky Typeset test crashes.
    dedupe: [
      "react",
      "react-dom",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@lezer/common",
      "@lezer/highlight",
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "esnext",
    outDir: "dist",
  },
});
