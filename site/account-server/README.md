# SomniQ independent account service

First implementation milestone: a standalone account service and a New API
compatibility prototype, with an opt-in Site account center. The default Site
build, PWA, Desktop login, remote gateway and production containers still use
their existing contracts. This service does not automatically migrate them.

Implemented:

- OIDC authorization code login with PKCE and validation through `openidconnect`.
- Persistent SomniQ UUIDs keyed by issuer and subject; email is not an identity key.
- HttpOnly server sessions, current-session logout, active-account checks, CSRF
  origin checks, expiring browser-bound one-time authorization flows.
- Explicit agreement acceptance with version, timestamp, content hash and exact
  server-side text snapshot. Onboarding does not grant compute access before consent.
- New API OIDC connection, identity comparison, a unique account mapping, and a
  per-user model key. Upstream sessions, refresh cookies and keys are encrypted
  with AES-256-GCM and bound to their record. The vault key is checked at startup.
- Serialized upstream refresh and key provisioning, account/usage projection,
  and streaming OpenAI chat proxy using the server-held model key.
- A separate `/account/` prototype page for testing the complete flow.
- A branded, responsive Site `/account.html` page behind `VITE_ACCOUNT_MODE=independent`.
  It uses the independent UUID/cookie contract and never loads legacy credentials.

The first milestone uses SQLite/WAL and one service process. It does not support
multiple replicas. The fixed 24-hour web session requires a fresh OIDC login
after expiry; device authorization and desktop background renewal are not yet
implemented. The production agreement must be supplied explicitly as a text
snapshot; development and integration-test agreements are only fixtures.

## Local Keycloak environment

Requirements: Rust, Node.js 22, and a running Docker Linux engine. From the repo root:

```powershell
node site/account-server/scripts/dev.mjs init
node site/account-server/scripts/dev.mjs up
# Wait for Keycloak and New API to start.
node site/account-server/scripts/dev.mjs configure-newapi
node site/account-server/scripts/dev.mjs serve
```

Open `http://127.0.0.1:8800/account/`. The seeded local user is `alice`; its
generated password is the `testPassword` field in the ignored
`site/account-server/.local/development.json`. No default published password is
used. The local identity administrator is `localadmin`, with its separate
password in the same file.

This stack publishes only loopback ports, uses Keycloak 26.7.4 and the exact
New API image digest in `deploy/newapi/version.lock.json`, and creates isolated
development databases. `dev.mjs configure-newapi` targets only the fixed local
test port 18881. It never configures the production server and installs no paid
model channels. Registration email delivery needs a configured development SMTP
service; the seeded account already has a verified test email.

`node site/account-server/scripts/dev.mjs down` stops the development containers
while keeping database volumes. Keep `.local/development.json` together with
those volumes: replacing its keys will not update credentials already imported
into an existing Keycloak realm. Do not publish the local stack as production.

### Site preview

After `init` and `up`, set the public origin before configuring New API and
starting the account service. Keep this terminal running:

```powershell
$env:SOMNIQ_ACCOUNT_PUBLIC_URL = 'http://127.0.0.1:5180'
node site/account-server/scripts/dev.mjs configure-newapi
node site/account-server/scripts/dev.mjs serve
```

In another terminal:

```powershell
cd site
$env:VITE_ACCOUNT_MODE = 'independent'
npm run dev
```

Open `http://127.0.0.1:5180/account.html`. The landing-page account buttons and
`dashboard.html` use the new center in this mode. The new profile is deliberately
separate from the numeric legacy user contract, so legacy remote-device and
subscription panels are not rendered in this preview. Its development proxy
does not fall back to production APIs. Leave the build flag unset for the current
Site behavior. Production/static previews additionally need the same-origin
routes shown in `deploy/nginx.preview.conf.example`; do not use the Vite server
as a production proxy.

## Configuration

The process reads environment variables; it does not implicitly load `.env` files.

| Variable | Meaning |
| --- | --- |
| `SOMNIQ_ACCOUNT_BIND` | Default `127.0.0.1:8800`; internal listener behind TLS in deployments |
| `SOMNIQ_ACCOUNT_PUBLIC_URL` | Exact public origin, HTTPS except for loopback development |
| `SOMNIQ_ACCOUNT_HOME_PATH` | `/account/` for standalone UI, or `/account.html` for the Site center; no arbitrary redirects |
| `SOMNIQ_OIDC_ISSUER` | Exact identity provider issuer; production requires HTTPS |
| `SOMNIQ_OIDC_CLIENT_ID`, `SOMNIQ_OIDC_CLIENT_SECRET` | SomniQ confidential OIDC client, callback `/v2/account/callback` |
| `SOMNIQ_NEWAPI_URL` | Trusted fixed New API service origin |
| `SOMNIQ_NEWAPI_OIDC_CLIENT_ID` | New API's distinct OIDC client in the same identity realm |
| `SOMNIQ_NEWAPI_INSTANCE_ID` | Stable identifier for that New API database/tenant |
| `SOMNIQ_ACCOUNT_DATABASE` | SQLite path; default `data/accounts.sqlite3` |
| `SOMNIQ_ACCOUNT_KEY` | Base64url without padding, encoding 32 random bytes; back up separately |
| `SOMNIQ_AGREEMENT_FILE` | UTF-8 snapshot displayed to the user and stored with acceptance |
| `SOMNIQ_AGREEMENT_VERSION` | Version identifying the supplied snapshot |

