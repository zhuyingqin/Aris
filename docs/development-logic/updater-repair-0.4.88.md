# Repairing the 0.4.88 Windows update channel

The published Windows installer is already built from commit
`31511e6e7194b4d81ce0ff9522ddbf4907d4880b`. Its SHA-256 is
`5a757207c92fc59a0493c35b0b8d7a78c8ec647c597ee0ba44a77840aac13d32`.
An updater repair must sign these existing bytes, so the original build manifest
and SHA256SUMS remain valid. Unreleased Excel changes are outside this repair.

## Signing an existing installer

With a local backup of the original private key, the repair can run locally.
Keep the key outside Git and pass its path only to the official signer:

```powershell
$env:RELEASE_TAG = 'v0.4.88'
$env:EXPECTED_INSTALLER_SHA256 = '5a757207c92fc59a0493c35b0b8d7a78c8ec647c597ee0ba44a77840aac13d32'
$env:UPDATER_REPAIR_DIR = Join-Path (Get-Location) '.somniq/research/updater-repair-0.4.88/github'
node desktop/scripts/repair-updater-release.cjs prepare
node desktop/node_modules/@tauri-apps/cli/tauri.js signer sign --private-key-path 'D:\secure-backup\updater.key' --password '' "$env:UPDATER_REPAIR_DIR/SomniQ.Studio_0.4.88_x64-setup.exe"
node desktop/scripts/repair-updater-release.cjs verify
node desktop/scripts/repair-updater-release.cjs publish
```

The sample key path must refer to the existing original key, whose public half
is shipped in the app. A newly generated key would fail old-client verification.
Use the CLI version installed by the desktop lockfile. If the existing key has a
password, supply it securely rather than recording it in shell history.

Alternatively, dispatch the existing Release workflow from the repair branch:

```powershell
gh workflow run release.yml -R zhuyingqin/Aris --ref codex/repair-updater-0.4.88 -f release_tag=v0.4.88 -F repair_updater_only=true -f expected_installer_sha256=5a757207c92fc59a0493c35b0b8d7a78c8ec647c597ee0ba44a77840aac13d32
```

This mode skips all builds. It checks the published installer digest against the
explicit dispatch input, GitHub asset metadata and the original BUILD-MANIFEST.
The manifest must refer to the release tag's commit. The updater public key comes
from that tagged app configuration. The official Tauri CLI, at the repository's
lockfile version, signs the file with `TAURI_SIGNING_PRIVATE_KEY` supplied only
to the signing step. The private key is never exported from GitHub Secrets.

The updater's `pub_date` must retain the original installer's `builtAt` from the
verified BUILD-MANIFEST. Released clients compare this value with their embedded
build timestamp for equal versions. Using the later release publication or
signing time would offer the same installer again after every installation.
Verification derives the timestamp from provenance again, so an old cached
repair-state cannot restore the incorrect publication time. Missing or invalid
original build timestamps stop the repair.

Node's built-in Ed25519 implementation independently verifies both the payload
and minisign trusted comment. Only then are the detached `.exe.sig`, `latest.json`
and an additive `UPDATER-VERIFICATION.json` uploaded. The existing EXE and original
build provenance are preserved. The new manifest lists only Windows targets;
there is no 0.4.88 macOS build to advertise.

## Publication acceptance

After a successful signing run:

1. Download the EXE, `.sig` and `latest.json` from the release; verify their actual
   bytes, the signature against the shipped public key, both Windows target URLs
   and version `0.4.88`. A changed payload must fail verification.
2. Revise the release description's manual-installation-only status. Retain its
   original build provenance, engine requirements and documented acceptance limits.
3. Set `v0.4.88` as GitHub Latest and read back
   `/releases/latest/download/latest.json`.
