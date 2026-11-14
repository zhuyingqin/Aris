// Repair updater metadata without rebuilding or replacing a published installer.
// Signing stays in the official Tauri CLI; verification uses Node's Ed25519 API.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const repository = process.env.GITHUB_REPOSITORY || "zhuyingqin/Aris";
const directory = path.resolve(process.env.UPDATER_REPAIR_DIR || path.join(root, "updater-repair"));
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, data) => fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const api = (endpoint) => JSON.parse(gh("api", `repos/${repository}/${endpoint}`));

function decodeBase64(value) {
  assert.match(value, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "Invalid base64");
  return Buffer.from(value, "base64");
}

function verifySignature(payload, encodedKey, encodedSignature) {
  const keyLines = decodeBase64(encodedKey.trim()).toString("utf8").trim().split(/\r?\n/);
  assert.equal(keyLines.length, 2, "Invalid minisign public key");
  const key = decodeBase64(keyLines[1]);
  assert.equal(key.length, 42, "Invalid minisign public key size");
  assert.equal(key.subarray(0, 2).toString(), "Ed", "Unsupported public key algorithm");
  const lines = decodeBase64(encodedSignature.trim()).toString("utf8").trimEnd().split(/\r?\n/);
  assert.equal(lines.length, 4, "Invalid minisign signature");
  assert.ok(lines[0].startsWith("untrusted comment: "), "Missing signature comment");
  assert.ok(lines[2].startsWith("trusted comment: "), "Missing trusted comment");
  const signature = decodeBase64(lines[1]);
  assert.equal(signature.length, 74, "Invalid minisign signature size");
  assert.ok(signature.subarray(2, 10).equals(key.subarray(2, 10)), "Signature uses another key");
  const algorithm = signature.subarray(0, 2).toString();
  assert.ok(algorithm === "ED" || algorithm === "Ed", "Unsupported signature algorithm");
  const publicKey = crypto.createPublicKey({
    // RFC 8410 SubjectPublicKeyInfo for the 32-byte Ed25519 public key.
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const message = algorithm === "ED" ? crypto.createHash("blake2b512").update(payload).digest() : payload;
  assert.ok(crypto.verify(null, message, publicKey, signature.subarray(10)), "Installer signature verification failed");
  assert.ok(crypto.verify(null, Buffer.concat([
    signature.subarray(10), Buffer.from(lines[2].slice("trusted comment: ".length)),
  ]), publicKey, decodeBase64(lines[3])), "Trusted comment verification failed");
}

function validateInstaller(payload, { sha256, asset, manifest, commit, tag, version }) {
  assert.match(sha256, /^[a-f0-9]{64}$/, "An explicit installer SHA-256 is required");
  assert.equal(asset.state, "uploaded", "Installer upload is incomplete");
  assert.equal(asset.digest, `sha256:${sha256}`, "GitHub installer digest differs from the requested digest");
  assert.equal(digest(payload), sha256, "Installer bytes differ from the requested digest");
  assert.equal(payload.length, asset.size, "Installer size differs from GitHub");
  assert.equal(manifest.version, version, "Build manifest version differs");
  assert.equal(manifest.tag, tag, "Build manifest tag differs");
  assert.equal(manifest.commit, commit, "Build manifest is not from the tagged commit");
  assert.equal(manifest.installer.name, asset.name, "Build manifest names a different installer");
  assert.equal(manifest.installer.bytes, payload.length, "Build manifest size differs");
  assert.equal(manifest.installer.sha256, sha256, "Build manifest digest differs");
}

function updaterPubDate(buildManifest) {
  // Released clients compare pub_date with the timestamp embedded at build
  // time when versions are equal. Re-signing or publishing unchanged bytes
  // must not advance this timestamp and offer the same installer forever.
  assert.equal(typeof buildManifest.builtAt, "string", "Build manifest must include the original installer builtAt");
  assert.match(buildManifest.builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, "Invalid installer builtAt timestamp");
  const timestamp = Date.parse(buildManifest.builtAt);
  assert.ok(Number.isFinite(timestamp), "Invalid installer builtAt timestamp");
  return new Date(timestamp).toISOString();
}

function tagCommit(tag) {
  let object = api(`git/ref/tags/${encodeURIComponent(tag)}`).object;
  // Accept both lightweight and annotated tags, but require a commit target.
  for (let depth = 0; object.type === "tag" && depth < 5; depth++) {
    object = api(`git/tags/${object.sha}`).object;
  }
  assert.equal(object.type, "commit", "Release tag does not resolve to a commit");
  return object.sha;
}

function prepare() {
  const version = readJson(path.join(root, "desktop/package.json")).version;
  const tag = process.env.RELEASE_TAG;
  const sha256 = process.env.EXPECTED_INSTALLER_SHA256;
  assert.equal(tag, `v${version}`, "Requested tag differs from the checked-out desktop version");
  assert.match(sha256 || "", /^[a-f0-9]{64}$/, "An explicit installer SHA-256 is required");
  const release = api(`releases/tags/${encodeURIComponent(tag)}`);
  assert.ok(!release.draft && !release.prerelease && release.published_at, "Only an existing stable public release can be repaired");
  const installerName = `SomniQ.Studio_${version}_x64-setup.exe`;
  const asset = release.assets.find((item) => item.name === installerName);
  const buildAsset = release.assets.find((item) => item.name === "BUILD-MANIFEST.json");
  assert.ok(asset && buildAsset, "The existing installer and BUILD-MANIFEST.json are required");
  assert.equal(buildAsset.state, "uploaded");
  const commit = tagCommit(tag);
  const configFile = api(`contents/desktop/src-tauri/tauri.conf.json?ref=${commit}`);
  const config = JSON.parse(Buffer.from(configFile.content, "base64").toString("utf8"));
  assert.equal(config.version, version, "Tagged app version differs");
  const localConfig = readJson(path.join(root, "desktop/src-tauri/tauri.conf.json"));
  assert.equal(config.plugins.updater.pubkey, localConfig.plugins.updater.pubkey, "Tagged app uses another updater key");
  fs.mkdirSync(directory, { recursive: true });
  gh("release", "download", tag, "--repo", repository, "--pattern", installerName,
    "--pattern", "BUILD-MANIFEST.json", "--dir", directory, "--clobber");
  const buildPayload = fs.readFileSync(path.join(directory, "BUILD-MANIFEST.json"));
  assert.equal(buildAsset.digest, `sha256:${digest(buildPayload)}`, "Build manifest differs from GitHub");
  const payload = fs.readFileSync(path.join(directory, installerName));
  const buildManifest = JSON.parse(buildPayload);
  validateInstaller(payload, { sha256, asset, manifest: buildManifest, commit, tag, version });
  writeJson(path.join(directory, "repair-state.json"), {
    version, tag, commit, repository, installerName, sha256, asset,
    buildManifestSha256: digest(buildPayload),
    pubDate: updaterPubDate(buildManifest),
    releasePublishedAt: release.published_at,
    publicKey: config.plugins.updater.pubkey,
  });
  console.log(`Verified unchanged installer ${installerName}: ${sha256}`);
}

function verify() {
  const state = readJson(path.join(directory, "repair-state.json"));
  assert.equal(state.repository, repository);
  assert.equal(state.tag, process.env.RELEASE_TAG);
  assert.equal(state.sha256, process.env.EXPECTED_INSTALLER_SHA256);
  const payload = fs.readFileSync(path.join(directory, state.installerName));
  const buildPayload = fs.readFileSync(path.join(directory, "BUILD-MANIFEST.json"));
  assert.equal(digest(buildPayload), state.buildManifestSha256);
  const buildManifest = JSON.parse(buildPayload);
  validateInstaller(payload, { ...state, manifest: buildManifest });
  // Derive this again from verified build provenance; a cached repair-state
  // from an earlier signing run may still contain the later publication time.
  const pubDate = updaterPubDate(buildManifest);
  const signatureFile = `${state.installerName}.sig`;
  const signaturePayload = fs.readFileSync(path.join(directory, signatureFile));
  const signature = signaturePayload.toString("utf8").trim();
  verifySignature(payload, state.publicKey, signature);
  execFileSync(process.execPath, [path.join(__dirname, "generate-updater-json.cjs"),
    "--bundle-dir", directory, "--version", state.version, "--platform", "windows",
    "--pub-date", pubDate, "--asset-name", state.installerName,
  ], { stdio: "inherit", env: {
    ...process.env, GITHUB_REPOSITORY: repository, GITHUB_REF_NAME: state.tag,
    ARIS_UPDATE_BASE_URL: `https://github.com/${repository}/releases/download/${state.tag}`,
  } });
  const manifestPayload = fs.readFileSync(path.join(directory, "latest.json"));
  const manifest = JSON.parse(manifestPayload);
  assert.equal(manifest.version, state.version);
  assert.equal(manifest.pub_date, pubDate);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ["windows-x86_64", "windows-x86_64-msvc"]);
  for (const value of Object.values(manifest.platforms)) {
    assert.equal(value.signature, signature);
    assert.equal(value.url, `https://github.com/${repository}/releases/download/${state.tag}/${state.installerName}`);
  }
  const artifacts = {
    [signatureFile]: { bytes: signaturePayload.length, sha256: digest(signaturePayload) },
    "latest.json": { bytes: manifestPayload.length, sha256: digest(manifestPayload) },
  };
  writeJson(path.join(directory, "UPDATER-VERIFICATION.json"), {
    version: state.version, tag: state.tag, commit: state.commit,
    installer: { name: state.installerName, bytes: payload.length, sha256: state.sha256 },
    installerBuiltAt: pubDate,
    buildManifestSha256: state.buildManifestSha256,
    publicKeySha256: digest(Buffer.from(state.publicKey)),
    payloadSignatureVerified: true, trustedCommentSignatureVerified: true,
    platforms: Object.keys(manifest.platforms), artifacts,
    repairedAt: new Date().toISOString(),
    workflow: process.env.GITHUB_RUN_ID
      ? `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
  });
  return { state, artifacts };
}

function publish() {
  const { state, artifacts } = verify();
  assert.equal(tagCommit(state.tag), state.commit, "Release tag changed during repair");
  const release = api(`releases/tags/${encodeURIComponent(state.tag)}`);
  assert.ok(!release.draft && !release.prerelease, "Release visibility changed during repair");
  const asset = release.assets.find((item) => item.name === state.installerName);
  assert.equal(asset?.digest, `sha256:${state.sha256}`, "Published installer changed during repair");
  const verificationPayload = fs.readFileSync(path.join(directory, "UPDATER-VERIFICATION.json"));
  artifacts["UPDATER-VERIFICATION.json"] = { bytes: verificationPayload.length, sha256: digest(verificationPayload) };
  gh("release", "upload", state.tag, "--repo", repository, "--clobber",
    ...Object.keys(artifacts).map((name) => path.join(directory, name)));
  const published = api(`releases/tags/${encodeURIComponent(state.tag)}`);
  for (const [name, expected] of Object.entries(artifacts)) {
    const uploaded = published.assets.find((item) => item.name === name);
    assert.equal(uploaded?.state, "uploaded", `${name} was not uploaded`);
    assert.equal(uploaded?.digest, `sha256:${expected.sha256}`, `${name} upload digest differs`);
    assert.equal(uploaded?.size, expected.bytes, `${name} upload size differs`);
  }
  console.log(`Published verified updater metadata for ${state.tag}. Latest promotion and mirror synchronization remain separate.`);
}

module.exports = { verifySignature, validateInstaller, updaterPubDate };
if (require.main === module) {
  const command = process.argv[2];
  assert.ok(["prepare", "verify", "publish"].includes(command), "Use prepare, verify or publish");
  ({ prepare, verify, publish })[command]();
}
