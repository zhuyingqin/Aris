# macOS desktop adaptation

Goal: run the existing SomniQ research desktop on Apple Silicon and Intel, with
correct bundled executable architectures, tools discoverable from Finder, and
native window behavior. Tectonic packaging is retired on every OS.

## Implemented behavior

- `tauri.macos.conf.json` selects app/DMG bundles and native window decorations.
  The minimum packaging target is macOS 12; the oldest supported OS still needs
  a physical-machine acceptance run. Windows retains its existing NSIS configuration.
- The main close button hides the Mac workspace, preserving background work.
  A Dock reopen restores it. Command-Q exits through the existing process cleanup.
  The companion uses a native titlebar too. Frontend Windows controls are hidden
  on Mac, and the chat sidebar shortcut is Command-Option-B.
- Finder startup preserves inherited executable choices and appends existing
  Homebrew, user tool, MacTeX and `/etc/paths.d` directories. Explicit Python
  environment selection is applied after bundled resource paths. Shell startup
  files are not executed automatically. Nonstandard environments can be selected
  in Settings; shell-only aliases are not executables.
- Environment diagnostics also expose Node, uv, Tesseract and pdftoppm. OCR uses
  the existing Tesseract/Poppler backend; these are user-installed dependencies,
  not silently installed packages.
- Existing project/config paths and their legacy migration are retained. This
  change does not move user data or relocate projects.
- The macOS bundle uses official standalone Node 22.22.0 binaries with pinned
  SHA-256 values. Universal builds combine both slices with lipo and verify
  them. They do not copy a Homebrew binary with external library dependencies.
- VSCodium 1.126.04524 is bundled for the requested platform, both darwin slices
  for Universal. Official SHA-256 values match the runtime downloader. Failed
  mirrors fall through to GitHub only after checksum validation; cached tar files
  are checked before reuse. The runtime uses its existing target-specific selector.
- Tectonic's download script, startup cache/export setup and latexmk/pdflatex
  impersonating launchers are removed. Prebuild removes stale compiler payloads.
  TeX Live/MacTeX remains the supported LaTeXCompile backend. An explicit external
  ARIS_TECTONIC/SOMNIQ_TECTONIC override remains available to agent shell commands.
- The New API refresh cookie remains in the macOS Keychain. It is loaded once per
  process and shared by the startup auth/account checks, so one launch does not
  issue duplicate Keychain reads. Development bundles are ad-hoc signed; their
  `cdhash` changes when the app is rebuilt, so Keychain approval can be requested
  again after replacing a debug bundle. A Developer ID signed build supplies the
  stable designated requirement needed for approval to survive updates.

## Development and release

```sh
cd desktop
npm ci
npm run tauri dev
```

For a Universal build, explicitly select the resource target as well as Rust:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
SOMNIQ_BUILD_TARGET=universal-apple-darwin npm run tauri build -- --target universal-apple-darwin --bundles app,dmg --ci
```

Release CI sets this variable. The existing updater manifest includes both CPU
architectures and must continue to point to the Universal archive.

The current release job remains unsigned with respect to Apple Developer ID.
Tauri updater signatures do not replace Apple signing/notarization. Before a
public signed release, provision Developer ID credentials, sign all distributed
Mach-O helpers (including executable resources inside runtime archives), enable
appropriate hardened runtime entitlements for Node, and notarize/staple the final
app/DMG. Do not advertise the current build as notarized or Gatekeeper-validated.

References: https://v2.tauri.app/distribute/sign/macos/ and
https://v2.tauri.app/plugin/updater/ .

## Acceptance still requiring real application runs

- Finder launch with a minimal PATH and no Homebrew Node dependency.
- Chat -> Executor -> independent Reviewer -> restart/session recovery.
- Code startup, embedded terminal, cancellation and subprocess cleanup.
- A configured Python/Jupyter environment with Chinese/space-containing paths.
- MacTeX compilation and PDF preview; scanned-page OCR with language packs.
- Chinese IME, Retina, fullscreen, drag-and-drop, Command-Q and Dock reopen.
- Sleep/wake scheduled-task recovery without duplicate execution.
- Installation and update on Intel, Apple Silicon and the minimum supported OS.

Passing unit tests or assembling Universal resources does not by itself certify
these end-to-end or signing scenarios.

## Verification on 2026-09-07

Passed on the local Apple Silicon host:

- macOS `cargo check`.
- 2 resource-script tests; 10 frontend platform/window/companion tests.
- TypeScript checking and Vite production build.
- 1 Finder PATH regression, 9 LaTeX-related regressions and 69 editor regressions.
- The real editor integration test with `ARIS_CODE_BUNDLED_RESOURCES`: offline
  install from bundled macOS resources, service readiness, branding, Chinese
  localization, and process shutdown (1 test passed).
- Universal Node resource generation and execution of both its arm64 and x86_64
  slices (the latter under Rosetta). Both VSCodium resource archives passed their
  pinned checksums. Missing mirror payloads correctly fell back to GitHub.
- Tauri debug app packaging. The local app executable is **arm64**, not Universal;
  its embedded resources contain both architectures. Bundle inspection found no
  Tectonic payload, and confirmed LSMinimumSystemVersion 12.0.

Full workspace regression was run with a temporary Jupyter kernelspec pointing
at an existing Python/ipykernel; the user's stale kernelspec was not modified.
Notebook integration passed. The overall suite is **not green**: five existing
`research_memory_v2` tests reject uncaptured inline turns, and the WebFetch large
PDF test aborts after its fixture server returns WouldBlock. The latter source
files already had user changes at session start and were left untouched.

Local development artifact:
`desktop/src-tauri/target/debug/bundle/macos/SomniQ Studio.app`.
It is not an Apple-notarized release or an Intel application build.
