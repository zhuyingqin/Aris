# Oracle Web integration

SomniQ's Oracle Web integration provides three narrowly scoped ChatGPT website capabilities without an OpenAI API key:

- explicit Chat consultation through Oracle's `consult` MCP tool;
- image generation through Oracle's `chatgpt_image` MCP tool;
- independent manuscript/work review through Oracle's `consult` MCP tool.

This is third-party webpage automation over the user's ChatGPT account. It is not an OpenAI API integration and must be labelled that way in the UI and audit log.

## Packaging decision

Chromium is never bundled for Oracle Web. SomniQ discovers an installed Microsoft Edge, Google Chrome, Brave, Chromium, or Vivaldi executable. A machine with no compatible browser must install one before it can create an Oracle Web account.

Oracle and its Node.js 24 runtime are also excluded from the main installer. On Windows, the user can explicitly install the optional runtime from Settings. SomniQ then:

1. downloads the current Node.js 24 archive from the official `nodejs.org/dist/latest-v24.x` release endpoint;
2. verifies it against the official `SHASUMS256.txt` entry;
3. installs the pinned `@steipete/oracle@0.18.0` npm package with development dependencies and install scripts disabled;
4. atomically activates it under the user configuration directory.

The optional component's network transfer depends on npm package compression. Its installed footprint is roughly 250 MB including Node.js 24 and Oracle's production dependency tree, but excluding the browser. Users who never enable Oracle Web pay no Oracle or Chromium package-size cost.

## State and credential boundary

Global metadata is stored under `~/.config/SomniQ/oracle-web` (or the configured SomniQ config root). Each account owns separate directories:

```text
oracle-web/accounts/<account-id>/browser-profile/
oracle-web/accounts/<account-id>/oracle-home/
```

`accounts.json` stores display names, browser executable paths, role bindings, and timestamps only. Passwords, cookies, and ChatGPT tokens are never copied into the JSON store. Chromium owns the login material inside the isolated profile.

Removing an account from SomniQ clears all of its role bindings and moves its isolated account directory under `oracle-web/archive/`. The profile is not permanently deleted, so an operator can recover it manually if removal was accidental.

SomniQ never attaches Oracle to the user's everyday browser profile and never copies its cookies. Login launches the selected, previously detected browser with the isolated `--user-data-dir`, but without remote debugging, WebDriver, headless, or other automation-control flags. The user enters credentials only in that normal browser window and closes it before a task. Oracle enables its own browser control only after it exclusively opens the same profile for a task.

## Capability boundary

Oracle MCP is not registered as a generic project MCP server. Generic registration would expose every Oracle tool and inherit the broad MCP permission class. Instead, SomniQ starts an ephemeral, account-scoped Oracle MCP worker and exposes only first-class host capabilities:

- `ChatGptWebImage` accepts a prompt and at most 20 files canonicalized inside the active project. Oracle output must originate under that account's `oracle-home/generated` directory. SomniQ copies validated image files into `.somniq/artifacts/oracle-images/<run-id>/` before returning paths to the agent.
- `ChatGptWebConsult` accepts a prompt and at most 20 project-local files. The Chat model cannot select an account or arbitrary URL; Settings owns the account binding, and the tool is registered afresh for the next Chat turn after a binding change.
- the independent Reviewer adapter sends the host-generated review prompt with no arbitrary account selection. The selected reviewer account is bound explicitly in Settings. The host triggers review after Executor completion, preserving the Executor -> independent Reviewer -> revision invariant.

All paths force `ORACLE_ENGINE=browser`, use an account-specific `ORACLE_HOME_DIR` and `ORACLE_BROWSER_PROFILE_DIR`, set `CHROME_PATH` to a detected executable, serialize browser jobs, and support cancellation while queued, during MCP discovery, and during the tool call. Chat consultation and image actions remain subject to SomniQ's elevated external-action approval policy.

## Failure behavior

- Missing Oracle runtime: account setup remains available, but automation tools are not exposed.
- Incompatible or unverifiable system Oracle runtime: report the detected version, keep webpage tools disabled, and offer the pinned SomniQ-managed Node + Oracle runtime without modifying the system installation. Executable presence alone never means ready.
- The Windows managed-runtime extractor supports Deflate entries used by the checksum-verified official Node.js ZIP while retaining enclosed-path validation. SomniQ pins Oracle MCP 0.18.0 on isolated Node 24 and never silently falls back to an incompatible system 0.9.0 runtime.
- Windows canonical paths are kept for local validation, then converted from the `\\?\` extended-length form before they are passed to Node.js as command-line arguments. Node 24 otherwise resolves an extended-path main-module argument as the drive root (for example `C:`) and exits before the MCP handshake.
- Missing browser: account creation is disabled until a compatible browser is detected.
- Open account browser during a task: the task fails with a request to close the isolated login window, preventing profile-lock races.
- Attachment outside the active project, symlink escape, output outside Oracle's generated directory, checksum mismatch, or malformed role binding: fail closed.
- Website/login/verification changes: report the Oracle error; never fall back silently to an API or to the user's daily browser profile.
