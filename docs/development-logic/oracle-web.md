# Oracle Web integration

SomniQ's Oracle Web integration provides three narrowly scoped ChatGPT website capabilities without an OpenAI API key:

- explicit Chat consultation through Oracle's `consult` MCP tool;
- image generation through Oracle's `chatgpt_image` MCP tool;
- independent manuscript/work review through Oracle's `consult` MCP tool.

This is third-party webpage automation over the user's ChatGPT account. It is not an OpenAI API integration and must be labelled that way in the UI and audit log.

## Packaging decision

Chromium is never bundled for Oracle Web. SomniQ discovers an installed Microsoft Edge, Google Chrome, Brave, Chromium, or Vivaldi executable. A machine with no compatible browser must install one before it can create an Oracle Web account.

Oracle and its Node.js 24 runtime are also excluded from the main installer. On Windows, the user can explicitly install the optional runtime from Extensions -> MCP -> Oracle Web. SomniQ then:

1. downloads the current Node.js 24 archive from the official `nodejs.org/dist/latest-v24.x` release endpoint;
2. verifies it against the official `SHASUMS256.txt` entry;
3. installs the pinned `@steipete/oracle@0.18.0` npm package with development dependencies and install scripts disabled;
4. atomically activates it under the user configuration directory.

The MCP detail action is state-aware: a missing runtime is offered as **Install**, while a detected incompatible runtime is offered as **Update**. Updates install the Oracle version pinned to the current SomniQ release and preserve account profiles and role bindings because those live outside `runtime/current`. SomniQ does not silently follow the newest upstream Oracle release; compatibility moves with a reviewed SomniQ release. Runtime installation and replacement are serialized with webpage jobs so an active MCP worker is never updated in place.

The optional component's network transfer depends on npm package compression. Its installed footprint is roughly 250 MB including Node.js 24 and Oracle's production dependency tree, but excluding the browser. Users who never enable Oracle Web pay no Oracle or Chromium package-size cost.

## State and credential boundary

Global metadata is stored under `~/.config/SomniQ/oracle-web` (or the configured SomniQ config root). Every account owns an Oracle home; isolated accounts also own a private browser profile:

```text
oracle-web/accounts/<account-id>/browser-profile/
oracle-web/accounts/<account-id>/oracle-home/
```

`accounts.json` stores display names, browser executable paths, role bindings, the timestamp of the first successful webpage-task sign-in verification, and an optional default model label only. Passwords, cookies, ChatGPT account identity, and tokens are never copied into the JSON store. Chromium owns the login material inside the account's dedicated browser user.

Removing an account from SomniQ clears all of its role bindings and moves its local account directory under `oracle-web/archive/`. An isolated profile is not permanently deleted, so an operator can recover it manually if removal was accidental.

Every account uses one dedicated, persistent **browser user**. Login launches the selected, previously detected browser with an account-local `--user-data-dir`, but without remote debugging, WebDriver, headless, or other automation-control flags. The user chooses the intended ChatGPT account once in that normal browser window and closes it. The first successful Oracle webpage task then automatically marks that account as signed in; this is a real capability check, rather than a user assertion. It does not read cookies or account identity. Later Chat calls reuse the same browser user. Settings also stores an optional account default model (`gpt-5.6-sol`, `gpt-5.6`, `gpt-5.5-pro`, or `gpt-5.5`); an explicit per-call model overrides it. SomniQ intentionally does not attach to a daily Chrome profile: Chrome 136+ no longer supports the old default-profile debugging path safely, and a managed profile has a smaller, durable permission boundary.

Chat consultation also preserves browser-conversation continuity inside one SomniQ Chat session. After a successful consultation, SomniQ stores only the local Oracle session identifier keyed to that SomniQ session. A later consultation resolves the prior Oracle metadata, validates its ChatGPT conversation identifier, and supplies a fixed `https://chatgpt.com/c/<id>` resume URL to the account-local worker. It never accepts a URL from the Chat model or reads browser credentials. A tool call can opt out to start a fresh webpage conversation, and can supply at most six planned browser follow-up prompts for Oracle to submit in sequence within the same ChatGPT conversation.

SomniQ rewrites a deterministic account-local Oracle browser policy before every task and starts the worker in that account directory, so a project `.oracle/config.json` cannot redirect or change the browser control mode. It clears inherited Oracle remote-host, remote-token, inline-cookie, and cookie-file variables. Before it starts Oracle, SomniQ also checks whether that browser user is still open and fails immediately with a close-the-window instruction rather than waiting for Oracle's browser timeout.

## Capability boundary

Oracle MCP is not registered as a generic project MCP server. Generic registration would expose every Oracle tool and inherit the broad MCP permission class. Instead, SomniQ starts an ephemeral, account-scoped Oracle MCP worker and exposes only first-class host capabilities:

- `ChatGptWebImage` accepts a prompt and at most 20 files canonicalized inside the active project. Oracle output must originate under that account's `oracle-home/generated` directory. SomniQ copies validated image files into `.somniq/artifacts/oracle-images/<run-id>/` before returning paths to the agent.
- `ChatGptWebConsult` accepts a prompt and at most 20 project-local files. The Chat model cannot select an account or arbitrary URL; Settings owns the account binding, and the tool is registered afresh for the next Chat turn after a binding change. Chat receives an explicit runtime instruction to use this tool when the user asks to use the configured ChatGPT/Oracle webpage account; ordinary Chat responses never trigger it by themselves.
- the independent Reviewer adapter sends the host-generated review prompt with no arbitrary account selection. The selected reviewer account is bound explicitly in Settings. The host triggers review after Executor completion, preserving the Executor -> independent Reviewer -> revision invariant.

All paths force `ORACLE_ENGINE=browser`, use an account-specific `ORACLE_HOME_DIR`, `ORACLE_BROWSER_PROFILE_DIR`, and detected `CHROME_PATH`, serialize browser jobs, and support cancellation while queued, during MCP discovery, and during the tool call. Chat consultation and image actions remain subject to SomniQ's elevated external-action approval policy.

## Failure behavior

- Missing Oracle runtime: account setup remains available, but automation tools are not exposed.
- Incompatible or unverifiable system Oracle runtime: report the detected version, keep webpage tools disabled, and offer the pinned SomniQ-managed Node + Oracle runtime without modifying the system installation. Executable presence alone never means ready.
- The Windows managed-runtime extractor supports Deflate entries used by the checksum-verified official Node.js ZIP while retaining enclosed-path validation. SomniQ pins Oracle MCP 0.18.0 on isolated Node 24 and never silently falls back to an incompatible system 0.9.0 runtime.
- Windows canonical paths are kept for local validation, then converted from the `\\?\` extended-length form before they are passed to Node.js as command-line arguments. Node 24 otherwise resolves an extended-path main-module argument as the drive root (for example `C:`) and exits before the MCP handshake.
- Missing browser: account creation is disabled until a compatible browser is detected.
- Uninitialized account profile: fail before starting the Oracle worker and direct the user to open the dedicated sign-in window. A successful webpage task verifies the sign-in automatically; an unsuccessful one reports Oracle's login error without recording a verified state.
- An account browser user is open: fail immediately with a request to close the sign-in window, preventing profile-lock races; never attach to a daily Chrome profile, copy cookies, or fall back to a remote host.
- Attachment outside the active project, symlink escape, output outside Oracle's generated directory, checksum mismatch, or malformed role binding: fail closed.
- Website/login/verification changes: report the Oracle error; never fall back silently to an API, another browser profile, or a remote browser host.
