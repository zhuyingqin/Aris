const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const fixture = require("./fixtures/updater-signature.json");
const { verifySignature, validateInstaller, updaterPubDate } = require("../repair-updater-release.cjs");

test("accepts a fixture signed by the official Tauri CLI", () => {
  verifySignature(Buffer.from(fixture.payloadUtf8), fixture.publicKey, fixture.signature);
});

test("rejects a modified installer even with the original signature", () => {
  const payload = Buffer.from(fixture.payloadUtf8);
  payload[0] ^= 1;
  assert.throws(() => verifySignature(payload, fixture.publicKey, fixture.signature), /Installer signature verification failed/);
});

test("rejects a modified minisign trusted comment", () => {
  const lines = Buffer.from(fixture.signature, "base64").toString().split("\n");
  lines[2] += " modified";
  const signature = Buffer.from(lines.join("\n")).toString("base64");
  assert.throws(() => verifySignature(Buffer.from(fixture.payloadUtf8), fixture.publicKey, signature), /Trusted comment verification failed/);
});

test("rejects a signature from another updater key", () => {
  const lines = Buffer.from(fixture.publicKey, "base64").toString().trim().split("\n");
  const key = Buffer.from(lines[1], "base64");
  key[2] ^= 1;
  lines[1] = key.toString("base64");
  const publicKey = Buffer.from(lines.join("\n")).toString("base64");
  assert.throws(() => verifySignature(Buffer.from(fixture.payloadUtf8), publicKey, fixture.signature), /Signature uses another key/);
});

function provenance() {
  const payload = Buffer.from(fixture.payloadUtf8);
  const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
  const commit = "31511e6e7194b4d81ce0ff9522ddbf4907d4880b";
  const name = "SomniQ.Studio_0.4.88_x64-setup.exe";
  return {
    payload,
    expected: {
      sha256, commit, tag: "v0.4.88", version: "0.4.88",
      asset: { name, size: payload.length, state: "uploaded", digest: `sha256:${sha256}` },
      manifest: {
        version: "0.4.88", tag: "v0.4.88", commit,
        builtAt: "2026-11-12T03:26:44Z",
        installer: { name, bytes: payload.length, sha256 },
      },
    },
  };
}

test("requires the dispatch digest, downloaded bytes and build provenance to agree", () => {
  const { payload, expected } = provenance();
  validateInstaller(payload, expected);
  expected.sha256 = "0".repeat(64);
  assert.throws(() => validateInstaller(payload, expected), /GitHub installer digest differs/);
});

test("rejects downloaded bytes changed after publication", () => {
  const { payload, expected } = provenance();
  payload[0] ^= 1;
  assert.throws(() => validateInstaller(payload, expected), /Installer bytes differ/);
});

test("rejects a build manifest from another commit", () => {
  const { payload, expected } = provenance();
  expected.manifest.commit = "0".repeat(40);
  assert.throws(() => validateInstaller(payload, expected), /not from the tagged commit/);
});

test("requires an explicit valid original build timestamp for updater repair", () => {
  for (const builtAt of [undefined, null, 1794454004, "", "not-a-date", "2026-11-12"]) {
    assert.throws(() => updaterPubDate({ builtAt }), /builtAt/);
  }
  assert.equal(updaterPubDate({ builtAt: "2026-11-12T03:26:44+00:00" }), "2026-11-12T03:26:44.000Z");
});

test("verify preserves the installer's build time even with a cached later release date", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "somniq-updater-repair-test-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { payload, expected } = provenance();
  const buildPayload = Buffer.from(JSON.stringify(expected.manifest));
  const installerName = expected.asset.name;
  const repository = "zhuyingqin/Aris";
  fs.writeFileSync(path.join(directory, installerName), payload);
  fs.writeFileSync(path.join(directory, `${installerName}.sig`), `${fixture.signature}\n`);
  fs.writeFileSync(path.join(directory, "BUILD-MANIFEST.json"), buildPayload);
  fs.writeFileSync(path.join(directory, "repair-state.json"), JSON.stringify({
    ...expected, repository, installerName,
    buildManifestSha256: crypto.createHash("sha256").update(buildPayload).digest("hex"),
    publicKey: fixture.publicKey,
    // This is the actual later publication time that triggered the 0.4.88 loop.
    pubDate: "2026-11-12T04:00:26Z",
  }));
  execFileSync(process.execPath, [path.resolve(__dirname, "../repair-updater-release.cjs"), "verify"], {
    env: {
      ...process.env,
      GITHUB_REPOSITORY: repository,
      RELEASE_TAG: expected.tag,
      EXPECTED_INSTALLER_SHA256: expected.sha256,
      UPDATER_REPAIR_DIR: directory,
    },
    stdio: "pipe",
  });
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "latest.json"), "utf8"));
  assert.equal(manifest.version, "0.4.88");
  assert.equal(manifest.pub_date, "2026-11-12T03:26:44.000Z");
  for (const platform of Object.values(manifest.platforms)) {
    assert.equal(platform.signature, fixture.signature);
    assert.equal(platform.url, `https://github.com/${repository}/releases/download/v0.4.88/${installerName}`);
  }
  assert.deepEqual(fs.readFileSync(path.join(directory, installerName)), payload);
  const verification = JSON.parse(fs.readFileSync(path.join(directory, "UPDATER-VERIFICATION.json"), "utf8"));
  assert.equal(verification.installerBuiltAt, manifest.pub_date);
  assert.equal(verification.payloadSignatureVerified, true);
});
