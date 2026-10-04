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
3. installs the pinned `@steipete/oracle@0.21.4` npm package with development dependencies and install scripts disabled;
4. atomically activates it under the user configuration directory.

The MCP detail action is state-aware: a missing runtime is offered as **Install**, while both ready and incompatible runtimes offer **Update**. Update checks against the Oracle version pinned to the current SomniQ release, reports when that version is already installed, and preserves account profiles and role bindings because those live outside `runtime/current`. SomniQ does not silently follow the newest upstream Oracle release; compatibility moves with a reviewed SomniQ release. Runtime installation and replacement are serialized with webpage jobs so an active MCP worker is never updated in place. The staged package version is verified before activation. The previous runtime is preserved under `runtime/previous-<id>` and restored if activation fails.

The optional component's network transfer depends on npm package compression. Its installed footprint is roughly 250 MB including Node.js 24 and Oracle's production dependency tree, but excluding the browser. Users who never enable Oracle Web pay no Oracle or Chromium package-size cost.

Settings has a dedicated **Update** category for application and Oracle runtime updates. Its Oracle section reuses the same runtime action as Extensions -> MCP -> Oracle Web, without displaying account setup. Opening the page does not install anything; application installation and restart remain explicit actions. Update-page state stays mounted when changing settings categories, preserving download progress.

## State and credential boundary

Global metadata is stored under `~/.config/SomniQ/oracle-web` (or the configured SomniQ config root). Every account owns an Oracle home; isolated accounts also own a private browser profile:

```text
oracle-web/accounts/<account-id>/browser-profile/
oracle-web/accounts/<account-id>/oracle-home/
```

`accounts.json` stores display names, browser executable paths, role bindings, the timestamp of the first successful webpage-task sign-in verification, and an optional default model label only. Passwords, cookies, ChatGPT account identity, and tokens are never copied into the JSON store. Chromium owns the login material inside the account's dedicated browser user.

Removing an account from SomniQ clears all of its role bindings and moves its local account directory under `oracle-web/archive/`. An isolated profile is not permanently deleted, so an operator can recover it manually if removal was accidental.

Every account uses one dedicated, persistent **browser user**. Login launches the selected, previously detected browser with an account-local `--user-data-dir`, but without remote debugging, WebDriver, headless, or other automation-control flags. The user chooses the intended ChatGPT account once in that normal browser window and closes it. The first successful Oracle webpage task then automatically marks that account as signed in; this is a real capability check, rather than a user assertion. It does not read cookies or account identity. Later Chat calls reuse the same browser user. Settings also stores an optional account default model (`gpt-5.6-sol`, `gpt-5.6`, `gpt-5.5-pro`, or `gpt-5.5`); an explicit per-call model overrides it. SomniQ intentionally does not attach to a daily Chrome profile: Chrome 136+ no longer supports the old default-profile debugging path safely, and a managed profile has a smaller, durable permission boundary.

Chat consultation also preserves browser-conversation continuity inside one SomniQ Chat session. After a successful consultation, SomniQ stores only the local Oracle session identifier keyed to that SomniQ session. A later consultation invokes Oracle's supported browser `--followup <sessionId>` flow, which appends the prompt to the original ChatGPT conversation rather than reopening a URL as a new task. It never accepts a URL from the Chat model or reads browser credentials. A tool call can opt out to start a fresh webpage conversation, and can supply at most six planned browser follow-up prompts for Oracle to submit in sequence within the same ChatGPT conversation.

SomniQ rewrites a deterministic account-local Oracle browser policy before every task and starts the worker in that account directory, so a project `.oracle/config.json` cannot redirect or change the browser control mode. It clears inherited Oracle remote-host, remote-token, inline-cookie, and cookie-file variables. Before it starts Oracle, SomniQ also checks whether that browser user is still open and fails immediately with a close-the-window instruction rather than waiting for Oracle's browser timeout.

## Capability boundary

Image tasks keep the assigned account's current webpage model by default. Only an explicit image-task `model` requests strict model selection; the saved account default remains in force for consultation and independent review. This keeps image generation from depending on a text-consultation model picker. Settings labels that saved preference as the consultation/review model. Oracle 0.21.4 is a reviewed stable target, not a moving `latest` dependency; its [release](https://github.com/steipete/oracle/releases/tag/v0.21.4) adds ChatGPT Chat/Work composer and model-control compatibility, intact multiline pastes, and attachment hydration fixes. Later ChatGPT layout changes can still require a subsequent compatibility update.

