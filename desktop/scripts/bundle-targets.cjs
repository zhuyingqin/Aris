/** Resolve resources from the requested Tauri target, never just the CI host. */
function bundleTargets(platform = process.platform, arch = process.arch,
  target = process.env.SOMNIQ_BUILD_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE || "") {
  const targets = {
    "universal-apple-darwin": ["darwin-arm64", "darwin-x64"],
    "aarch64-apple-darwin": ["darwin-arm64"],
    "x86_64-apple-darwin": ["darwin-x64"],
    "x86_64-pc-windows-msvc": ["win32-x64"],
    "x86_64-unknown-linux-gnu": ["linux-x64"],
    "aarch64-unknown-linux-gnu": ["linux-arm64"],
  };
  if (target) {
    if (!targets[target]) throw new Error(`Unsupported bundle target: ${target}`);
    if (!targets[target].every((slug) => slug.startsWith(`${platform}-`))) {
      throw new Error(`Build ${target} on a ${targets[target][0].split("-")[0]} host`);
    }
    return targets[target];
  }
  const slug = `${platform}-${arch}`;
  if (!Object.values(targets).some((slugs) => slugs.includes(slug))) {
    throw new Error(`Unsupported resource platform: ${slug}`);
  }
  return [slug];
}
module.exports = { bundleTargets };
