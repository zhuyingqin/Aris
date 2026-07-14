import { defineConfig, loadEnv } from "vite";

import { normalizeMobileBasePath } from "./src/basePath";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    // The desktop QR opens `/pair#p=...`. Vite prefixes its emitted assets
    // with this normalized path, so that deep links also work below a
    // reverse-proxy mount such as `/somniq/`.
    base: normalizeMobileBasePath(env.SOMNIQ_MOBILE_BASE_PATH),
    build: {
      target: "es2022",
    },
  };
});
