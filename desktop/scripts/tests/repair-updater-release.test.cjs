const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const fixture = require("./fixtures/updater-signature.json");
const { verifySignature, validateInstaller } = require("../repair-updater-release.cjs");

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