New API must use the same stable OIDC subject as the SomniQ client. Pairwise
subjects are not supported in this milestone. Its `ServerAddress` must match the
account origin, so the configured New API redirect URI is `/oauth/oidc`. Route
that callback to this service. Upstream OAuth state, cookies and tokens are never
forwarded to the browser. Keep the New API management and model ports private
when preparing a managed deployment.

If the upstream account has additional login factors, unsupported provider
policies, or an existing email requiring account linking, the connection fails
closed. It does not merge by email, bypass MFA, or rewrite an existing balance.
Old-account binding needs a separate migration implementation and acceptance run.

## API

| Route | Behavior |
| --- | --- |
| `GET /v2/account/login` | Start browser-bound OIDC + PKCE login |
| `GET /v2/account/callback` | Validate identity, create/reuse UUID, issue session cookie |
| `GET /v2/account/me` | Own user, consent requirement, compute connection state; works while New API is down |
| `POST /v2/account/logout` | Revoke current SomniQ session; requires exact Origin |
| `GET /v2/account/agreement` | Current version, text snapshot and content hash |
| `POST /v2/account/consent` | Explicit acceptance of that version and hash; session + Origin required |
| `POST /v2/account/compute/connect` | Start New API OIDC flow for the signed-in user |
| `GET /oauth/oidc` | Complete upstream connection; compare upstream `oidc_id` with the SomniQ subject |
| `GET /v2/account/compute` | Numeric compute quota and usage, explicitly in `newapi_quota` units |
| `GET /v1/models` | Models available to the mapped user's model key |
| `POST /v1/chat/completions` | Authenticated chat proxy with streaming and disconnect propagation |

The model routes currently accept the browser session, not an arbitrary bearer
token from a desktop or an OpenAI SDK. Requests are limited to 2 MiB and model
streams to five minutes. Responses do not expose upstream refresh cookies or
model keys. Current-session logout intentionally does not revoke another device.
Global session revocation, account administration, product entitlements and
payment integration remain later milestones.

## Verification

```powershell
cargo fmt --manifest-path site/account-server/Cargo.toml --check
cargo test --locked --manifest-path site/account-server/Cargo.toml
cargo clippy --locked --manifest-path site/account-server/Cargo.toml --all-targets -- -D warnings
cargo build --locked --manifest-path site/account-server/Cargo.toml
node --test deploy/newapi/check-updates.test.mjs
node site/account-server/scripts/live-compat.mjs
$env:NEWAPI_TEST_TAG = 'v1.0.0-rc.40'
node site/account-server/scripts/live-compat.mjs
```

The live harness downloads the official x64 Windows/Linux release, checks its
published SHA-256, starts it with a fresh local SQLite database, and runs the
real account/key/model endpoints. Its OIDC provider signs actual RSA ID tokens;
the identity provider and paid model channel are local fixtures. This verifies
the upstream adapter, **not** an actual Keycloak deployment or migration of an
existing production database. Each run leaves a safe `validation.json` plus
private local logs/databases in an ignored `.tmp-account-compat-*` directory.
Do not upload the raw logs, databases or test credentials as CI artifacts.

The real Keycloak + Site browser test requires the official Keycloak 26.7.4 ZIP
distribution extracted into an ignored local directory, a supported JDK on PATH,
and Site dependencies (`npm ci` in `site/` and `site/remote/`). Verify the ZIP's
published checksum before executing it. The GitHub workflow performs that check.

```powershell
$env:SOMNIQ_KEYCLOAK_HOME = (Resolve-Path '.codex/identity-tools/keycloak-26.7.4').Path
node site/account-server/scripts/live-compat.mjs
```

This mode copies a **clean distribution** into a disposable directory, imports
the same development realm, and verifies real browser login, explicit consent,
New API connection, streaming, logout/re-login, responsive layout and outage
isolation. Never point it at a production Keycloak installation or data directory.
Registration and recovery links are checked, but SMTP delivery, email verification
and password recovery are not covered by the seeded-user browser test.

## Upstream updates

`deploy/newapi/version.lock.json` records the inspected production baseline;
`candidate.json` records a proposed release without promoting it.

```powershell
node deploy/newapi/check-updates.mjs --write
```

The policy checks both GitHub release metadata and the version string. RC tags
remain RC even when GitHub sets `prerelease=false`. The current baseline is on
the explicitly selected RC channel; the stable channel never silently downgrades
an RC deployment to an older stable release.

`.github/workflows/newapi-compat.yml` tests the baseline and candidate, uploads
only validation reports, and can propose a draft PR after successful scheduled
or manual checks. Scheduled runs become active only when the workflow is on the
repository's default branch. Creating draft PRs also requires the repository
setting permitting Actions to create pull requests. There is no automatic
production deployment. Existing database migration and rollback review must
precede changing the production lock or service.

## Remaining rollout gates

1. Real Keycloak deployment, branded registration, email delivery and recovery.
2. Old-account binding, MFA/Passkey cases and a before/after ledger comparison.
3. Full Site dashboard/PWA migration, native desktop sessions and remote identity migration.
4. Product lifecycle and device revocation, abuse limits, operational backups and restore drill.
5. Production schema-migration rehearsal and an explicit reviewed cutover.

The existing remote gateway's independent local pairing approval remains part
of the product boundary; logging into this service does not authorize device control.