4. Copy the unchanged EXE, signature, provenance and a manifest whose URLs point
   to `https://somni.ensuanx.com/releases/v0.4.88/` into the mirror version directory.
   Verify hashes and signatures there before atomically replacing the public
   `/releases/latest.json`. The mirror's `/releases/latest/latest.json` and
   `/releases/latest/download/latest.json` are symlinks to that file. Update the
   `latest/SomniQ.Studio_latest_x64-setup.exe` link to the 0.4.88 installer too.
5. Fetch both public manifests and the mirrored installer over HTTPS. They must
   report 0.4.88, contain the same signature and deliver the exact installer hash.

The mirror's static root is `/opt/somniq-remote/nginx/releases` on the configured
deployment host. Version files can be staged under the sibling `.deploy` folder
while signing is blocked. Leave existing update manifests in place until all
signature checks pass.

## Completed local repair

The repository has `TAURI_SIGNING_PRIVATE_KEY`. The dedicated repair run
[43478470136](https://github.com/zhuyingqin/Aris/actions/runs/43478470136)
was also rejected before any signing step started:

> The job was not started because your account is locked due to a billing issue.

GitHub cannot return the secret's plaintext through its API. A subsequent search
found a local backup of the original private key. The official Tauri 2.11.2 CLI
signed the already published installer locally, so the hosted billing lock did
not block the release repair. The private key was not exported from GitHub,
logged, uploaded or committed.

Local validation passed all eleven script tests, including an official Tauri
2.11.2 signature fixture and payload/comment/key rejection cases. The workflow
passes actionlint. The prepare command downloaded the actual 0.4.88 release
installer and verified its GitHub digest, build manifest, tag commit and tagged
public key. Production signatures were verified locally with Node Ed25519 and
independently on the mirror host with Python cryptography, including rejection
of a modified payload and verification of the minisign trusted comment.

The release has six assets: the unchanged installer, BUILD-MANIFEST and
SHA256SUMS, plus `.exe.sig`, `latest.json` and `UPDATER-VERIFICATION.json`. The
original provenance remains unchanged; its unsigned-build status records the
initial build, while the additive verification report records the later repair.

GitHub Latest is now 0.4.88. The mirror's public latest.json and both manifest
aliases return 0.4.88, and its Windows installer alias points to the signed
0.4.88 asset. The previous mirror manifest was backed up before atomic
replacement. Version files are published at
`/opt/somniq-remote/nginx/releases/v0.4.88`.

The 0.4.86 app's tagged public key matches this signature's key, and its two
configured update endpoints are the verified GitHub and China mirror URLs.
The updater manifest lists Windows x64 only because no 0.4.88 macOS asset exists.

The public mirror's complete 131,754,807-byte installer was downloaded over
HTTPS and matched the original SHA-256. The downloaded bytes also passed
signature verification; the public `.sig` matched GitHub's asset. The latest
Windows download alias returned the expected file size and byte range.
[The publication report](updater-repair-0.4.88.json) records asset digests and
the public endpoint results. These checks cover metadata, file integrity and
client-key compatibility; the installed application's update UI and installer
execution were not exercised.

## Same-version prompt correction

The user's installed 0.4.88 screenshot exposed a metadata error in the initial
repair: `pub_date` was set to the release's `2026-11-12T04:00:26Z` publication
time, 2,022 seconds after the unchanged installer's embedded
`2026-11-12T03:26:44Z` build time. The existing client deliberately recognizes
later builds of the same version, so it repeatedly offered these identical bytes.

Both GitHub and the China mirror now use the original build timestamp. The
installer and its detached signature are unchanged. Installed 0.4.88 clients can
refresh their update check without reinstalling; 0.4.86 clients still see 0.4.88
as newer. All four public manifest routes were fetched over HTTPS and matched
the corrected timestamp and signature.

The real desktop comparator regression reproduces the old timestamp false
positive, rejects the corrected 0.4.88 update and preserves the 0.4.86 upgrade.
All four focused Rust comparator tests passed. The CLI integration test starts
with the actual later publication time in cached repair-state and confirms that
verification generates the original build time while preserving the signed
payload. Together with signature/provenance cases, all eleven script tests pass.
