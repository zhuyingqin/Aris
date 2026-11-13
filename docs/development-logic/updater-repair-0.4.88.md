# Repairing the 0.4.88 Windows update channel

The published Windows installer is already built from commit
`31511e6e7194b4d81ce0ff9522ddbf4907d4880b`. Its SHA-256 is
`5a757207c92fc59a0493c35b0b8d7a78c8ec647c597ee0ba44a77840aac13d32`.
An updater repair must sign these existing bytes, so the original build manifest
and SHA256SUMS remain valid. Unreleased Excel changes are outside this repair.

## Signing an existing installer

Dispatch the existing Release workflow from the repair branch:

```powershell
gh workflow run release.yml -R zhuyingqin/Aris --ref codex/repair-updater-0.4.88 -f release_tag=v0.4.88 -F repair_updater_only=true -f expected_installer_sha256=5a757207c92fc59a0493c35b0b8d7a78c8ec647c597ee0ba44a77840aac13d32
```

This mode skips all builds. It checks the published installer digest against the
explicit dispatch input, GitHub asset metadata and the original BUILD-MANIFEST.
The manifest must refer to the release tag's commit. The updater public key comes
from that tagged app configuration. The official Tauri CLI, at the repository's
lockfile version, signs the file with `TAURI_SIGNING_PRIVATE_KEY` supplied only
to the signing step. The private key is never exported from GitHub Secrets.

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

## Current external blocker

The repository has `TAURI_SIGNING_PRIVATE_KEY`. The dedicated repair run
[43478470136](https://github.com/zhuyingqin/Aris/actions/runs/43478470136)
was also rejected before any signing step started:

> The job was not started because your account is locked due to a billing issue.

GitHub cannot return the secret's plaintext through its API. The account billing
restriction must be removed before a hosted runner can use this key. A GitHub
membership subscription is not itself required for this repair.

Local validation passed all nine script tests, including an official Tauri
2.11.2 signature fixture and payload/comment/key rejection cases. The workflow
passes actionlint. The prepare command downloaded the actual 0.4.88 release
installer and verified its GitHub digest, build manifest, tag commit and tagged
public key. Production signing and update-channel acceptance remain pending.
