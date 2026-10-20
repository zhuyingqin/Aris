# Desktop account session recovery

The account gateway uses a short-lived access token and a rotating refresh
cookie. Access-token expiry does not end the account's sign-in. The desktop
renews the access token before its locally known expiry, and retries an account
operation once if the gateway rejects it earlier. This applies to account
bootstrap, model discovery, pricing, usage logs and model-key recovery.

Refresh operations acquire one process-wide lock before loading the saved
session. A request that waited for another renewal uses the newest cookie or
the access token that renewal already produced. Sign-in persistence and logout
use the same lock. An expired server timestamp stays expired rather than being
replaced with the 14-minute fallback used for missing timestamps.

Once the gateway rotates a refresh cookie, the newest value is retained in
memory even if the OS credential store temporarily refuses a write. Later
authenticated reads retry persistence at most once per minute. Credentials stay
in backend memory and the OS store; no credential is sent through the webview,
written to config.json or exported through process environment variables. If
the app exits before a failed write can be retried successfully, the next
launch may still need a fresh sign-in.

Model-key rejection is handled separately. Model discovery retries once with
the same credential-recovery mechanism used by chat. A model connection failure
does not invalidate account sign-in. The frontend logs out only for the
backend's canonical `Login expired. Please sign in again.` response. A gateway
rejection of the refresh credential still clears the account; legacy gateways
without refresh credentials retain their existing expiry behavior.

Regression tests in `desktop/src-tauri/src/tests/newapi_session.rs` cover
successive renewals, server-side access expiry during bootstrap and usage
reads, concurrent rejection, waiting for a rotated cookie, temporary credential
store failure and recovery, model-key rotation, revoked refresh sessions,
legacy sessions and server unavailability. All credential-store operations use
an isolated backend in unit tests. Frontend tests verify that temporary token
and model errors preserve sign-in while confirmed login expiry signs out.

Validation on 2026-10-20: the complete Desktop Rust library suite passed
(968 passed, 15 intentionally skipped); the focused frontend suite passed
(49 tests). TypeScript checking, the frontend production build and the Windows
release build also passed. The installed app is updated separately from these
workspace build artifacts.