Oracle MCP is not registered as a generic project MCP server. Generic registration would expose every Oracle tool and inherit the broad MCP permission class. Instead, SomniQ starts an ephemeral, account-scoped Oracle MCP worker and exposes only first-class host capabilities:

- `ChatGptWebImage` accepts a prompt and at most 20 files canonicalized inside the active project. Oracle output must originate under that account's `oracle-home/generated` directory. SomniQ copies validated image files into `.somniq/artifacts/oracle-images/<run-id>/` before returning paths to the agent.
- `ChatGptWebConsult` accepts a prompt and at most 20 project-local files. The Chat model cannot select an account or arbitrary URL; Settings owns the account binding, and the tool is registered afresh for the next Chat turn after a binding change. Chat receives an explicit runtime instruction to use this tool when the user asks to use the configured ChatGPT/Oracle webpage account; ordinary Chat responses never trigger it by themselves.
- the independent Reviewer adapter sends the host-generated review prompt with no arbitrary account selection. The selected reviewer account is bound explicitly in Settings. The host triggers review after Executor completion, preserving the Executor -> independent Reviewer -> revision invariant.

All paths force `ORACLE_ENGINE=browser`, use an account-specific `ORACLE_HOME_DIR`, `ORACLE_BROWSER_PROFILE_DIR`, and detected `CHROME_PATH`, serialize browser jobs, and support cancellation while queued, during MCP discovery, and during the tool call. Chat consultation and image actions remain subject to SomniQ's elevated external-action approval policy.

## Failure behavior

- Missing Oracle runtime: account setup remains available, but automation tools are not exposed.
- Incompatible or unverifiable system Oracle runtime: report the detected version, keep webpage tools disabled, and offer the pinned SomniQ-managed Node + Oracle runtime without modifying the system installation. Executable presence alone never means ready.
- The Windows managed-runtime extractor supports Deflate entries used by the checksum-verified official Node.js ZIP while retaining enclosed-path validation. SomniQ pins Oracle MCP 0.21.4 on isolated Node 24 and never silently falls back to an incompatible system or old managed runtime.
- Windows canonical paths are kept for local validation, then converted from the `\\?\` extended-length form before they are passed to Node.js as command-line arguments. Node 24 otherwise resolves an extended-path main-module argument as the drive root (for example `C:`) and exits before the MCP handshake.
- Missing browser: account creation is disabled until a compatible browser is detected.
- Uninitialized account profile: fail before starting the Oracle worker and direct the user to open the dedicated sign-in window. A successful webpage task verifies the sign-in automatically; an unsuccessful one reports Oracle's login error without recording a verified state.
- An account browser user is open: fail immediately with a request to close the sign-in window, preventing profile-lock races; never attach to a daily Chrome profile, copy cookies, or fall back to a remote host. Oracle workers opt into shared runtime process-tree ownership. On Windows, a Job Object owns the worker and every browser descendant, so completion, failure, timeout, cancellation, or dropping a worker releases its automated browser even after the worker has exited. Other MCP servers retain their existing lifecycle behavior. Browser follow-ups use the same owned async process guard and support cancellation during execution.
- ChatGPT human verification (for example Cloudflare): report the verification error and direct the user to that account's ordinary sign-in window in Settings. Complete verification manually there, close the window, and retry. An automated verification window is not kept behind as an unowned process; repeated retries or deleting profile data do not resolve the human verification requirement.
- Before launching an idle account profile, archive `chrome-err.log` and `chrome-out.log` under its Oracle home (`browser-launch-logs/<run-id>/`). The pinned Chrome launcher appends these logs and discovers a dynamic DevTools port from the first matching stderr line; retaining an earlier launch's line can connect to a dead port and leave a detached browser behind. Busy profiles are rejected before any log is moved, and sign-in data is preserved. Recovery hints identify account-specific browser processes when a failed task leaves no visible window.
- Attachment outside the active project, symlink escape, output outside Oracle's generated directory, checksum mismatch, or malformed role binding: fail closed.
- Website/login/verification changes: report the Oracle error; never fall back silently to an API, another browser profile, or a remote browser host.
